const express = require("express");
const app = express();
const bodyParser = require("body-parser");
const http = require("http").createServer(app);
const busboy = require('connect-busboy'); //middleware for form/file upload
const actions = require('./actions');
const fs = require('fs-extra');
const axios = require('axios');
const config = require('./config');

axios.defaults.headers.common['Authorization'] = 'Api-Key ' + config.apiKey;

const homedir = require('os').homedir();
const dataPath = process.env.DATA_DIR || `${homedir}/yandex-stt`;

initExpress(app);

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

  app.use("/ops", express.static(dataPath + '/ops'));

  app.get("/", async (req, res) => {
    res.send("yandex-stt working");
  });

  app.post("/upload", async (req, res) => {
    let fstream;
    req.pipe(req.busboy);
    req.busboy.on('file', function (fieldname, file, filename) {
      console.log("Uploading: " + filename);

      //Path where image will be uploaded
      const uploadDir = `${dataPath}/upload`;
      if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);
      if (!filename.match(/\.(mp3|mp4|wav|ogg|opus|m4a)$/)) {
        const msg = 'unknown file format, allowed: mp3|mp4|wav|ogg|opus|m4a';
        console.log(msg);
        res.json({'error': msg});
        return;
      }

      const uploadPath = `${uploadDir}/${Date.now()}_${fieldname}`;
      fstream = fs.createWriteStream(uploadPath);
      file.pipe(fstream);

      fstream.on('close', async function () {
        console.log("Upload Finished of " + filename);

        const resRec = await actions.fileToRecognize(uploadPath, filename);

        const delay = 10;
        const interval = setInterval(async () => {
          const done = await actions.checkAndSave(resRec.opId, resRec.uploadedUri);
          if (done) clearInterval(interval);
        }, delay * 1000);

        // const opId = '123';
        res.json({opId: resRec.opId});
      });
    });
  });

  const port = process.env.PORT || 5771;
  http.listen(port, () => {
    console.log(`Listening at http://localhost:${port}`);
  });
}
