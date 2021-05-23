const fs = require('fs');
const homedir = require('os').homedir();
// console.log('process.env.DATA_DIR: ', process.env.DATA_DIR);
const dataPath = process.env.DATA_DIR || `${homedir}/yandex-stt`;
const configPath = `${dataPath}/config.js`;

if (fs.existsSync(configPath)) {
  module.exports = require(configPath);
}
else {
  module.exports = {};
}

module.exports.dataPath = dataPath;
