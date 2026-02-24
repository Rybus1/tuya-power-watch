// watch.js (CommonJS)
// Env vars required:
// TUYA_CLIENT_ID, TUYA_CLIENT_SECRET, TUYA_DEVICE_ID
// TG_BOT_TOKEN, TG_CHAT_ID

const crypto = require("crypto");
const https = require("https");
const fs = require("fs");

const HOST = "openapi.tuyaeu.com"; // EU
const CLIENT_ID = process.env.TUYA_CLIENT_ID;
const CLIENT_SECRET = process.env.TUYA_CLIENT_SECRET;
const DEVICE_ID = process.env.TUYA_DEVICE_ID;

const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;

const STATE_FILE = "state.json";

// антиспам (между уведомлениями о смене статуса)
const COOLDOWN_MS = 10 * 60 * 1000; // 10 минут
// антидребезг: сколько подряд одинаковых статусов нужно, чтобы считать его "настоящим"
const STABLE_REQUIRED = 2;

// ВРЕМЕННО для отладки можешь поставить так:
// const COOLDOWN_MS = 0;
// const STABLE_REQUIRED = 1;

function sha256(str) {
  return crypto.createHash("sha256").update(str).digest("hex");
}

function hmacSha256(key, str) {
  return crypto.createHmac("sha256", key).update(str).digest("hex").toUpperCase();
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch (_) {
    return {
      confirmedStatus: null,      // "ONLINE" | "OFFLINE"
      pendingStatus: null,        // "ONLINE" | "OFFLINE"
      pendingCount: 0,
      lastNotifyAt: 0
    };
  }
}

function writeState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function httpsRequest({ method, hostname, path, headers, body }) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      { method, hostname, path, headers },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          let json;
          try {
            json = JSON.parse(data);
          } catch (e) {
            return reject(new Error(`Non-JSON response: ${data}`));
          }
          resolve({ statusCode: res.statusCode, json });
        });
      }
    );

    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

// Tuya signature (упрощённая, рабочая для большинства cloud вызовов)
function buildTuyaSign({ method, path, bodyStr, accessToken }) {
  const t = Date.now().toString();
  const bodyHash = sha256(bodyStr || "");
  const stringToSign = `${method}\n${bodyHash}\n\n${path}`;
  const signStr = CLIENT_ID + (accessToken || "") + t + stringToSign;
  const sign = hmacSha256(CLIENT_SECRET, signStr);
  return { t, sign };
}

async function tuyaRequest({ method, path, bodyObj, accessToken }) {
  const bodyStr = bodyObj ? JSON.stringify(bodyObj) : "";
  const { t, sign } = buildTuyaSign({ method, path, bodyStr, accessToken });

  const headers = {
    "client_id": CLIENT_ID,
    "sign_method": "HMAC-SHA256",
    "t": t,
    "sign": sign,
    "mode": "cors",
    "Content-Type": "application/json"
  };

  if (accessToken) headers["access_token"] = accessToken;

  const { statusCode, json } = await httpsRequest({
    method,
    hostname: HOST,
    path,
    headers,
    body: bodyStr || undefined
  });

  if (!json || json.success === false) {
    throw new Error(
      `Tuya API error (HTTP ${statusCode}): ${JSON.stringify(json)}`
    );
  }

  return json;
}

async function getAccessToken() {
  // Tuya обычно даёт токен через /v1.0/token?grant_type=1
  const res = await tuyaRequest({
    method: "GET",
    path: "/v1.0/token?grant_type=1",
    bodyObj: null,
    accessToken: ""
  });

  const token = res?.result?.access_token;
  if (!token) throw new Error(`No access_token in response: ${JSON.stringify(res)}`);
  return token;
}

async function getDeviceOnline(accessToken) {
  const res = await tuyaRequest({
    method: "GET",
    path: `/v2.0/cloud/thing/${DEVICE_ID}`,
    bodyObj: null,
    accessToken
  });

  const isOnline = res?.result?.is_online;
  if (typeof isOnline !== "boolean") {
    throw new Error(`No is_online in response: ${JSON.stringify(res)}`);
  }
  return { isOnline, raw: res.result };
}

async function sendTelegram(text) {
  if (!TG_BOT_TOKEN || !TG_CHAT_ID) {
    console.log("Telegram env missing, skip TG:", text);
    return;
  }

  const safeText = String(text);
  const path =
    `/bot${TG_BOT_TOKEN}/sendMessage?chat_id=${encodeURIComponent(TG_CHAT_ID)}` +
    `&text=${encodeURIComponent(safeText)}` +
    `&disable_web_page_preview=true`;

  const { statusCode, json } = await httpsRequest({
    method: "GET",
    hostname: "api.telegram.org",
    path,
    headers: {}
  });

  if (!json?.ok) {
    throw new Error(`Telegram error (HTTP ${statusCode}): ${JSON.stringify(json)}`);
  }
}

function nowIso() {
  return new Date().toISOString();
}

async function main() {
  if (!CLIENT_ID || !CLIENT_SECRET || !DEVICE_ID) {
    throw new Error("Missing TUYA env vars (TUYA_CLIENT_ID / TUYA_CLIENT_SECRET / TUYA_DEVICE_ID)");
  }

  // 1) стартовый пинг
  await sendTelegram(`✅ workflow started: ${nowIso()}`);

  // 2) читаем state
  const state = readState();
  console.log("Loaded state:", state);

  // 3) Tuya token
  console.log("Getting Tuya token...");
  const accessToken = await getAccessToken();
  console.log("Got token (len):", accessToken.length);

  // 4) статус девайса
  console.log("Fetching device status...");
  const { isOnline, raw } = await getDeviceOnline(accessToken);
  const currentStatus = isOnline ? "ONLINE" : "OFFLINE";

  // ДЕБАГ: в консоль + временно в Telegram
  console.log("TUYA current status =", currentStatus, "time", nowIso());
  console.log("Device raw:", {
    name: raw?.name,
    id: raw?.id,
    ip: raw?.ip,
    is_online: raw?.is_online,
    update_time: raw?.update_time
  });

  await sendTelegram(`📡 TUYA status now: ${currentStatus} (${nowIso()})`);

  // 5) антидребезг: подтверждаем смену только после N одинаковых чтений
  if (state.pendingStatus === currentStatus) {
    state.pendingCount += 1;
  } else {
    state.pendingStatus = currentStatus;
    state.pendingCount = 1;
  }

  console.log("Pending:", state.pendingStatus, "count:", state.pendingCount);

  const canConfirm = state.pendingCount >= STABLE_REQUIRED;
  if (!canConfirm) {
    writeState(state);
    console.log("Not stable yet, state saved.");
    return;
  }

  // 6) если подтверждённый статус изменился — шлём уведомление (с cooldown)
  const prevConfirmed = state.confirmedStatus;
  const nextConfirmed = currentStatus;

  if (prevConfirmed === null) {
    // первый запуск — просто зафиксируем
    state.confirmedStatus = nextConfirmed;
    writeState(state);
    console.log("First confirm, saved confirmedStatus =", nextConfirmed);
    return;
  }

  if (prevConfirmed !== nextConfirmed) {
    const now = Date.now();
    const since = now - (state.lastNotifyAt || 0);

    if (since < COOLDOWN_MS) {
      console.log("Cooldown active, skip notify. since(ms) =", since);
      // всё равно обновим confirmed статус, чтобы не спамить позже старым событием
      state.confirmedStatus = nextConfirmed;
      writeState(state);
      return;
    }

    const emoji = nextConfirmed === "ONLINE" ? "✅" : "⚠️";
    const msg = `${emoji} Device ${raw?.name || DEVICE_ID}: ${prevConfirmed} → ${nextConfirmed} (${nowIso()})`;

    console.log("STATUS CHANGED:", msg);
    await sendTelegram(msg);

    state.confirmedStatus = nextConfirmed;
    state.lastNotifyAt = now;
    writeState(state);
    return;
  }

  // 7) статус не поменялся
  state.confirmedStatus = nextConfirmed;
  writeState(state);
  console.log("No change. confirmedStatus =", nextConfirmed);
}

main().catch(async (err) => {
  console.error("ERROR:", err);
  try {
    await sendTelegram(`❌ watch error: ${err.message || err}`);
  } catch (_) {}
  process.exit(1);
});