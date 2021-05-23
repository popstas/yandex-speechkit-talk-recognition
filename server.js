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
const { exec } = require('child_process');

axios.defaults.headers.common['Authorization'] = 'Api-Key ' + config.apiKey;

initFfmpeg();
initExpress(app);

function initFfmpeg() {
  const pathToFfmpeg = require('ffmpeg-static');
  const destPath = '/usr/bin/ffmpeg';
  if (!fs.existsSync(destPath)) fs.symlinkSync(pathToFfmpeg, destPath);
}

function initExpress(app) {
  // CORS
  app.use(function (req, res, next) {
    res.header("Access-Control-Allow-Origin", "*");
    // res.header("Access-Control-Allow-Methods", "*");
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
  app.use("/ops", express.static(config.dataPath + '/ops'));

  app.get("/", (req, res) => {
    res.send("yandex-stt working");
  });

  app.post("/upload", upload);

  const port = process.env.PORT || 5771;
  http.listen(port, () => {
    console.log(`Listening at http://localhost:${port}`);
  });
}

async function upload(req, res) {
  let fstream;
  req.pipe(req.busboy);
  req.busboy.on('file', function (fieldname, file, filename) {
    console.log("Uploading: " + filename);

    //Path where image will be uploaded
    const uploadDir = path.normalize(`${config.dataPath}/upload`);
    console.log('uploadDir: ', uploadDir);

    const allowedExt = ['mp3', 'wav', 'ogg', 'opus', 'm4a', 'mp4', 'mkv'];
    const regex = new RegExp('\.(' + allowedExt.join('|') + ')$');
    if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);
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

      const resRec = await actions.fileToRecognize(uploadPath, filename);

      if (resRec && resRec.error) {
        res.json({error: resRec.error});
        return;
      }

      const delay = 10;
      const interval = setInterval(async () => {
        const done = await actions.checkAndSave(resRec.opId, resRec.uploadedUri);
        if (done) clearInterval(interval);
      }, delay * 1000);

      // const opId = '123';
      res.json({opId: resRec.opId});
    });
  })
};