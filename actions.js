const fs = require('fs');
const config = require('./config');
const ffmpeg = require('ffmpeg');
const AWS = require('aws-sdk');
const axios = require('axios');
const colors = require('colors');

const audioType = config.audioType || 'ogg'; // ogg|pcm
const audioExt = audioType == 'ogg' ? 'ogg' : 'wav';
if (config.filters === undefined) config.filters = true;

const opsPath = `${config.dataPath}/ops`;

const audioSavePath = `${config.dataPath}/converted`;
let aws;
let inited = false;

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

async function processAudio(filePath, audioType) {
  if (!['ogg', 'pcm'].includes(audioType)) {
    throw new Error('Only ogg and pcm types supported');
  }

  // console.log('filePath: ', filePath);
  if (!fs.existsSync(audioSavePath)) fs.mkdirSync(audioSavePath, { recursive: true }); // create dir

  await fs.statSync(filePath);

  const audioFile = await new ffmpeg(filePath);
  audioFile.addCommand('-y');
  audioFile.addCommand('-ac', '1'); // to mono sound
  if (audioType == 'ogg') {
    audioFile.addCommand('-acodec', 'libopus');
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
    const pathToModel = `data/cb.rnnn`; // TODO: to dataPath

    if (config.filters) {
      const afilters = [
        'silenceremove=stop_periods=-1:stop_duration=1:stop_threshold=-40dB', // silence remove
        `arnndn=m=${pathToModel}` // noize remove
      ];
      audioFile.addCommand('-af', '"' + afilters.join(', ') + '"');
    }

    // TODO: filters
    // compressor - https://superuser.com/questions/1104534/how-to-use-compressor-with-ffmpeg
    // audio filter pipeline for speech enhancement - https://dsp.stackexchange.com/questions/22442/ffmpeg-audio-filter-pipeline-for-speech-enhancement
    // use FFmpeg to improve audio quality - https://www.reddit.com/r/ffmpeg/comments/6y15g1/is_it_possible_to_use_ffmpeg_to_improve_audio/
    // normalize audio - https://superuser.com/questions/323119/how-can-i-normalize-audio-using-ffmpeg

    const destPath = `${audioSavePath}/${Date.now()}.${audioExt}`;

    await audioFile.save(destPath);
    return { path: destPath };
  } catch (e) {
    const msg = `Failed to convert ${filePath}: ` + (e.msg ? e.msg : e);
    console.error(msg);
    return { error: msg };
  }

}

async function convertToMp3(filePath) {
  const audioFile = await new ffmpeg(filePath);
  audioFile.addCommand('-y');
  audioFile.addCommand('-acodec', 'libmp3lame');
  const destPath = filePath.replace(/\.(ogg|wav)$/, '.mp3');
  await audioFile.save(destPath);
  return destPath;
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

async function sendAudio(audioUri) {
  const encoding = {
    ogg: 'OGG_OPUS',
    pcm: 'LINEAR16_PCM'
  }[audioType];

  const data = {
    config: {
      specification: {
        languageCode: 'ru-RU',
        audioEncoding: encoding,
        model: config.specificationModel,
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
    console.log('error: ', e);
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

// upload file, return operation id
async function fileToRecognize(filePath, filename = '') {
  // convert to ogg/pcm
  console.log(colors.yellow(`1/4 Convert to ${audioType}...`));
  const res = await processAudio(filePath, audioType);
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
  const opId = await sendAudio(recognitionUri);
  console.log('Uploaded, id: ' + opId);

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

module.exports = {
  uploadToYandexStorage,
  processAudio,
  sendAudio,
  // getOperation,
  checkAndSave,
  fileToRecognize
}
