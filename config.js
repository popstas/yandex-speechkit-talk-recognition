const fs = require('fs');
const homedir = require('os').homedir();
const dataPath = process.env.DATA_DIR || `${homedir}/yandex-stt`;
const configPath = `${dataPath}/config.js`;

let config = {};
if (fs.existsSync(configPath)) {
  config = require(configPath);
}

// defaults
config = {...{
  specificationModel: 'deferred-general',
  dataPath: `${homedir}/yandex-stt`,
  filters: false,
}, ...config};

// env
const envMap = {
  API_KEY: 'apiKey',
  STORAGE_UPLOAD_ID: 'storageUploadId',
  STORAGE_UPLOAD_SECRET: 'storageUploadSecret',
  SPECIFICATION_MODEL: 'specificationModel',
  BUCKET: 'bucket',

  DATA_DIR: 'dataPath',
}
for (let envName in envMap) {
  const confName = envMap[envName];
  if (process.env[envName]) config[confName] = process.env[envName];
}
module.exports = config;
