const { program } = require('commander');
const actions = require('./actions');
const packageJson = require('./package.json');

let filenames = [];

program
  .version(packageJson.version)
  .arguments('[files...]')
  .usage('<file ...>')
  .option('-f, --force', 'overwrite output files')
  .option('-u, --upload', 'upload to yandex')
  .action((args) => {
    filenames = args;
  });

async function start() {
  program.parse(process.argv);
  const options = program.opts();

  for (let filePath of filenames) {
    const res = await actions.convertToOgg(filePath);
    if (!res) continue;

    console.log('program.upload: ', options.upload);
    if (options.upload) {
      res.uploadedUri = await actions.uploadToYandexStorage(res.path);
    }
    console.log(JSON.stringify(res));
  }
}

start();
