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

await sendTelegram(`✅ workflow started: ${new Date().toISOString()}`);

// антиспам
const COOLDOWN_MS = 10 * 60 * 1000; // 10 минут
// антидребезг: сколько подряд одинаковых статусов нужно, чтобы считать его "настоящим"
const STABLE_REQUIRED = 2;

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
        ...(token && { access_token: token }),
      },
    };

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error("Failed to parse JSON: " + data));
        }
      });
    });

    req.on("error", reject);
    req.end();
  });
}

async function getToken() {
  const res = await request("GET", "/v1.0/token?grant_type=1");
  if (!res.success) throw new Error("Tuya token error: " + JSON.stringify(res));
  return res.result.access_token;
}

async function getOnline(token) {
  const res = await request("GET", `/v2.0/cloud/thing/${DEVICE_ID}`, token);
  if (!res.success) throw new Error("Tuya device error: " + JSON.stringify(res));
  return !!res.result.is_online;
}

function sendTelegram(text) {
  const url = `https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`;
  const body = `chat_id=${TG_CHAT_ID}&text=${encodeURIComponent(text)}`;

  return new Promise((resolve, reject) => {
    const req = https.request(
      url,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      },
      (res) => {
        res.on("data", () => {});
        res.on("end", resolve);
      }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function loadState() {
  if (fs.existsSync(STATE_FILE)) {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  }
  return {
    // "подтвержденный" (стабильный) статус, на который реагируем
    stableOnline: null,

    // для антидребезга:
    lastRaw: null,
    rawStreak: 0,

    // антиспам:
    lastSentOnline: 0,
    lastSentOffline: 0,
  };
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function canSend(now, lastSent) {
  return now - lastSent > COOLDOWN_MS;
}

(async () => {
  const state = loadState();

  const token = await getToken();
  const rawOnline = await getOnline(token);

  // антидребезг: считаем, сколько раз подряд пришёл один и тот же raw статус
  if (state.lastRaw === rawOnline) {
    state.rawStreak += 1;
  } else {
    state.lastRaw = rawOnline;
    state.rawStreak = 1;
  }

  // если статус ещё не стабилизировался — просто сохраняем и выходим
  if (state.rawStreak < STABLE_REQUIRED) {
    saveState(state);
    return;
  }

  const now = Date.now();

  // первый стабильный запуск — просто запоминаем без уведомления
  if (state.stableOnline === null) {
    state.stableOnline = rawOnline;
    saveState(state);
    return;
  }

  // переходы
  if (state.stableOnline === false && rawOnline === true) {
    // OFFLINE -> ONLINE
    if (canSend(now, state.lastSentOnline)) {
      await sendTelegram("⚡ Свет от столба ВЕРНУЛСЯ. Можно выключать генератор и переключаться обратно.");
      state.lastSentOnline = now;
    }
    state.stableOnline = true;
  } else if (state.stableOnline === true && rawOnline === false) {
    // ONLINE -> OFFLINE
    if (canSend(now, state.lastSentOffline)) {
      await sendTelegram("🚫 Свет от столба ПРОПАЛ. Если нужно — можно запускать генератор.");
      state.lastSentOffline = now;
    }
    state.stableOnline = false;
  }

  saveState(state);
})().catch((e) => {
  // чтобы в логах GitHub было видно причину падения
  console.error(e);
  process.exit(1);
});