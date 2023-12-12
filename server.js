const express = require('express');
const app = express();
const bodyParser = require('body-parser');
const http = require('http').createServer(app);
const busboy = require('connect-busboy'); //middleware for form/file upload
const actions = require('./actions');
const fs = require('fs-extra');
const axios = require('axios');
const config = require('./config');
const path = require('path');
const packageJson = require('./package.json');
// const { Low, JSONFile } = require('lowdb');

const {Telegraf, Input} = require('telegraf');
const {message, editedMessage} = require('telegraf/filters');

axios.defaults.headers.common['Authorization'] = 'Api-Key ' + config.apiKey;

const opsPath = config.dataPath + '/ops';

// init log db
// const adapter = new JSONFile(`${config.dataPath}/ops.json`);
// const db = new Low(adapter);
// let ops;

let bot;
void start();

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

onunhandledrejection = (reason, p) => {
  console.log('Unhandled Rejection at:', p, 'reason:', reason);
};

process.uncaughtException = (error, source) => {
  console.error('Uncaught Exception:', error);
  console.error('Source:', source);
};

async function start() {
  // await db.read();
  // db.data ||= { ops: [] };
  // ops = db.data.ops;

  initExpress(app);

  initBot();
}

function initBot() {
  if (!config.telegramBotToken) return;

  try {
    bot = new Telegraf(config.telegramBotToken);
    console.log('bot started');
    bot.on([message('voice')], onVoice);
    bot.on([message('audio')], onAudio);
    // bot.on([message('document')], onDocument);
    bot.on([message('text')], onText);
    // bot.on('channel_post', onMessage);
    process.once('SIGINT', () => bot.stop('SIGINT'));
    process.once('SIGTERM', () => bot.stop('SIGTERM'));
    bot.launch();
  } catch (e) {
    console.log('restart after 5 seconds...');
    setTimeout(initBot, 5000);
  }
}

async function sendTelegramMessage(chat_id, text, extraMessageParams) {
  return new Promise((resolve) => {

    const msgs = splitBigMessage(text);
    if (msgs.length > 1) console.log(`Split into ${msgs.length} messages`);

    const params = {
      ...extraMessageParams,
      // disable_web_page_preview: true,
      // disable_notification: true,
      // parse_mode: 'HTML'
    };

    msgs.forEach(async (msg) => {
      await bot.telegram.sendMessage(chat_id, msg, params);
    });
    resolve(true);
  });
}

function splitBigMessage(text) {
  const msgs = [];
  const sizeLimit = 4096;
  let msg = '';
  for (const line of text.split('\n')) {
    if (msg.length + line.length > sizeLimit) {
      // console.log("split msg:", msg);
      msgs.push(msg);
      msg = '';
    }
    msg += line + '\n';
  }
  msgs.push(msg);
  return msgs;
}

async function downloadFile(url, filePath) {
  console.log('downloadFile:', url);
  const response = await axios({
    url: url,
    responseType: 'stream',
  });

  // console.log("response:", response);
  const stream = response.data;
  const writer = fs.createWriteStream(filePath);
  stream.pipe(writer);

  return new Promise((resolve, reject) => {
    writer.on('finish', resolve);
    writer.on('error', reject);
  });
}

async function downloadTelegramFile(ctx, fileId, filePath) {
  try {
    // console.log("downloadTelegramFile:", fileId);
    const url = await ctx.telegram.getFileLink(fileId);
    // console.log("telegram url:", url);
    await downloadFile(url.href, filePath);
    return true;
  } catch (e) {
    console.log('downloadTelegramFile error:', fileId);
    console.log(e);

    // known errors
    if (e.response && e.response.error_code === 400) {
      if (e.response.description === 'Bad Request: file is too big') {
        ctx.reply('File is too big. File size limit is 20 MB.');
        return -1;
      }
    }

    return false;
  }
}

// split text to paragraphs, when > 200 symbols in paragraph
function prettyText(text) {
  const paragraphs = [];
  const sentences = text.split(/[.?!][ \n]/g);
  // console.log("sentences:", sentences.length);
  let paragraph = '';
  while (sentences.length > 0) {
    paragraph += sentences.shift() + '. ';
    paragraph = paragraph.replace(/\.\. $/, '. '); // remove ..

    if (paragraph.length > 200) {
      paragraphs.push(paragraph.trim() + '');
      // console.log("zero paragraph:", paragraph);
      paragraph = '';
    }
  }
  if (paragraph.length > 0) {
    paragraphs.push(paragraph.trim() + '');
  }
  // console.log("paragraphs", paragraphs);

  const prettyText = paragraphs.join('\n\n');
  return prettyText;
}

async function onText(ctx) {

  // recognize last with prompt
  if (ctx.message.reply_to_message) {
    const text = ctx.message.reply_to_message.caption ||
        ctx.message.reply_to_message.text;
    // console.log("text:", text);
    const opId = getOpIdByText(text);
    // console.log("opId:", opId);
    if (!opId) return;

    const op = readOpsData(opId);
    // console.log("op:", op);

    const prompt = ctx.message.text;
    // console.log("prompt:", prompt);

    const fileUrl = op.uploadedUri;
    const filePath = getFilenameSavePath('voice.ogg');
    await downloadFile(fileUrl, filePath);

    const resRec = await actions.fileToRecognize({
      filePath,
      provider: 'whisper',
      prompt,
    });

    if (resRec && resRec.error) {
      return ctx.reply(`Error: ${resRec.error}`);
    }

    // console.log("resRec:", resRec);
    // ctx.replyWithVoice(Input.fromURL(resRec.uploadedUri), {caption: getOpUrl(resRec.opId)});

    await waitOpDoneSendText(ctx, resRec.opId);
    return;
  }

  // or pretty text
  detectAndSendTasks(ctx.message.text, ctx);
  const text = prettyText(ctx.message.text);
  await sendTelegramMessage(ctx.chat.id, text);
}

function readOpsData(opId) {
  const opPath = `${opsPath}/${opId}.json`;
  return JSON.parse(fs.readFileSync(`${opPath}`));
}

async function downloadVoiceFile(ctx, fileId, filePath) {
  // download voice file to local
  let tries = 2;
  return await new Promise((resolve, reject) => {
    const handler = async () => {
      ctx.telegram.sendChatAction(ctx.message.chat.id, 'upload_voice');
      const ok = await downloadTelegramFile(ctx, fileId, filePath);
      if (ok && ok !== -1) {
        clearInterval(interval);
        return resolve(filePath);
      } else {
        tries--;
        if (ok === -1) tries = 0;
        if (tries <= 0) {
          if (ok !== -1) ctx.reply('Failed to get file from telegram');
          clearInterval(interval);
        } else {
          ctx.reply(
              'Failed to get file from telegram, next repeat after 5 secs...');
        }
      }
    };
    const interval = setInterval(handler, 5000);
    handler();
  });
}

function processText(text) {
  text = prettyText(text);
  text = text.replace(/ +/g, ' ');
  return text;
}

function detectTasks(text) {
  const tasks = [];
  // task is sentense from text begining with "Надо" or "Нужно".
  // Parse text to tasks:
  const replacedText = text.replace(/(Тезис|Дезис)\./g, '$1,');
  const sentences = replacedText.split(/[.?!][ \n]/g);
  for (const sentence of sentences) {
    const reg = new RegExp('^(Надо( заметить(, что)?)?|Нужно|Нужна|Нужны|Надо|Тезис|Дезис),? ');
    if (reg.test(sentence)) {
      // Remove begining "Надо" or "Нужно".
      const task = sentence.replace(reg, '');
      // Capitalize first letter.
      tasks.push(task.charAt(0).toUpperCase() + task.slice(1));
    }
  }

  return tasks;
}

function detectAndSendTasks(text, ctx) {
  const tasks = detectTasks(text);
  if (tasks.length > 0) {
    const text = `Задачи:\n\n${tasks.map((task) => `- ${task}`).join('\n')}`;
    void sendTelegramMessage(ctx.chat.id, text);
  }
}

async function waitOpDoneSendText(ctx, opId) {
  const interval = setInterval(() => {
    try {
      ctx.telegram.sendChatAction(ctx.message.chat.id, 'typing');

      const json = readOpsData(opId);
      if (json.done) {
        clearInterval(interval);

        const text = json.chunks.map(chunk => {
          return chunk.alternatives[0].text.trim();
        }).join(' ').replace(/ +/g, ' ');

        detectAndSendTasks(text, ctx);

        // ctx.reply(`${prettyText(text)}\n\n${getOpUrl(opId)}`);
        sendTelegramMessage(ctx.chat.id, processText(text));
      }

    } catch (e) {
      console.log('Check failed:', e);
    }
  }, 2000);
}

// general function
async function onFile(ctx, filePath) {
  const resRec = await actions.fileToRecognize({
    filePath,
    provider: 'whisper',
  });

  if (resRec && resRec.error) {
    return ctx.reply(`Error: ${resRec.error}`);
  }

  console.log('Result URL:', getOpUrl(resRec.opId));

  ctx.replyWithVoice(Input.fromURL(resRec.uploadedUri),
      {caption: getOpUrl(resRec.opId)});
  // ctx.reply(getOpUrl(resRec.opId));
  // ctx.replyWithVoice(Input.fromURL(resRec.uploadedUri));

  await waitOpDoneSendText(ctx, resRec.opId);
}

async function onVoice(ctx) {
  // console.log("ctx.message.voice:", ctx.message.voice);
  const filePath = getFilenameSavePath('voice.ogg');
  await downloadVoiceFile(ctx, ctx.message.voice.file_id, filePath);

  await onFile(ctx, filePath);
}

async function onAudio(ctx) {
  // console.log("ctx.message.audio:", ctx.message.audio);
  const filePath = getFilenameSavePath(ctx.message.audio.file_name);
  await downloadVoiceFile(ctx, ctx.message.audio.file_id, filePath);

  await onFile(ctx, filePath);
}

/*async function onDocument(ctx) {
  console.log("ctx.message.document:", ctx.message.document);
  const filePath = getFilenameSavePath(ctx.message.document.file_name);
  await downloadVoiceFile(ctx, ctx.message.document.file_id, filePath);

  await onFile(ctx, filePath);
}*/

function getOpUrl(opId) {
  return `https://talk.popstas.ru/talk/${opId}`;
}

function getOpIdByText(text) {
  const match = text.match(/\/talk\/([a-z0-9]+)/);
  if (match) {
    return match[1];
  }
}

function initExpress(app) {
  // CORS
  app.use(function(req, res, next) {
    res.header('Access-Control-Allow-Origin', '*');
    res.header(
        'Access-Control-Allow-Headers',
        'Origin, X-Requested-With, Content-Type, Accept',
    );
    next();
  });

  app.use(bodyParser.json());
  app.use(bodyParser.urlencoded({extended: true}));

  app.use(busboy());

  // better serve with nginx
  app.use('/ops', express.static(opsPath));

  app.get('/', (req, res) => {
    res.json({
      version: packageJson.version,
      whisper: true,
      yandex: !!config.apiKey,
    });
  });

  /*app.get("/all", (req, res) => {
    const items = getAllOps();
    res.send({ items });
  });*/

  app.post('/upload', upload);

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

function getUploadDir() {
  const uploadDir = path.normalize(`${config.dataPath}/upload`);
  if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, {recursive: true});
  return uploadDir;
}

function getFilenameSavePath(filename) {
  const uploadDir = getUploadDir();
  return `${uploadDir}/${Date.now()}_${safeFilename(filename)}`;
}

function safeFilename(filename) {
  return filename.replace(/[^a-zа-я0-9.]/gi, '_');
}

async function upload(req, res) {
  let fstream;
  req.pipe(req.busboy);

  // let provider = 'yandex';
  let provider = 'whisper';

  let postProcessing = true;
  let language = 'ru';
  let punctuation = true;
  let prompt = '';
  req.busboy.on('field', (name, val, info) => {
    if (name === 'postProcessing') {
      postProcessing = val == 'true';
      console.log('postProcessing: ', postProcessing);
    }
    if (name === 'language') {
      language = val;
      console.log('language: ', language);
    }
    if (name === 'punctuation') {
      punctuation = val == 'true';
      console.log('punctuation: ', punctuation);
    }
    if (name === 'provider') {
      provider = val;
      console.log('provider: ', provider);
    }
    if (name === 'prompt' && val) {
      prompt = val;
    }
  });

  req.busboy.on('file', function(fieldname, file, filename) {
    console.log('Uploading: ' + filename);

    const allowedExt = [
      'mp3',
      'mpeg',
      'wav',
      'ogg',
      'opus',
      'aac',
      'm4a',
      'mp4',
      'mkv'];
    const regex = new RegExp('\.(' + allowedExt.join('|') + ')$');
    if (!regex.test(filename)) {
      const msg = 'Unknown file format, allowed: ' + allowedExt.join(', ');
      console.log(msg);
      res.json({'error': msg});
      return;
    }

    const filePath = getFilenameSavePath(fieldname);
    fstream = fs.createWriteStream(filePath);
    file.pipe(fstream);

    // after upload file
    fstream.on('close', async function() {
      console.log('Upload Finished of ' + filename);

      const resRec = await actions.fileToRecognize({
        filePath,
        filename,
        postProcessing,
        language,
        punctuation,
        provider,
        prompt,
      });

      if (resRec.error) {
        return res.json({error: resRec.error});
      }

      res.json({opId: resRec.opId});
    });
  });
};