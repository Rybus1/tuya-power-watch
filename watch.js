// watch.js (CommonJS)
// Env: TUYA_CLIENT_ID, TUYA_CLIENT_SECRET, TUYA_DEVICE_ID, TG_BOT_TOKEN, TG_CHAT_ID

const crypto = require("crypto");
const https = require("https");
const fs = require("fs");

const HOST = "openapi.tuyaeu.com";
const CLIENT_ID = process.env.TUYA_CLIENT_ID;
const CLIENT_SECRET = process.env.TUYA_CLIENT_SECRET;
const DEVICE_ID = process.env.TUYA_DEVICE_ID;
const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;
const LOCATION_NAME = "Вілла Риба";
const STATE_FILE = "state.json";

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
    return { lastStatus: null, lastStatusAt: null, lastProcessedUpdateId: null };
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
    method, hostname: HOST, path, headers,
    body: bodyStr || undefined
  });
  if (!json || json.success === false) {
    throw new Error(`Tuya API error (HTTP ${statusCode}): ${JSON.stringify(json)}`);
  }
  return json;
}

async function getAccessToken() {
  const res = await tuyaRequest({
    method: "GET",
    path: "/v1.0/token?grant_type=1",
    bodyObj: null,
    accessToken: ""
  });
  const token = res?.result?.access_token;
  if (!token) throw new Error(`No access_token: ${JSON.stringify(res)}`);
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
    throw new Error(`No is_online: ${JSON.stringify(res)}`);
  }
  return { isOnline, raw: res.result };
}

async function sendTelegram(text) {
  if (!TG_BOT_TOKEN || !TG_CHAT_ID) return;
  await sendTelegramTo(TG_CHAT_ID, text);
}

async function sendTelegramTo(chatId, text) {
  if (!TG_BOT_TOKEN) return;
  const path =
    `/bot${TG_BOT_TOKEN}/sendMessage?chat_id=${encodeURIComponent(chatId)}` +
    `&text=${encodeURIComponent(String(text))}` +
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

async function getTelegramUpdates(offset) {
  if (!TG_BOT_TOKEN) return { result: [] };
  const path = `/bot${TG_BOT_TOKEN}/getUpdates?offset=${offset}&timeout=0`;
  const { json } = await httpsRequest({
    method: "GET",
    hostname: "api.telegram.org",
    path,
    headers: {}
  });
  return json?.result ?? [];
}

function formatDateUk(d, withSeconds = true) {
  const date = d instanceof Date ? d : new Date(d);
  const opts = { timeZone: "Europe/Kyiv", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false };
  if (withSeconds) opts.second = "2-digit";
  const parts = new Intl.DateTimeFormat("uk-UA", opts).formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type)?.value ?? "";
  const time = withSeconds ? `${get("hour")}:${get("minute")}:${get("second")}` : `${get("hour")}:${get("minute")}`;
  return `${get("day")}.${get("month")}.${get("year")} час ${time}`;
}

function formatDateUkStatus(d) {
  const date = d instanceof Date ? d : new Date(d);
  const opts = { timeZone: "Europe/Kyiv", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false };
  const parts = new Intl.DateTimeFormat("uk-UA", opts).formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type)?.value ?? "";
  return `о ${get("hour")}:${get("minute")} годині ${get("day")}.${get("month")}.${get("year")}`;
}

function formatDurationUk(ms) {
  if (ms < 0 || !Number.isFinite(ms)) return "";
  const totalMins = Math.max(0, Math.floor(ms / 60000));
  const hours = Math.floor(totalMins / 60);
  const mins = totalMins % 60;
  const parts = [];
  if (hours > 0) {
    const h = hours === 1 ? "годину" : hours < 5 ? "години" : "годин";
    parts.push(`${hours} ${h}`);
  }
  if (mins > 0) {
    const m = mins === 1 ? "хвилину" : mins < 5 ? "хвилини" : "хвилин";
    parts.push(`${mins} ${m}`);
  }
  if (parts.length === 0) return "менше хвилини";
  return parts.join(" ");
}

async function main() {
  if (!CLIENT_ID || !CLIENT_SECRET || !DEVICE_ID) {
    throw new Error("Missing TUYA env (TUYA_CLIENT_ID / TUYA_CLIENT_SECRET / TUYA_DEVICE_ID)");
  }

  const state = readState();
  const accessToken = await getAccessToken();
  const { isOnline } = await getDeviceOnline(accessToken);
  const currentStatus = isOnline ? "ONLINE" : "OFFLINE";
  const prevStatus = state.lastStatus ?? state.confirmedStatus ?? null;
  const now = Date.now();
  const lastStatusAt = state.lastStatusAt ?? now;

  const nextState = { ...state, lastStatus: currentStatus, lastStatusAt: prevStatus !== null && prevStatus !== currentStatus ? now : (prevStatus === currentStatus ? lastStatusAt : now) };

  if (prevStatus !== null && prevStatus !== currentStatus) {
    const dt = formatDateUk(new Date(), false);
    const durationMs = state.lastStatusAt != null ? now - lastStatusAt : NaN;
    const durationStr = formatDurationUk(durationMs);
    const isOnlineNow = currentStatus === "ONLINE";
    const emoji = isOnlineNow ? "✅" : "❌";
    const line1 = `${emoji} СВІТЛО ${isOnlineNow ? "З'ЯВИЛОСЯ" : "ЗНИКЛО"} — ${dt}`;
    const line2 = durationStr
      ? (isOnlineNow ? `Його не було ${durationStr}` : `Воно було ${durationStr}`)
      : "";
    const text = line2 ? `${line1}\n${line2}` : line1;
    await sendTelegram(text);
    nextState.lastStatusAt = now;
  }

  const durationMs = now - (nextState.lastStatusAt ?? now);
  const durationStr = formatDurationUk(durationMs);

  const updates = await getTelegramUpdates((state.lastProcessedUpdateId ?? 0) + 1);
  let maxUpdateId = state.lastProcessedUpdateId ?? 0;
  for (const u of updates) {
    if (u.update_id > maxUpdateId) maxUpdateId = u.update_id;
    const msg = u.message;
    if (!msg?.text || msg.text.trim() !== "/status") continue;
    const chatId = msg.chat?.id;
    if (!chatId) continue;
    const dtStr = formatDateUkStatus(new Date());
    const hasLight = currentStatus === "ONLINE";
    const statusLine = hasLight
      ? `Є СВІТЛО. Воно там є вже протягом ${durationStr}.`
      : `НЕМАЄ СВІТЛА. Його нема вже протягом ${durationStr}.`;
    const reply = `Зараз, ${dtStr} у ${LOCATION_NAME} ${statusLine}`;
    await sendTelegramTo(chatId, reply);
  }
  nextState.lastProcessedUpdateId = maxUpdateId;
  writeState(nextState);
}

main().catch(async (err) => {
  console.error("watch error:", err.message || err);
  try {
    await sendTelegram(`❌ Помилка: ${err.message || err}`);
  } catch (_) {}
  process.exit(1);
});
