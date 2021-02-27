const fs = require('fs');
const axios = require('axios');
const config = require('./config');

axios.defaults.headers.common['Authorization'] = 'Api-Key ' + config.apiKey;

async function checkOperation(id) {
  console.log(`checkOperation ${id}...`);
  const res = await axios.get('https://operation.api.cloud.yandex.net/operations/' + id);

  if (res.data.done) {
    saveText(res.data.response);
  } else {
    console.log('res.data: ', res.data);
  }

  return res.data.done;
}

function saveText(response) {
  const lines = response.chunks
    .map((chunk) => {
      if (chunk.channelTag === '1') return chunk.alternatives[0].text;
    })
    .filter((c) => c);
  const textPath = 'data/answer.txt';
  const text = lines.join('\n');
  console.log('\n' + text);
  fs.writeFileSync(textPath, text);
}

async function sendAudio() {
  const data = {
    config: {
      specification: {
        languageCode: 'ru-RU',
        audioEncoding: 'OGG_OPUS',
        model: config.specificationModel,
      },
    },
    audio: {
      uri: config.audioUri,
    },
  };

  const url = 'https://transcribe.api.cloud.yandex.net/speech/stt/v2/longRunningRecognize';
  try {
    const res = await axios.post(url, data);

    console.log('id: ', res.data.id);
    return res.data.id;
  } catch (e) {
    console.log('e.response.data.message: ', e.response.data.message);
    console.log('error: ', e);
  }
}

async function start() {
  let id = await sendAudio();
  console.log('Wait 60 seconds...');
  // let id = '';

  const interval = setInterval(() => {
    const done = checkOperation(id);
    if (done) clearInterval(interval);
  }, 60000);

  // const done = checkOperation(id);
  // if (done) clearInterval(interval);
}

start();
