const fs = require('fs');
const config = require('./config');
const ffmpeg = require('ffmpeg');
const AWS = require('aws-sdk');
const axios = require('axios');
const colors = require('colors');

const homedir = require('os').homedir();
const dataPath = `${homedir}/yandex-stt`;

// const axios = require('axios');
// axios.defaults.headers.common['Authorization'] = 'Api-Key ' + config.storageUploadKey;

const opsPath = `${dataPath}/ops`;

const oggSavePath = `${dataPath}/converted`;
let aws;
let inited = false;

function s3Init() {
  aws = new AWS.S3({
    endpoint: 'https://storage.yandexcloud.net', 
    accessKeyId: config.storageUploadId,
    secretAccessKey: config.storageUploadSecret,
    region: 'ru-central1',
    httpOptions: {
      timeout: 10000,
      connectTimeout: 10000
    },
  });
}

async function convertToOgg(filePath) {
  // console.log('filePath: ', filePath);
  try {
    if (!fs.existsSync(oggSavePath)) fs.mkdirSync(oggSavePath, { recursive: true }); // create dir

    await fs.statSync(filePath);

    const audioFile = await new ffmpeg(filePath);
    audioFile.addCommand('-y');
    audioFile.addCommand('-acodec', 'libopus');
    audioFile.addCommand('-ac', '1'); // to mono sound

    // noize models should be placed to ~/yandex-stt/noize-models/
    // from https://github.com/GregorR/rnnoise-models
    // 1. cb
    // 2. mp
    // 3. lq
    // 4. bd
    // 5. sh
    // const pathToModel = `${dataPath}/noize-models/cb.rnnn`;
    const pathToModel = `data/cb.rnnn`;

    const afilters = [
      'silenceremove=stop_periods=-1:stop_duration=1:stop_threshold=-40dB', // silence remove
      `arnndn=m=${pathToModel}` // noize remove
    ]
    audioFile.addCommand('-af', '"' + afilters.join(', ') + '"');

    // TODO: filters
    // compressor - https://superuser.com/questions/1104534/how-to-use-compressor-with-ffmpeg
    // audio filter pipeline for speech enhancement - https://dsp.stackexchange.com/questions/22442/ffmpeg-audio-filter-pipeline-for-speech-enhancement
    // use FFmpeg to improve audio quality - https://www.reddit.com/r/ffmpeg/comments/6y15g1/is_it_possible_to_use_ffmpeg_to_improve_audio/
    // normalize audio - https://superuser.com/questions/323119/how-can-i-normalize-audio-using-ffmpeg

    const destPath = `${oggSavePath}/${Date.now()}.ogg`;
    const convertedFile = await audioFile.save(destPath);

    return { path: destPath };
  } catch (e) {
    console.error(`Failed to convert ${filePath}: ` + (e.msg ? e.msg : e));
  }
}

async function uploadToYandexStorage(filePath) {
  // console.log('uploadToYandexStorage: ', filePath);
  if (!inited) s3Init();
  const uploadName = `yandex-stt/${Date.now()}.ogg`;
  const url = `https://storage.yandexcloud.net/${config.bucket}/${uploadName}`;

  const buffer = fs.readFileSync(filePath);

  const params = {
    Bucket: config.bucket,
    Key: uploadName,
    Body: buffer,
    ContentType: 'audio/opus',
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
  const data = {
    config: {
      specification: {
        languageCode: 'ru-RU',
        audioEncoding: 'OGG_OPUS',
        model: config.specificationModel,
      },
    },
    audio: {
      uri: audioUri,
    },
  };

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
  const textPath = `${dataPath}/answer.txt`;
  const text = lines.join('\n');
  console.log('\n' + text);
  fs.writeFileSync(textPath, text);

  console.log(`\nSaved to ${textPath}`);
}

// upload file, return operation id
async function fileToRecognize(filePath, filename = '') {
  // convert to ogg
  console.log(colors.yellow('1/4 Convert to OGG Opus...'));
  const res = await convertToOgg(filePath);
  if (!res) return;

  // upload to Yandex
  console.log(colors.yellow('2/4 Upload to Yandex Object Storage...'));
  const uploadedUri = await uploadToYandexStorage(res.path);

  // send to STT
  console.log(colors.yellow('3/4 Send to SpeechKit...'));
  const opId = await sendAudio(uploadedUri);
  console.log('Uploaded, id: ' + opId);

  const opPath = `${opsPath}/${opId}.json`;
  fs.writeFileSync(opPath, JSON.stringify({
    id: opId,
    uploadedUri: uploadedUri,
    updated: Date.now(),
    done: false,
    chunks: [],
    filename: filename,
  }));

  return {uploadedUri, opId};
}

module.exports = {
  uploadToYandexStorage,
  convertToOgg,
  sendAudio,
  // getOperation,
  checkAndSave,
  fileToRecognize
}
