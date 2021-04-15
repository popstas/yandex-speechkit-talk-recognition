#!/usr/bin/env node
const fs = require('fs');
const axios = require('axios');
const config = require('./config');
const actions = require('./actions');
const packageJson = require('./package.json');
const { program } = require('commander');

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

  if (!options.file && !options.id) {
    program.usage();
    process.exit(1);
  }

  let opId, uploadedUri;

  if (options.id) {
    opId = options.id;
  }
  
  // convert and upload file
  else {
    const resRec = await fileToRecognize(options.file);
    opId = resRec.opId;
    uploadedUri = resRec.uploadedUri;
  }

  const delay = 10;

  // instant check for --id
  if (options.id) {
    const done = await actions.checkAndSave(opId, uploadedUri);
    if (done) return;
  }

  console.log(`Wait ${delay} seconds...`);
  const interval = setInterval(async () => {
    const done = await actions.checkAndSave(opId, uploadedUri);
    if (done) clearInterval(interval);
  }, delay * 1000);
}

start();
