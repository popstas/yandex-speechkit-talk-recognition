const fs = require('fs');
const config = require('./config');
const ffmpeg = require('ffmpeg');
const AWS = require('aws-sdk');
const axios = require('axios');
const FormData = require('form-data');
const colors = require('colors');

axios.interceptors.request.use(request => {
  request.maxContentLength = Infinity;
  request.maxBodyLength = Infinity;
  return request;
});

const audioType = config.audioType || 'ogg'; // ogg|pcm|mp3
if (config.filters === undefined) config.filters = true;

const opsPath = `${config.dataPath}/ops`;

const audioSavePath = `${config.dataPath}/converted`;
let aws;
let inited = false;

// upload file, return operation id
async function fileToRecognize({
  filePath,
  filename = '',
  postProcessing = true,
  language = 'ru',
  punctuation = true,
  provider = '',
  prompt = '',
}) {
  let resRec;
  try {
    if (provider === 'yandex') {
      resRec = await fileToRecognizeYandex({
        filePath,
        filename,
        postProcessing,
        language,
        punctuation,
      });
      /*log({
        id: resRec.opId,
        status: 'converted',
        date: new Date().toUTCString(),
      });*/

      if (resRec && resRec.error) {
        return {error: resRec.error};
      }

      const delay = 10;
      const interval = setInterval(async () => {
        const done = await checkAndSave(resRec.opId, resRec.uploadedUri);
        if (done) {
          /*log({
            id: resRec.opId,
            status: 'done',
            date: new Date().toUTCString(),
          });*/
          clearInterval(interval);
        }
      }, delay * 1000);
    }

    if (provider === 'whisper') {
      if (!prompt) prompt = 'Предложение, со знаками.';
      resRec = await fileToRecognizeWhisper({
        filePath,
        filename,
        postProcessing,
        language,
        prompt,
      });
      /*log({
        id: resRec.opId,
        status: 'converted',
        date: new Date().toUTCString(),
      });*/

      if (resRec && resRec.error) {
        return {error: resRec.error};
      }

      /*const delay = 10;
      const interval = setInterval(async () => {
        const done = await actions.checkAndSave(resRec.opId, resRec.uploadedUri);
        if (done) {
          log({
            id: resRec.opId,
            status: 'done',
            date: new Date().toUTCString(),
          });
          clearInterval(interval);
        }
      }, delay * 1000);*/
    }
  } catch (e) {
    console.log('error while fileToRecognize', e.message);
    console.log(e);
    return {error: e.message};
  }

  return resRec;
}

// upload file, return operation id
async function fileToRecognizeYandex({
  filePath,
  filename = '',
  postProcessing = true,
  language = 'ru',
  punctuation = true,
}) {
  // convert to ogg/pcm
  console.log(colors.yellow(`1/4 Convert to ${audioType} ` + (postProcessing ? 'with' : 'without') + ' post processing...'));
  const res = await processAudio(filePath, audioType, postProcessing);
  if (!res) return;

  if (res.error) {
    return { error: res.error };
  }

  const mp3Path = await convertToMp3(res.path);
  if (!mp3Path) {
    return { error: 'Failed to convert to mp3' };
  }

  // upload to Yandex
  console.log(colors.yellow('2/4 Upload to Yandex Object Storage...'));
  const recognitionUri = await uploadToYandexStorage(res.path);
  const mp3Uri = await uploadToYandexStorage(mp3Path);
  if (!recognitionUri) {
    return { error: 'Failed to upload to Yandex' };
  }

  // send to STT
  console.log(colors.yellow('3/4 Send to SpeechKit...'));
  const opId = await sendAudioYandex({audioUri: recognitionUri, language, punctuation});
  if (opId.error) {
    return { error: opId.error };
  }
  console.log('Uploaded, id: ' + opId);

  if (!fs.existsSync(opsPath)) fs.mkdirSync(opsPath, { recursive: true }); // create dir

  const opPath = `${opsPath}/${opId}.json`;

  fs.writeFileSync(opPath, JSON.stringify({
    id: opId,
    uploadedUri: recognitionUri,
    mp3Uri: mp3Uri,
    updated: Date.now(),
    done: false,
    chunks: [],
    filename: filename,
  }));

  return {uploadedUri: recognitionUri, opId};
}

async function detectAudioFileLanguage(mp3Path) {
  const formData = new FormData();
  formData.append('audio_file', fs.createReadStream(mp3Path));
  const detect = await axios.post(
      config.whisperBaseUrl + '/detect-language',
      formData,
      { headers: formData.getHeaders() }
  );
  return detect;
}

async function denoiseFile(filePath) {
  const formData = new FormData();
  formData.append('audio_file', fs.createReadStream(filePath));
  try {
    const res = await axios.post(
        config.denoiseServiceUrl,
        formData,
        { headers: formData.getHeaders(), responseType: 'stream', }
    );
    return res;
  } catch (e) {
    console.log("error denoise", e.message);
    return false;
  }
}


async function sendAudioWhisper({mp3Path, language, prompt = ''}) {
  try {

    // detect-language
    const detect = await detectAudioFileLanguage(mp3Path);
    // console.log("detect.data:", detect.data);

    // asr
    // console.log('send to whisper...')
    const formData2 = new FormData();
    formData2.append('audio_file', fs.createReadStream(mp3Path));
    formData2.append('task', 'transcribe');
    // formData2.append('initial_prompt', prompt); // doesn't work from form, only from GET params
    // formData2.append('output', 'json');
    // formData2.append('word_timestamps ', 'true');
    formData2.append('language', detect.data.detected_language);

    // console.log("formData2:", formData2);
    const res = await axios.post(
        config.whisperBaseUrl + '/asr?output=json&word_timestamps=true&initial_prompt=' + encodeURIComponent(prompt),
        formData2,
        { headers: formData2.getHeaders() }
    );
    // console.log("res:", res);
    return res.data;
  }
  catch(e) {
    console.log(colors.yellow('Error: ' + e.message));
    console.log(e);
    return {error: e.message};
  }
}

// uri for public serve converted files
function getUriByPath(path) {
  if (!path.startsWith(audioSavePath)) return false;
  return `${process.env.ORIGIN_URL}/converted/${path.replace(`${audioSavePath}/`, '')}`;
}

async function fileToRecognizeWhisper({
  filePath,
  filename = '',
  postProcessing = true,
  language = 'ru',
  prompt = '',
}) {
  // const mp3Type = 'mp3';
  // convert to ogg/pcm
  console.log(colors.yellow(`1/3 Convert to ${audioType} ` + (postProcessing ? 'with' : 'without') + ' post processing...'));

  const res = await processAudio(filePath, audioType, postProcessing);
  if (!res) return;
  if (res.error) {
    return { error: res.error };
  }
  // const uploadedUri = await uploadToYandexStorage(res.path);
  const uploadedUri = getUriByPath(res.path);
  // console.log("uploadedUri:", uploadedUri);

  console.log("Convert to mp3...");
  const mp3Path = await convertToMp3(res.path);
  if (!mp3Path) {
    return { error: 'Failed to convert to mp3, possible empty file.' };
  }
  console.log(`Saved to ${mp3Path}`);

  // console.log(colors.yellow('2/4 Upload to Yandex...'));
  // const mp3Uri = await uploadToYandexStorage(mp3Path);
  const mp3Uri = getUriByPath(mp3Path);

  const opId = buildIdByFilePath(mp3Path);
  if (!fs.existsSync(opsPath)) fs.mkdirSync(opsPath, { recursive: true }); // create dir
  const opPath = `${opsPath}/${opId}.json`;

  let chunks = [];
  let done = false;

  // upload to Whisper
  console.log(colors.yellow(`2/3 Recognize with Whisper, language: ${language}, prompt: ${prompt}...`));
  sendAudioWhisper({mp3Path, language, prompt}).then(whRes => {
    done = true;
    console.log(colors.yellow('3/3 Save recognized text...'));
    console.log("whRes:", whRes);
    if (whRes.error) {
      fs.writeFileSync(opPath, JSON.stringify({
        id: `${opId}`,
        updated: Date.now(),
        done,
        uploadedUri,
        mp3Uri,
        chunks,
        filename,
        prompt,
        error: whRes.error,
      }));
      return {uploadedUri, opId};
    }
    // TODO: segments without word splitting
    const data = {}
    chunks = whRes.segments.map(s => {
      if (Array.isArray(s)) {
        // faster-whisper
        const [start, end, text] = s;
        data.start = start;
        data.end = end;
        data.text = text;
      }
      else {
        // gpu-faster-whisper
        const {start, end, text} = s;
        data.start = start;
        data.end = end;
        data.text = text;
      }

      return {
        channelTag: '1',
        alternatives: [
          {
            words: [
              {
                startTime: `${data.start}s`,
              }
            ],
            text: data.text,
          }
        ]
      };
    });

    fs.writeFileSync(opPath, JSON.stringify({
      id: `${opId}`,
      updated: Date.now(),
      done,
      uploadedUri,
      mp3Uri,
      chunks,
      filename,
      prompt,
    }));
  });



  fs.writeFileSync(opPath, JSON.stringify({
    id: `${opId}`,
    updated: Date.now(),
    done,
    uploadedUri,
    mp3Uri,
    chunks,
    filename,
    prompt,
  }));

  return {uploadedUri, opId};
}

// return id based on file modified time
function buildIdByFilePath(mp3Path) {
  return `${Math.floor(fs.statSync(mp3Path).mtimeMs)}${genHash()}`;
}

function genHash(length = 16) {
  const hex = Math.floor(Math.random() * 16777215).toString(16);
  const hash = "0".repeat(length - hex.length) + hex;
  return hash;
}

function s3Init() {
  aws = new AWS.S3({
    endpoint: 'https://storage.yandexcloud.net', 
    accessKeyId: config.storageUploadId,
    secretAccessKey: config.storageUploadSecret,
    region: 'ru-central1',
    httpOptions: {
      timeout: 30000,
      connectTimeout: 30000
    },
  });
}

async function processAudio(filePath, audioType, postProcessing = true) {
  if (!['ogg', 'pcm', 'mp3'].includes(audioType)) {
    throw new Error('Only ogg and pcm types supported, and mp3 for Whisper');
  }

  // console.log('filePath: ', filePath);
  if (!fs.existsSync(audioSavePath)) fs.mkdirSync(audioSavePath, { recursive: true }); // create dir

  await fs.statSync(filePath);

  // denoise remote
  if (postProcessing && config.denoiseServiceUrl) {
    try {
      // convert to wav
      // TODO: тут часто напрасно конвертируется в wav,
      // например, не проверяется живость сервиса шумоподавления

      const wavPath = `${audioSavePath}/${Date.now()}_${genHash()}.wav`;
      console.log(`Convert to wav... save to ${wavPath}`);

      const audioFileWav = await new ffmpeg(filePath);
      audioFileWav.addCommand('-acodec', 'pcm_s16le');
      audioFileWav.addCommand('-b:a', '128000');
      audioFileWav.addCommand('-ar ', '48000');
      audioFileWav.addCommand('-y');
      audioFileWav.addCommand('-vn'); // disable video processing
      audioFileWav.addCommand('-ac', '1'); // to mono sound
      await audioFileWav.save(wavPath);

      // denoise
      console.log(`Denoise... save to ${filePath}`);
      const denoiseRes = await denoiseFile(wavPath);
      fs.unlinkSync(wavPath); // remove temp wav

      // save file
      if (denoiseRes) {
        // console.log("denoiseRes:", denoiseRes);
        const stream = denoiseRes.data;
        const writer = fs.createWriteStream(filePath);
        stream.pipe(writer);
      }
    }
    catch (e) {
      console.log('Cannot denoise, skip');
    }
  }


  const audioFile = await new ffmpeg(filePath);
  // const audioFile = await new ffmpeg(denoisedPath);
  audioFile.addCommand('-y');
  audioFile.addCommand('-vn'); // disable video processing
  audioFile.addCommand('-ac', '1'); // to mono sound
  if (audioType == 'ogg') {
    audioFile.addCommand('-acodec', 'libopus');
  }
  if (audioType == 'mp3') {
    audioFile.addCommand('-acodec', 'libmp3lame');
  }
  if (audioType == 'pcm') {
    audioFile.addCommand('-acodec', 'pcm_s16le');
    audioFile.addCommand('-b:a', '128000');
    audioFile.addCommand('-ar ', '48000');
  }

  try {
    // noize models should be placed to ~/yandex-stt/noize-models/
    // from https://github.com/GregorR/rnnoise-models
    // 1. cb
    // 2. mp
    // 3. lq
    // 4. bd
    // 5. sh
    // const pathToModel = `${config.dataPath}/noize-models/cb.rnnn`;
    const pathToModel = `assets/noize-models/cb.rnnn`;

    // filters
    const afilters = [];
    if (postProcessing && config.filterSilence) {
      const args = [
        // 'start_periods=1:start_duration=1',
        'stop_periods=-1:stop_duration=1:stop_threshold=-42dB', // 41 - too small
      ];
      afilters.push('silenceremove=' + args.join(':'));
    }
    if (postProcessing && config.filterNoize) {
      afilters.push(`arnndn=m=${pathToModel}`);
    }
    if (afilters.length > 0) {
      audioFile.addCommand('-af', '"' + afilters.join(', ') + '"');
    }

    // TODO: filters
    // compressor - https://superuser.com/questions/1104534/how-to-use-compressor-with-ffmpeg
    // audio filter pipeline for speech enhancement - https://dsp.stackexchange.com/questions/22442/ffmpeg-audio-filter-pipeline-for-speech-enhancement
    // use FFmpeg to improve audio quality - https://www.reddit.com/r/ffmpeg/comments/6y15g1/is_it_possible_to_use_ffmpeg_to_improve_audio/
    // normalize audio - https://superuser.com/questions/323119/how-can-i-normalize-audio-using-ffmpeg

    const audioExt = ['ogg', 'mp3'].includes(audioType) ? audioType : 'wav';
    const destPath = `${audioSavePath}/${Date.now()}.${audioExt}`;

    console.log(`Convert to ${audioType}... save to ${destPath}`);
    await audioFile.save(destPath);
    return { path: destPath };
  } catch (e) {
    const msg = `Failed to convert ${filePath}: ` + (e.msg ? e.msg : e);
    console.error(msg);
    return { error: msg };
  }

}

async function convertToMp3(filePath) {
  try {
    const audioFile = await new ffmpeg(filePath);
    audioFile.addCommand('-y');
    audioFile.addCommand('-acodec', 'libmp3lame');
    const destPath = filePath.replace(/\.(ogg|wav)$/, '.mp3');
    await audioFile.save(destPath);
    return destPath;
  } catch (e) {
    console.error(`Failed to convert ${filePath} to mp3: ` + e);
    return null;
  }
}

async function uploadToYandexStorage(filePath) {
  // console.log('uploadToYandexStorage: ', filePath);
  const ext = require('path').extname(filePath).replace('.', '');
  if (!['wav', 'ogg', 'mp3'].includes(ext)) {
    throw new Error(`Extension ${ext} not allowed`);
  }

  if (!inited) s3Init();
  const uploadName = `yandex-stt/${Date.now()}.${ext}`;
  const url = `https://storage.yandexcloud.net/${config.bucket}/${uploadName}`;

  const buffer = fs.readFileSync(filePath);

  const contentTypeMap = {
    'mp3': 'audio/mpeg',
    'ogg': 'audio/opus',
    'wav': 'audio/l16',
  }
  const params = {
    Bucket: config.bucket,
    Key: uploadName,
    Body: buffer,
    ContentType: contentTypeMap[ext],
  }

  // try {
    await fs.statSync(filePath);

    const uploaded = await new Promise((resolve, reject) => {
      const req = aws.putObject(params);
      req.on('build', () => {
        req.httpRequest.headers['x-amz-acl'] = 'public-read';
      });
      req.send((err, data) => {
        if (err) reject(err);
        return resolve(data);
      });
    });

    /* const paramsAcl = {
      Bucket: config.bucket,
      Key: uploadName,
    } */

    /* const aclPut = await new Promise((resolve, reject) => {
      aws.putObjectAcl({...paramsAcl, ...{
        ACL: 'public-read'
      }}, (err, data) => {
        if (err) reject(err);
        return resolve(data);
      });
    }); */

    /* const acl = await new Promise((resolve, reject) => {
      aws.getObjectAcl(paramsAcl, (err, data) => {
        if (err) reject(err);
        return resolve(data);
      });
    });
    console.log('acl: ', acl); */

    if (uploaded) {
      return url;
    }
}

async function sendAudioYandex({audioUri, language, punctuation = true}) {
  const langMap = {
    'ru': 'ru-RU',
    'en': 'en-US',
  }
  const languageCode = langMap[language] || 'ru-RU';
  const audioEncoding = {
    ogg: 'OGG_OPUS',
    pcm: 'LINEAR16_PCM'
  }[audioType];

  const model = language === 'ru' ? config.specificationModel : 'general';
  const data = {
    config: {
      specification: {
        languageCode,
        // languageCode: 'en-US',
        // languageCode: 'auto',
        audioEncoding,
        model,
        literature_text: punctuation, // расстановка знаков - https://cloud.yandex.ru/blog/posts/2022/04/speechkit-punctuator
        // rawResults: true, // числа прописью, отменяет знаки препинания
      },
    },
    audio: {
      uri: audioUri,
    },
  };

  if (audioType == 'pcm') {
    data.config.specification.sampleRateHertz = 48000;
  }

  const url = 'https://transcribe.api.cloud.yandex.net/speech/stt/v2/longRunningRecognize';
  try {
    const res = await axios.post(url, data);
    return res.data.id;
  } catch (e) {
    console.log('e.response.data.message: ', e.response.data.message);
    return { error: e.response.data.message };

    // console.log('error: ', e);
  }
}

async function getOperation(id) {
  const opPath = `${opsPath}/${id}.json`;
  let opData;
  if (fs.existsSync(opPath)) {
    opData = JSON.parse(fs.readFileSync(opPath));
    console.log('Loaded from cache');
    if (opData.done) return opData;
  }

  console.log(colors.yellow(`4/4 Check operation ${id}...`));
  const res = await axios.get('https://operation.api.cloud.yandex.net/operations/' + id);
  return {...opData, ...{
    id: id,
    done: res.data.done,
    chunks: res.data.done ? res.data.response.chunks : []
  }};
}

async function checkAndSave(id, uploadedUri) {
  const op = await getOperation(id);
  const opData = {...{
    created: Date.now()
  }, ...op, ...{
    uploadedUri: uploadedUri,
    updated: Date.now()
  }};
  if (!fs.existsSync(opsPath)) fs.mkdirSync(opsPath, { recursive: true }); // create dir
  const opPath = `${opsPath}/${id}.json`;
  fs.writeFileSync(opPath, JSON.stringify(opData));
  console.log('Item saved: ', opPath);

  if (op.done) {
    saveText(op.chunks);
  } else {
    console.log('Not ready yet, wait more...')
    // console.log('res.data: ', res.data);
  }

  return op.done;
}

// private
function saveText(chunks) {
  const lines = chunks
    .map((chunk) => {
      if (chunk.channelTag === '1') return chunk.alternatives[0].text;
    })
    .filter((c) => c);
  const textPath = `${config.dataPath}/answer.txt`;
  const text = lines.join('\n');
  console.log('\n' + text);
  fs.writeFileSync(textPath, text);

  console.log(`\nSaved to ${textPath}`);
}

module.exports = {
  uploadToYandexStorage,
  processAudio,
  sendAudioYandex,
  // getOperation,
  checkAndSave,
  fileToRecognize,
  // fileToRecognizeYandex,
  // fileToRecognizeWhisper,
}
