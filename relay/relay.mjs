// clicky-relay — VM-side relay daemon for the HeyClicky clone backend.
//
// The Cloudflare Worker holds NO Gemini key. This daemon opens a persistent
// OUTBOUND WebSocket to the Worker's Durable Object and executes model jobs
// (chat / tts / stt) by calling Gemini through the Muse connector layer:
// an `hsurr:*` surrogate is fetched from authd per attempt and the egress
// layer swaps it for the real key. No key value is ever stored, printed,
// or logged here — only connector names and expiry-free metadata.
//
// Rotation (locked rule): Fisher-Yates shuffle over custom.gemini-1..9 +
// custom.gemini, never start on the previously used connector, rotate on
// 401/403/429/503, quarantine a failed connector for 30 min.
// Models (user-locked): chat gemini-3.8-flash -> gemini-3.5-flash-lite
// fallback; STT gemini-3.5-transcribe; TTS gemini-2.5-flash-preview-tts.
//
// Config: environment RELAY_URL, RELAY_SECRET (via systemd
// EnvironmentFile ~/.config/clicky-relay/relay.env, 0600).
// State: ./state/last-connector.txt, ./state/quarantine.json (connector
// names + expiry only — never key material).
//
// Node >= 22, no dependencies (global WebSocket + fetch, net for authd).

import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_DIR = path.join(__dirname, "state");
const LAST_CONNECTOR_FILE = path.join(STATE_DIR, "last-connector.txt");
const QUARANTINE_FILE = path.join(STATE_DIR, "quarantine.json");

const RELAY_URL =
  process.env.RELAY_URL ||
  "wss://clicky-clone-backend.shrihari52141.workers.dev/relay";
const RELAY_SECRET = (process.env.RELAY_SECRET || "").trim();
if (!RELAY_SECRET) {
  console.error("FATAL: RELAY_SECRET is not set (EnvironmentFile ~/.config/clicky-relay/relay.env)");
  process.exit(1);
}

const AUTHD_SOCKET = process.env.JARVIS_AUTHD_SOCK || "/run/hatch/auth/authd.sock";
const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models";
const CONNECTORS = [
  ...Array.from({ length: 9 }, (_, i) => `custom.gemini-${i + 1}`),
  "custom.gemini",
];
const CHAT_MODELS = ["gemini-3.8-flash", "gemini-3.5-flash-lite"];
const TTS_MODELS = ["gemini-2.5-flash-preview-tts"];
const STT_MODELS = ["gemini-3.5-transcribe"];
const ROTATABLE = new Set([401, 403, 429, 503]);
const QUARANTINE_MS = 30 * 60 * 1000; // 30 min per failed connector
const GEMINI_TIMEOUT_MS = 10000; // per Gemini attempt; normal answers land in 1-6 s
const JOB_DEADLINE_MS = 75000; // whole job must answer before the DO's 90 s timeout

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

// --- authd surrogate exchange (mirrors dynamic_credentials.py) ---------
function surrogateFor(connector) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ name: connector });
    const req =
      `POST /v1/credentials/surrogate HTTP/1.1\r\n` +
      `Host: authd.local\r\n` +
      `Content-Type: application/json\r\n` +
      `Content-Length: ${Buffer.byteLength(body)}\r\n` +
      `Connection: close\r\n\r\n` + body;
    const sock = net.createConnection(AUTHD_SOCKET);
    const chunks = [];
    let done = false;
    const fail = (err) => {
      if (done) return;
      done = true;
      try { sock.destroy(); } catch {}
      reject(err);
    };
    sock.setTimeout(10000, () => fail(new Error(`authd timeout for ${connector}`)));
    sock.on("error", (e) => fail(new Error(`authd socket error for ${connector}: ${e.message}`)));
    sock.on("connect", () => sock.write(req));
    sock.on("data", (c) => chunks.push(c));
    sock.on("end", () => {
      if (done) return;
      done = true;
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        const sep = raw.indexOf("\r\n\r\n");
        if (sep < 0) throw new Error("authd malformed response");
        const status = parseInt(raw.split(" ")[1], 10);
        const payload = JSON.parse(raw.slice(sep + 4));
        if (status !== 200) throw new Error(`authd HTTP ${status}`);
        const entry = (payload.credentials || []).find((e) => e.name === "access_token");
        const surrogate = entry && String(entry.surrogate || "");
        if (!surrogate.startsWith("hsurr:")) throw new Error(`no surrogate for ${connector}`);
        // Placement is a custom header (x-goog-api-key); never log the value.
        resolve(surrogate);
      } catch (e) {
        reject(new Error(`surrogate failed for ${connector}: ${e.message}`));
      }
    });
  });
}

// --- rotation state ------------------------------------------------------
function loadQuarantine() {
  try {
    const data = JSON.parse(fs.readFileSync(QUARANTINE_FILE, "utf8"));
    const now = Date.now();
    const out = {};
    for (const [k, v] of Object.entries(data)) {
      if (typeof v === "number" && v > now) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}
function saveQuarantine(q) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(QUARANTINE_FILE, JSON.stringify(q));
  } catch (e) {
    log("WARN quarantine save failed:", e.message);
  }
}
function shuffledOrder() {
  const order = [...CONNECTORS];
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  try {
    const last = fs.readFileSync(LAST_CONNECTOR_FILE, "utf8").trim();
    if (order.length > 1 && order[0] === last) [order[0], order[1]] = [order[1], order[0]];
  } catch {}
  const q = loadQuarantine();
  const usable = order.filter((c) => !(c in q));
  return usable.length ? usable : order;
}
function rememberConnector(name) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(LAST_CONNECTOR_FILE, name);
  } catch {}
}
function quarantine(connector) {
  const q = loadQuarantine();
  q[connector] = Date.now() + QUARANTINE_MS;
  saveQuarantine(q);
}

// --- Gemini call with rotation -------------------------------------------
function geminiText(data) {
  let text = "";
  for (const c of data?.candidates || []) {
    for (const p of c?.content?.parts || []) {
      if (typeof p.text === "string") text += p.text;
    }
  }
  return text;
}

async function callGemini(models, payload, deadline) {
  const order = shuffledOrder();
  let lastStatus = 502;
  let lastError = "gemini_unavailable";
  for (const model of models) {
    for (const connector of order) {
      if (Date.now() > deadline) {
        const err = new Error(lastError);
        err.status = lastStatus === 429 || lastStatus === 503 ? 503 : lastStatus;
        err.rateLimited = lastStatus === 429 || lastStatus === 503;
        throw err;
      }
      let surrogate;
      try {
        surrogate = await surrogateFor(connector);
      } catch (e) {
        lastError = "surrogate_failed";
        log(`  surrogate fail ${connector}: ${e.message}`);
        continue;
      }
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), GEMINI_TIMEOUT_MS);
      let res;
      try {
        res = await fetch(`${GEMINI_BASE}/${encodeURIComponent(model)}:generateContent`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-goog-api-key": surrogate },
          body: JSON.stringify(payload),
          signal: ctrl.signal,
        });
      } catch (e) {
        clearTimeout(timer);
        lastError = "gemini_unavailable";
        log(`  ${model} ${connector} network/timeout: ${e.name}`);
        continue; // treat as rotatable
      }
      clearTimeout(timer);
      let data = null;
      try { data = await res.json(); } catch {}
      if (res.ok) {
        rememberConnector(connector);
        return { data, model, connector };
      }
      lastStatus = res.status;
      lastError = res.status === 429 || res.status === 503 ? "provider_rate_limited" : "gemini_error";
      log(`  ${model} ${connector} HTTP ${res.status}`);
      if (ROTATABLE.has(res.status)) {
        quarantine(connector);
        continue;
      }
      if (res.status === 400) {
        // 400 "API key not valid" is a per-key failure (a dead key in the
        // pool), NOT a payload problem: quarantine that connector and
        // rotate. Any other 400 is a bad payload: stop immediately so one
        // malformed request cannot quarantine the whole pool.
        const msg = (data && data.error && data.error.message) || "";
        if (/API key not valid/i.test(msg)) {
          quarantine(connector);
          continue;
        }
      }
      const err = new Error(lastError);
      err.status = res.status;
      throw err;
    }
  }
  const err = new Error(lastError);
  err.status = lastStatus === 429 || lastStatus === 503 ? 503 : lastStatus;
  err.rateLimited = lastStatus === 429 || lastStatus === 503;
  throw err;
}

// --- job execution ---------------------------------------------------------
async function runJob(job) {
  const started = Date.now();
  if (job.kind === "chat") {
    const { data, model, connector } = await callGemini(CHAT_MODELS, job.payload, Date.now() + JOB_DEADLINE_MS);
    log(`job ${job.id} chat model=${model} connector=${connector} ${Date.now() - started}ms`);
    return { text: geminiText(data), model };
  }
  if (job.kind === "tts") {
    const { data, model, connector } = await callGemini(TTS_MODELS, job.payload, Date.now() + JOB_DEADLINE_MS);
    let audioBase64 = null;
    let mime = "audio/wav";
    for (const c of data?.candidates || []) {
      for (const p of c?.content?.parts || []) {
        if (p.inlineData && typeof p.inlineData.data === "string") {
          audioBase64 = p.inlineData.data;
          if (typeof p.inlineData.mimeType === "string") mime = p.inlineData.mimeType;
        }
      }
    }
    if (!audioBase64) {
      const err = new Error("tts_no_audio");
      err.status = 502;
      throw err;
    }
    log(`job ${job.id} tts model=${model} connector=${connector} audioB64Len=${audioBase64.length} ${Date.now() - started}ms`);
    return { audioBase64, mime, model };
  }
  if (job.kind === "stt") {
    const { data, model, connector } = await callGemini(STT_MODELS, job.payload, Date.now() + JOB_DEADLINE_MS);
    log(`job ${job.id} stt model=${model} connector=${connector} ${Date.now() - started}ms`);
    return { text: geminiText(data).trim(), model };
  }
  const err = new Error("unknown_job_kind");
  err.status = 400;
  throw err;
}

// --- WebSocket loop --------------------------------------------------------
let ws = null;
let helloOk = false;
let connectionId = null;
let reconnectDelay = 1000;
let pingTimer = null;
let shuttingDown = false;

function connect() {
  if (shuttingDown) return;
  log(`connecting to relay endpoint (host only, no secret in log)`);
  ws = new WebSocket(RELAY_URL);
  helloOk = false;

  ws.onopen = () => {
    log("websocket open, sending hello");
    reconnectDelay = 1000;
    ws.send(JSON.stringify({ type: "hello", secret: RELAY_SECRET }));
    // Re-send hello every 20 s: the Worker's Durable Object hibernates
    // when idle and loses its in-memory auth set, so the heartbeat both
    // keeps the socket alive and re-authenticates this connection.
    pingTimer = setInterval(() => {
      try { ws.send(JSON.stringify({ type: "hello", secret: RELAY_SECRET })); } catch {}
    }, 20000);
  };

  ws.onmessage = (event) => {
    let msg;
    try {
      msg = JSON.parse(typeof event.data === "string" ? event.data : Buffer.from(event.data).toString("utf8"));
    } catch {
      log("WARN ignoring non-JSON frame");
      return;
    }
    if (msg.type === "hello-ok") {
      helloOk = true;
      if (typeof msg.connectionId === "string") connectionId = msg.connectionId;
      log("hello accepted by Worker — relay registered");
      return;
    }
    if (msg.type === "auth-check" && typeof msg.nonce === "string") {
      // The Worker is verifying this socket is the genuine relay after
      // a hibernation wake: answer with the issued connectionId.
      try { ws.send(JSON.stringify({ type: "auth-ok", nonce: msg.nonce, connectionId })); } catch {}
      return;
    }
    if (msg.type === "ping") {
      try { ws.send(JSON.stringify({ type: "pong" })); } catch {}
      return;
    }
    if (msg.type === "pong") return;
    if (msg.type === "job") {
      const job = msg;
      log(`job ${job.id} kind=${job.kind} payloadBytes=${JSON.stringify(job.payload || {}).length}`);
      runJob(job)
        .then((result) => {
          try { ws.send(JSON.stringify({ type: "result", id: job.id, ok: true, result, connectionId })); } catch (e) { log(`job ${job.id} send failed: ${e.message}`); }
        })
        .catch((e) => {
          const error = e.message || "gemini_error";
          const status = e.status && e.status >= 400 && e.status < 600 ? e.status : 502;
          log(`job ${job.id} failed: ${error} status=${status}`);
          try { ws.send(JSON.stringify({ type: "result", id: job.id, ok: false, error, status, connectionId })); } catch {}
        });
      return;
    }
    log(`WARN unknown frame type: ${msg.type}`);
  };

  ws.onerror = (event) => {
    log("websocket error:", event.message || "unknown");
  };

  ws.onclose = (event) => {
    log(`websocket closed code=${event.code} reason=${event.reason || ""}`);
    if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
    helloOk = false;
    connectionId = null;
    ws = null;
    if (shuttingDown) return;
    const delay = reconnectDelay;
    reconnectDelay = Math.min(reconnectDelay * 2, 30000);
    const jitter = Math.floor(Math.random() * 1000);
    log(`reconnecting in ${delay + jitter}ms`);
    setTimeout(connect, delay + jitter);
  };
}

process.on("SIGTERM", () => {
  log("SIGTERM received, shutting down");
  shuttingDown = true;
  if (pingTimer) clearInterval(pingTimer);
  try { ws?.close(1000, "shutdown"); } catch {}
  setTimeout(() => process.exit(0), 500);
});
process.on("SIGINT", () => {
  shuttingDown = true;
  try { ws?.close(1000, "shutdown"); } catch {}
  setTimeout(() => process.exit(0), 500);
});

log("clicky-relay starting");
connect();
