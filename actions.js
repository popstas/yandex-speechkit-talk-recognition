const fs = require('fs');
const config = require('./config');
const ffmpeg = require('ffmpeg');
const AWS = require('aws-sdk');

const homedir = require('os').homedir();
const dataPath = `${homedir}/yandex-stt`;

// const axios = require('axios');
// axios.defaults.headers.common['Authorization'] = 'Api-Key ' + config.storageUploadKey;

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
    // audioFile.addCommand('-strict', '-2');
    audioFile.addCommand('-acodec', 'libopus'); // TODO: or opus
    audioFile.addCommand('-ac', '1'); // to mono sound
    // audioFile.addCommand('-aq', 10);
    // console.log('audioFile: ', audioFile);

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
  /* const opts = {
    validateStatus: (status) => { return true; },
    headers: {
      Date: new Date().toString(),
    }
  }; */

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
      aws.upload(params, (err, data) => {
        if (err) reject(err);
        return resolve(data);
      });
    });
    if (uploaded) {
      return uploaded.Location;
    }

    // const form_data = new FormData();
    /* const answer = await axios.put(url, { data: buffer }, opts);
    if (answer.status > 299) {
      console.log(answer.status, "\n", answer.data);
      console.error('Error while sending request');
      return false;
    } */

    return url;
  /* } catch (e) {
    console.error(`Failed to convert ${filePath}: ` + (e.msg ? e.msg : e));
  } */
}

module.exports = {
  uploadToYandexStorage,
  convertToOgg
}
