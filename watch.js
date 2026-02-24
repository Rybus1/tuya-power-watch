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

// антиспам
const COOLDOWN_MS = 10 * 60 * 1000; // 10 минут
const STABLE_REQUIRED = 2;

function sha256(str) {
  return crypto.createHash("sha256").update(str).digest("hex");
}

function sendTelegram(text) {
  return new Promise((resolve, reject) => {
    if (!TG_BOT_TOKEN || !TG_CHAT_ID) {
      console.log("⚠️ TG creds missing, skip telegram:", text);
      return resolve();
    }

    const data = JSON.stringify({
      chat_id: TG_CHAT_ID,
      text,
      disable_web_page_preview: true,
    });

    const req = https.request(
      {
        hostname: "api.telegram.org",
        path: `/bot${TG_BOT_TOKEN}/sendMessage`,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(data),
        },
      },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => {
          console.log("TG status:", res.statusCode, body.slice(0, 200));
          resolve();
        });
      }
    );

    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

async function main() {
  console.log("Started", new Date().toISOString());

  await sendTelegram(`✅ workflow started: ${new Date().toISOString()}`);

  // TODO: дальше твоя логика опроса Tuya + сравнение статуса + запись state.json
}

main().catch(async (e) => {
  console.error("❌ Fatal:", e);
  try {
    await sendTelegram(`❌ Fatal error: ${String(e.message || e)}`);
  } catch (_) {}
  process.exit(1);
});