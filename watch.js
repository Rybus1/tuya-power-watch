const crypto = require("crypto");
const https = require("https");
const fs = require("fs");

const HOST = "openapi.tuyaeu.com";
const CLIENT_ID = process.env.TUYA_CLIENT_ID;
const CLIENT_SECRET = process.env.TUYA_CLIENT_SECRET;
const DEVICE_ID = process.env.TUYA_DEVICE_ID;

const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;

const STATE_FILE = "state.json";
const COOLDOWN = 15 * 60 * 1000; // 15 мин

function sha256(str) {
  return crypto.createHash("sha256").update(str).digest("hex");
}

function sign(method, path, body, token, t) {
  const stringToSign =
    method + "\n" +
    sha256(body || "") + "\n" +
    "\n" +
    path;

  const message = CLIENT_ID + (token || "") + t + stringToSign;

  return crypto
    .createHmac("sha256", CLIENT_SECRET)
    .update(message)
    .digest("hex")
    .toUpperCase();
}

function request(method, path, token) {
  return new Promise((resolve, reject) => {
    const t = Date.now().toString();
    const signature = sign(method, path, "", token, t);

    const options = {
      hostname: HOST,
      path,
      method,
      headers: {
        client_id: CLIENT_ID,
        t,
        sign_method: "HMAC-SHA256",
        sign: signature,
        "Content-Type": "application/json",
        ...(token && { access_token: token })
      }
    };

    const req = https.request(options, res => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => resolve(JSON.parse(data)));
    });

    req.on("error", reject);
    req.end();
  });
}

async function getToken() {
  const res = await request("GET", "/v1.0/token?grant_type=1");
  return res.result.access_token;
}

async function getOnline(token) {
  const res = await request("GET", `/v2.0/cloud/thing/${DEVICE_ID}`, token);
  return res.result.is_online;
}

function sendTelegram(text) {
  const url = `https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`;
  const body = `chat_id=${TG_CHAT_ID}&text=${encodeURIComponent(text)}`;

  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      }
    }, res => {
      res.on("data", () => {});
      res.on("end", resolve);
    });

    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function loadState() {
  if (fs.existsSync(STATE_FILE)) {
    return JSON.parse(fs.readFileSync(STATE_FILE));
  }
  return { online: null, lastSent: 0 };
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state));
}

(async () => {
  const state = loadState();

  const token = await getToken();
  const online = await getOnline(token);

  if (state.online === false && online === true) {
    if (Date.now() - state.lastSent > COOLDOWN) {
      await sendTelegram("⚡ Свет вернулся. Можно выключать генератор.");
      state.lastSent = Date.now();
    }
  }

  state.online = online;
  saveState(state);
})();