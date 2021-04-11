#!/usr/bin/env node
const fs = require('fs');
const axios = require('axios');
const config = require('./config');
const actions = require('./actions');
const packageJson = require('./package.json');
const { program } = require('commander');
const colors = require('colors');

axios.defaults.headers.common['Authorization'] = 'Api-Key ' + config.apiKey;

// create data directory and config
const homedir = require('os').homedir();
const dataPath = `${homedir}/yandex-stt`;
if (!fs.existsSync(dataPath)) fs.mkdirSync(`${homedir}/yandex-stt`);
const configPath = `${dataPath}/config.js`
if (!fs.existsSync(configPath)) {
  fs.copyFileSync('./config.example.js', configPath);
  console.log(`Created default config in ${configPath}, fill it!`);
  process.exit(0);
}

program
  .version(packageJson.version)
  .option('--file <file>', 'mp3 file for recognition')
  .option('--id <id>', 'id for wait results')
  .usage('--file <file>\nor: --id <id>')

async function checkOperation(id) {
  console.log(colors.yellow(`4/4 Check operation ${id}...`));
  const res = await axios.get('https://operation.api.cloud.yandex.net/operations/' + id);

  if (res.data.done) {
    saveText(res.data.response);
  } else {
    console.log('Not ready yet, wait more...')
    // console.log('res.data: ', res.data);
  }

  return res.data.done;
}

function saveText(response) {
  const lines = response.chunks
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

async function start() {
  // check config
  const configOptions = ['apiKey', 'storageUploadId', 'storageUploadSecret', 'specificationModel', 'bucket'];
  let configValid = true;
  for (let name of configOptions) {
    if (!config[name]) {
      configValid = false;
      console.log(`"${name}" not defined in config!`);
    }
  }
  if (!configValid) {
    console.log('See docs: https://www.npmjs.com/package/yandex-stt');
    process.exit(0);
  }

  program.parse(process.argv);
  const options = program.opts();
  let opId;

  if (!options.file && !options.id) {
    program.usage();
    process.exit(1);
  }

  if (options.id) {
    opId = options.id;
  }
  
  // convert and upload file
  else {
    // convert to ogg
    console.log(colors.yellow('1/4 Convert to OGG Opus...'));
    const filePath = options.file;
    const res = await actions.convertToOgg(filePath);
    if (!res) return;

    // upload to Yandex
    console.log(colors.yellow('2/4 Upload to Yandex Object Storage...'));
    const uploadedUri = await actions.uploadToYandexStorage(res.path);

    // send to STT
    console.log(colors.yellow('3/4 Send to SpeechKit...'));
    opId = await sendAudio(uploadedUri);
    console.log('Uploaded, id: ' + opId);
  }

  const delay = 10;
  console.log(`Wait ${delay} seconds...`);
  const interval = setInterval(async () => {
    const done = await checkOperation(opId);
    if (done) clearInterval(interval);
  }, delay * 1000);
}

start();
