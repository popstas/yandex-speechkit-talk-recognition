const fs = require('fs');
const homedir = require('os').homedir();
const configPath = `${homedir}/yandex-stt/config.js`;
if (fs.existsSync(configPath)) {
  module.exports = require(configPath);
}
else {
  module.exports = {};
}