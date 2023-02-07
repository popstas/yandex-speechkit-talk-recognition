const express = require("express");
const app = express();
const bodyParser = require("body-parser");
const http = require("http").createServer(app);
const busboy = require('connect-busboy'); //middleware for form/file upload
const actions = require('./actions');
const fs = require('fs-extra');
const axios = require('axios');
const config = require('./config');
const path = require('path');
// const { Low, JSONFile } = require('lowdb');

axios.defaults.headers.common['Authorization'] = 'Api-Key ' + config.apiKey;

const opsPath = config.dataPath + '/ops';

// init log db
// const adapter = new JSONFile(`${config.dataPath}/ops.json`);
// const db = new Low(adapter);
// let ops;

start();

function log(obj) {
  console.log(obj);
  // ops.push(obj);
  // db.write();
}

// initFfmpeg();

/*function initFfmpeg() {
  const pathToFfmpeg = require('ffmpeg-static');
  const destPath = '/usr/bin/ffmpeg';
  if (!fs.existsSync(destPath)) fs.symlinkSync(pathToFfmpeg, destPath);
}*/

async function start() {
  // await db.read();
  // db.data ||= { ops: [] };
  // ops = db.data.ops;

  initExpress(app);

}
function initExpress(app) {
  // CORS
  app.use(function (req, res, next) {
    res.header("Access-Control-Allow-Origin", "*");
    res.header(
      "Access-Control-Allow-Headers",
      "Origin, X-Requested-With, Content-Type, Accept"
    );
    next();
  });

  app.use(bodyParser.json());
  app.use(bodyParser.urlencoded({ extended: true }));

  app.use(busboy());

  // better serve with nginx
  app.use("/ops", express.static(opsPath));

  app.get("/", (req, res) => {
    res.send("yandex-stt working");
  });

  /*app.get("/all", (req, res) => {
    const items = getAllOps();
    res.send({ items });
  });*/

  app.post("/upload", upload);

  const port = process.env.PORT || 5771;
  http.listen(port, () => {
    console.log(`Listening at http://localhost:${port}`);
  });
}

/*function getAllOps() {
  const files = fs.readdirSync(opsPath);

  const filesSorted = files.map(function (fileName) {
    return {
      name: fileName,
      time: fs.statSync(opsPath + '/' + fileName).mtime.getTime()
    };
  })
  .sort(function (a, b) {
    return b.time - a.time; })
  .map(function (v) {
    return v.name; });

  /!* const fNames = [
    'created',
    'id',
    'id',
    'id',
    'id',
    'id',
    'id',
  ] *!/
  const filesData = filesSorted.map(fileName => {
    const raw = fs.readFileSync(opsPath + '/' + fileName, 'utf8');
    console.log('raw: ', raw);
    try {
      const dataAll = JSON.parse(raw);
      const data = {};
      /!* for (let name in dataAll) {
        if (fNames.includes(name)) data[name] = dataAll[name];
      } *!/
      return dataAll;
    } catch(e) {
      return false;
    }
  }).filter(Boolean);
  return filesData;
}*/

async function upload(req, res) {
  let fstream;
  req.pipe(req.busboy);

  let postProcessing = true;
  let language = 'ru';
  let punctuation = 'ru';
  req.busboy.on('field', (name, val, info) => {
    if (name === 'postProcessing') {
      postProcessing = val == 'true';
      console.log("postProcessing: ", postProcessing);
    }
    if (name === 'language') {
      language = val;
      console.log("language: ", language);
    }
    if (name === 'punctuation') {
      punctuation = val == 'true';
      console.log("punctuation: ", punctuation);
    }
  });

  req.busboy.on('file', function (fieldname, file, filename) {
    console.log("Uploading: " + filename);

    //Path where image will be uploaded
    const uploadDir = path.normalize(`${config.dataPath}/upload`);
    console.log('uploadDir: ', uploadDir);

    const allowedExt = ['mp3', 'wav', 'ogg', 'opus', 'm4a', 'mp4', 'mkv'];
    const regex = new RegExp('\.(' + allowedExt.join('|') + ')$');
    if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
    if (!regex.test(filename)) {
      const msg = 'Unknown file format, allowed: ' + allowedExt.join(', ');
      console.log(msg);
      res.json({'error': msg});
      return;
    }

    const uploadPath = `${uploadDir}/${Date.now()}_${fieldname}`;
    fstream = fs.createWriteStream(uploadPath);
    file.pipe(fstream);
    
    // after upload file
    fstream.on('close', async function () {
      console.log("Upload Finished of " + filename);

      const resRec = await actions.fileToRecognize({
        filePath: uploadPath,
        filename,
        postProcessing,
        language,
        punctuation,
      });
      log({
        id: resRec.opId,
        status: 'converted',
        date: new Date().toUTCString(),
      });

      if (resRec && resRec.error) {
        res.json({error: resRec.error});
        return;
      }

      const delay = 10;
      const interval = setInterval(async () => {
        const done = await actions.checkAndSave(resRec.opId, resRec.uploadedUri);
        if (done) {
          log({
            id: resRec.opId,
            status: 'done',
            date: new Date().toUTCString(),
          });
          clearInterval(interval);
        }
      }, delay * 1000);

      // const opId = '123';
      res.json({opId: resRec.opId});
    });
  })
};