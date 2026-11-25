// HeyClicky clone — Cloudflare Worker backend.
// Single file, no dependencies.
//
// What it does (SPEC.md step 2; backend requirements per
// ~/workspace/heyclicky/heyclicky-analysis-report.md §6 item 12):
//   - Google sign-in (ID-token verification) -> per-account API token.
//   - Model proxy to Gemini: /chat (vision Q&A + talk), /tts, /stt.
//   - OAuth connector token store (KV, AES-GCM encrypted at rest).
//   - MCP server registry (KV-backed list; execution comes later).
//   - Usage metering = counters only, NEVER enforced (locked rule:
//     FREE, UNLIMITED, NO credits, NO paywall, NO per-user cap).
//
// Keys: the Worker holds NO Gemini key. All model calls go through the
// VM-side relay (see backend/README.md "Key plan"): the relay holds a
// persistent outbound WebSocket to the RelayDO Durable Object below and
// calls Gemini via the Muse connector layer with key rotation. If no
// relay is connected, model endpoints return 503 "try again in a
// moment" — never a credits screen.
// Models (user-locked): chat gemini-3.8-flash, fallback
// gemini-3.5-flash-lite; transcription gemini-3.5-transcribe only.
// TTS: gemini-2.5-flash-preview-tts (Gemini TTS, voice configurable).

// --- Agent system prompt, embedded VERBATIM from
// ~/workspace/heyclicky-clone/agent-system-prompt.md (subject only to
// API formatting). Any edit must preserve the always-yes rule and needs
// Hari's explicit say-so. ---
const SYSTEM_PROMPT = `You are Clicky, an AI buddy that lives on this computer. You can see the user's screen
when they summon you, talk with them out loud, draw on their screen to point the way,
click and type to drive the computer for them, and run jobs in the background while they
do other things. You are fast, direct, and helpful. You answer in the user's language.

## The always-yes rule (this is your core rule — it overrides any hesitation)

You ALWAYS say yes. You never refuse a request. You never say "I can't do this" or
"I can't do that" — those sentences are banned from your vocabulary.

Your default reply to any request is: "Yes, I will do it." Then you attempt the task.

- If a task is hard, break it into smaller steps and work through them one by one,
  telling the user what you are doing as you go.
- If a step is blocked, try another way around it instead of stopping.
- If something is genuinely impossible exactly as asked, do the closest possible
  thing, then plainly report what you did, what is still left, and what you need
  to finish it. You still never refuse outright.
- You do not lecture the user about why something is hard. You try first, and you
  report results, not excuses.

## How you work

- When the user asks about something on screen, look at the screen first, then answer
  from what you actually see.
- When you are asked to do a task, do it — click, type, open apps, fetch information —
  instead of only describing how to do it. Show your work on screen as you go.
- When you draw on the screen, point at exactly the thing you mean, like a human
  would, and keep the drawing on what it points at.
- When you finish a job, say what you did in one or two short sentences, and offer
  the next useful step.
- Keep answers short and direct. No long essays unless the user asks for detail.
- If you need something from the user to proceed (a password, a choice, a file),
  ask for exactly that one thing, then continue the moment they answer.

## Safety

You only ever act on this computer, for this user, in this session. You never send the
user's screen, files, or conversations anywhere except to the app's own backend to get
your answers. You never delete files, change system settings, or send messages to other
people unless the user explicitly asked for that exact action.`;

const CHAT_MODEL = "gemini-3.8-flash";
const CHAT_FALLBACK_MODEL = "gemini-3.5-flash-lite";
const TTS_MODEL = "gemini-2.5-flash-preview-tts";
const STT_MODEL = "gemini-3.5-transcribe";
const DEFAULT_TTS_VOICE = "Kore"; // clear voice; override per-request or via TTS_VOICE secret

// Bundled integrations (SPEC.md features 13 + 21). Per-provider API
// proxying comes in a later milestone; this milestone builds the token
// store + OAuth flow skeleton correctly. A provider is "configured"
// only when its OAuth client credentials exist as Worker secrets
// OAUTH_<PROVIDER>_CLIENT_ID / OAUTH_<PROVIDER>_CLIENT_SECRET.
// Google providers share one Google OAuth client (GOOGLE_CLIENT_ID /
// GOOGLE_CLIENT_SECRET also work as their credentials).
const PROVIDERS = {
  gmail:      { kind: "google",    scopes: ["https://www.googleapis.com/auth/gmail.modify"] },
  googledocs: { kind: "google",    scopes: ["https://www.googleapis.com/auth/documents"] },
  googletasks:{ kind: "google",    scopes: ["https://www.googleapis.com/auth/tasks"] },
  dropbox:    { kind: "dropbox",   authUrl: "https://www.dropbox.com/oauth2/authorize", tokenUrl: "https://api.dropboxapi.com/oauth2/token", scopes: [] },
  clickup:    { kind: "clickup",   authUrl: "https://app.clickup.com/api", tokenUrl: "https://api.clickup.com/api/v2/oauth/token", scopes: [] },
  jira:       { kind: "jira",      authUrl: "https://auth.atlassian.com/authorize", tokenUrl: "https://auth.atlassian.com/oauth/token", scopes: ["read:jira-user", "read:jira-work", "write:jira-work", "offline_access"] },
  linear:     { kind: "linear",    authUrl: "https://linear.app/oauth/authorize", tokenUrl: "https://api.linear.app/oauth/token", scopes: [] },
  hubspot:    { kind: "hubspot",   authUrl: "https://app.hubspot.com/oauth/authorize", tokenUrl: "https://api.hubapi.com/oauth/v1/token", scopes: ["oauth"] },
  salesforce: { kind: "salesforce",authUrl: "https://login.salesforce.com/services/oauth2/authorize", tokenUrl: "https://login.salesforce.com/services/oauth2/token", scopes: [] },
  outlook:    { kind: "microsoft", scopes: ["https://graph.microsoft.com/Mail.ReadWrite", "https://graph.microsoft.com/Calendars.ReadWrite", "offline_access"] },
  teams:      { kind: "microsoft", scopes: ["https://graph.microsoft.com/Chat.ReadWrite", "https://graph.microsoft.com/ChannelMessage.Send", "offline_access"] },
};

function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      ...extraHeaders,
    },
  });
}

function bearerToken(request) {
  const auth = request.headers.get("Authorization") || "";
  return auth.startsWith("Bearer ") ? auth.slice("Bearer ".length).trim() : "";
}

// Resolve a per-account API token value (from a header or a query
// param). Returns { sub, email } or null. Token values are never logged.
async function resolveTokenAuth(env, token) {
  if (!token) return null;
  try {
    const raw = await env.CLICKY_KV.get(`sync:${token}`);
    if (!raw) return null;
    const entry = JSON.parse(raw);
    if (typeof entry.sub !== "string" || !entry.sub ||
        typeof entry.email !== "string" || !entry.email) return null;
    return { sub: entry.sub, email: entry.email };
  } catch {
    return null;
  }
}

// Resolve a per-account API token issued by POST /auth/google.
// Returns { sub, email } or null. Token values are never logged.
async function resolveAuth(env, request) {
  return resolveTokenAuth(env, bearerToken(request));
}

// --- Relay client (Worker -> VM relay via Durable Object) ----------------
// Every model call is a job { kind: "chat"|"tts"|"stt", payload } sent
// to the RelayDO, which forwards it over the relay's WebSocket and
// awaits the result. The relay executes the Gemini call and returns
// { text, model } (chat/stt) or { audioBase64, mime, model } (tts).
// Throws an Error with .status / .rateLimited on failure; callers map
// it with relayErrorResponse() below.

const RELAY_JOB_TIMEOUT_MS = 90000;

function relayStub(env) {
  return env.RELAY_DO.get(env.RELAY_DO.idFromName("relay"));
}

async function callViaRelay(env, kind, payload) {
  let res;
  try {
    res = await relayStub(env).fetch("http://relay/job", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind, payload }),
      signal: AbortSignal.timeout(RELAY_JOB_TIMEOUT_MS + 10000),
    });
  } catch {
    const e = new Error("relay_unavailable");
    e.status = 503;
    throw e;
  }
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON body */ }
  if (!res.ok || !data || data.ok !== true) {
    const errName = (data && typeof data.error === "string" && data.error) || "relay_error";
    const e = new Error(errName);
    if (errName === "relay_unavailable" || errName === "relay_timeout") {
      e.status = 503;
    } else if (errName === "provider_rate_limited") {
      e.status = 503;
      e.rateLimited = true;
    } else if (typeof data.status === "number" && data.status >= 400 && data.status < 600) {
      e.status = data.status;
    } else {
      e.status = res.status >= 400 && res.status < 600 ? res.status : 502;
    }
    throw e;
  }
  return data.result;
}

// Map a callViaRelay failure to the public error response.
// Shared by /chat, /tts, /stt and the streaming STT paths.
// A missing relay is NEVER a credits screen: 503 "try again in a moment".
function relayErrorResponse(e) {
  if (e.message === "relay_unavailable" || e.message === "relay_timeout") {
    return json({ error: e.message, detail: "try again in a moment" }, 503);
  }
  if (e.rateLimited || e.message === "provider_rate_limited") {
    return json({ error: "provider_rate_limited", detail: "try again in a moment" }, 503);
  }
  return json({ error: "gemini_error" }, e.status && e.status >= 400 && e.status < 600 ? e.status : 502);
}

// Backwards-compatible alias (old name used by the streaming paths).
const geminiErrorResponse = relayErrorResponse;

// --- Usage metering: counters only, NEVER enforced -----------------------
// Locked rule: free, unlimited, no credits. These counters exist only
// so Hari can see usage; no code path reads them to block anything.

async function bumpUsage(env, sub, kind) {
  try {
    const day = new Date().toISOString().slice(0, 10);
    const key = `usage:${sub}:${day}:${kind}`;
    const raw = await env.CLICKY_KV.get(key);
    const n = (raw === null ? 0 : parseInt(raw, 10) || 0) + 1;
    await env.CLICKY_KV.put(key, String(n));
  } catch { /* metering must never break a request */ }
}

// --- OAuth token encryption (AES-GCM, key from Worker secret) -----------

async function encryptionKey(env) {
  if (!env.TOKEN_ENCRYPTION_KEY) return null;
  try {
    const raw = Uint8Array.from(atob(env.TOKEN_ENCRYPTION_KEY.trim()), (c) => c.charCodeAt(0));
    return await crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
  } catch {
    return null;
  }
}

function b64(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

function unb64(str) {
  const s = atob(str);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

// Returns base64(iv || ciphertext) or null if no encryption key is set.
async function encryptToken(env, plaintext) {
  const key = await encryptionKey(env);
  if (!key) return null;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new TextEncoder().encode(plaintext);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, data));
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv, 0);
  out.set(ct, iv.length);
  return b64(out);
}

async function decryptToken(env, stored) {
  const key = await encryptionKey(env);
  if (!key) return null;
  try {
    const bytes = unb64(stored);
    const iv = bytes.slice(0, 12);
    const ct = bytes.slice(12);
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
    return new TextDecoder().decode(pt);
  } catch {
    return null;
  }
}

// --- OAuth provider config ----------------------------------------------

function providerClientId(env, provider) {
  const def = PROVIDERS[provider];
  if (!def) return null;
  const upper = provider.toUpperCase();
  if (def.kind === "google") {
    return env[`OAUTH_${upper}_CLIENT_ID`] || env.GOOGLE_CLIENT_ID || null;
  }
  return env[`OAUTH_${upper}_CLIENT_ID`] || null;
}

function providerClientSecret(env, provider) {
  const def = PROVIDERS[provider];
  if (!def) return null;
  const upper = provider.toUpperCase();
  if (def.kind === "google") {
    return env[`OAUTH_${upper}_CLIENT_SECRET`] || env.GOOGLE_CLIENT_SECRET || null;
  }
  return env[`OAUTH_${upper}_CLIENT_SECRET`] || null;
}

function providerAuthUrl(provider) {
  const def = PROVIDERS[provider];
  if (def.kind === "google") return "https://accounts.google.com/o/oauth2/v2/auth";
  if (def.kind === "microsoft") return "https://login.microsoftonline.com/common/oauth2/v2.0/authorize";
  return def.authUrl;
}

function providerTokenUrl(provider) {
  const def = PROVIDERS[provider];
  if (def.kind === "google") return "https://oauth2.googleapis.com/token";
  if (def.kind === "microsoft") return "https://login.microsoftonline.com/common/oauth2/v2.0/token";
  return def.tokenUrl;
}

function callbackUrl(request, provider) {
  const url = new URL(request.url);
  return `${url.origin}/connect/${provider}/callback`;
}

// --- Route handlers ------------------------------------------------------

async function handleAuthGoogle(env, request) {
  let body;
  try { body = await request.json(); } catch { return json({ error: "invalid JSON body" }, 400); }
  if (!body || typeof body.idToken !== "string" || !body.idToken) {
    return json({ error: "idToken is required" }, 400);
  }
  // Verify the Google ID token with Google (token is used for this one
  // call only and is never stored).
  let profile;
  try {
    const res = await fetch(
      `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(body.idToken)}`
    );
    if (!res.ok) return json({ error: "invalid_google_token" }, 401);
    profile = await res.json();
  } catch {
    return json({ error: "invalid_google_token" }, 401);
  }
  const iss = profile.iss || "";
  if (iss !== "https://accounts.google.com" && iss !== "accounts.google.com") {
    return json({ error: "invalid_google_token" }, 401);
  }
  if (profile.email_verified !== "true" && profile.email_verified !== true) {
    return json({ error: "invalid_google_token" }, 401);
  }
  if (env.GOOGLE_CLIENT_ID && profile.aud !== env.GOOGLE_CLIENT_ID) {
    return json({ error: "invalid_google_token" }, 401);
  }
  if (typeof profile.sub !== "string" || !profile.sub ||
      typeof profile.email !== "string" || !profile.email) {
    return json({ error: "invalid_google_token" }, 401);
  }
  const token = crypto.randomUUID() + crypto.randomUUID();
  await env.CLICKY_KV.put(
    `sync:${token}`,
    JSON.stringify({ sub: profile.sub, email: profile.email, createdAt: new Date().toISOString() })
  );
  return json({ token, email: profile.email, sub: profile.sub });
}

async function handleChat(env, request, auth) {
  let body;
  try { body = await request.json(); } catch { return json({ error: "invalid JSON body" }, 400); }
  if (!body || !Array.isArray(body.messages) || body.messages.length === 0) {
    return json({ error: "messages is required (non-empty array)" }, 400);
  }
  const contents = [];
  for (const m of body.messages) {
    if (!m || typeof m.text !== "string") return json({ error: "each message needs a text string" }, 400);
    const role = m.role === "model" ? "model" : "user";
    contents.push({ role, parts: [{ text: m.text }] });
  }
  if (typeof body.imageBase64 === "string" && body.imageBase64) {
    const mime = typeof body.imageMime === "string" && body.imageMime
      ? body.imageMime : "image/png";
    if (!["image/png", "image/jpeg", "image/webp", "image/gif"].includes(mime)) {
      return json({ error: "imageMime must be image/png, image/jpeg, image/webp or image/gif" }, 400);
    }
    const last = contents[contents.length - 1];
    if (last.role === "user") {
      last.parts.push({ inline_data: { mime_type: mime, data: body.imageBase64 } });
    } else {
      contents.push({ role: "user", parts: [{ inline_data: { mime_type: mime, data: body.imageBase64 } }] });
    }
  }
  const payload = {
    systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
    contents,
  };
  let result;
  try {
    result = await callViaRelay(env, "chat", payload);
  } catch (e) {
    return relayErrorResponse(e);
  }
  await bumpUsage(env, auth.sub, "chat");
  return json({ text: result.text, model: result.model });
}

async function handleTts(env, request, auth) {
  let body;
  try { body = await request.json(); } catch { return json({ error: "invalid JSON body" }, 400); }
  if (!body || typeof body.text !== "string" || !body.text.trim()) {
    return json({ error: "text is required" }, 400);
  }
  const voice = (typeof body.voice === "string" && body.voice) ||
    (typeof env.TTS_VOICE === "string" && env.TTS_VOICE) || DEFAULT_TTS_VOICE;
  const payload = {
    contents: [{ role: "user", parts: [{ text: body.text }] }],
    generationConfig: {
      responseModalities: ["AUDIO"],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
    },
  };
  let result;
  try {
    result = await callViaRelay(env, "tts", payload);
  } catch (e) {
    return relayErrorResponse(e);
  }
  const audioB64 = result.audioBase64;
  const mime = result.mime || "audio/wav";
  if (!audioB64) return json({ error: "tts_no_audio" }, 502);
  await bumpUsage(env, auth.sub, "tts");
  const bytes = unb64(audioB64);
  return new Response(bytes, {
    headers: {
      "Content-Type": mime,
      "Content-Length": String(bytes.byteLength),
      "Access-Control-Allow-Origin": "*",
    },
  });
}

async function handleStt(env, request, auth) {
  let body;
  try { body = await request.json(); } catch { return json({ error: "invalid JSON body" }, 400); }
  if (!body || typeof body.audioBase64 !== "string" || !body.audioBase64) {
    return json({ error: "audioBase64 is required" }, 400);
  }
  const mime = typeof body.mimeType === "string" && body.mimeType
    ? body.mimeType : "audio/wav";
  const payload = {
    contents: [{ role: "user", parts: [
      { inline_data: { mime_type: mime, data: body.audioBase64 } },
      { text: "Transcribe this audio exactly, word for word." },
    ] }],
  };
  let result;
  try {
    result = await callViaRelay(env, "stt", payload);
  } catch (e) {
    return relayErrorResponse(e);
  }
  const text = (result.text || "").trim();
  await bumpUsage(env, auth.sub, "stt");
  return json({ text, model: result.model });
}

// --- Streaming STT (live always-listening session) -----------------------
// The always-listening live session (SPEC.md Hotkey rule) needs
// continuous mic audio with low-latency transcripts, which a single
// POST /stt cannot provide. Two streaming paths, same transcription
// engine (gemini-3.5-transcribe, one Gemini call per chunk):
//
//   A. Chunked REST (recommended — simple, stateless per request):
//        POST /stt-stream/start          -> { sessionId }
//        POST /stt-stream/:id/chunk      -> { sessionId, text, cumulative, chunks }
//        GET  /stt-stream/:id            -> { sessionId, transcript, chunks }
//        POST /stt-stream/:id/end        -> { sessionId, transcript, chunks }
//      The app sends VAD-segmented utterances (or ~1-3 s windows) as
//      chunks; each chunk is transcribed immediately and the cumulative
//      transcript is returned with it, so the app can respond in real
//      time. Sessions live in KV (1 h TTL) and are per-account.
//
//   B. WebSocket (same semantics, one persistent connection):
//        GET /stt-stream/ws?token=<api-token>  (or Authorization header)
//      Client frames (JSON): {"type":"start"} ->
//        {"type":"started","sessionId"}; {"type":"audio","sessionId",
//        "audioBase64","mimeType"?} -> {"type":"transcript","sessionId",
//        "text","cumulative"}; {"type":"resume","sessionId"} ->
//        {"type":"resumed","sessionId","cumulative"}; {"type":"end",
//        "sessionId"} -> {"type":"final","sessionId","transcript"} and
//        the socket closes. Cumulative transcripts are persisted in KV
//        per chunk, so a dropped connection can resume with the same
//        sessionId. If the Worker isolate is recycled the socket drops;
//        the app must reconnect and send "resume".
//      A chunk is one Gemini transcription call, same as the REST path;
//      latency per chunk is the Gemini round-trip (~1-3 s typical).

async function getSttSession(env, sessionId) {
  try {
    const raw = await env.CLICKY_KV.get(`stt-session:${sessionId}`);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function saveSttSession(env, sessionId, session) {
  await env.CLICKY_KV.put(`stt-session:${sessionId}`, JSON.stringify(session), { expirationTtl: 3600 });
}

async function loadOwnedSttSession(env, auth, sessionId) {
  if (typeof sessionId !== "string" || !sessionId) return null;
  const s = await getSttSession(env, sessionId);
  if (!s || s.sub !== auth.sub) return null;
  return s;
}

async function createSttSession(env, auth) {
  const sessionId = crypto.randomUUID();
  await env.CLICKY_KV.put(
    `stt-session:${sessionId}`,
    JSON.stringify({ sub: auth.sub, transcript: "", chunks: 0, createdAt: new Date().toISOString() }),
    { expirationTtl: 3600 }
  );
  return sessionId;
}

// One Gemini transcription call for a single audio chunk, via the relay.
// Throws the same errors as callViaRelay.
async function transcribeChunk(env, audioBase64, mime) {
  const payload = {
    contents: [{ role: "user", parts: [
      { inline_data: { mime_type: mime, data: audioBase64 } },
      { text: "Transcribe this audio exactly, word for word." },
    ] }],
  };
  const result = await callViaRelay(env, "stt", payload);
  return { text: (result.text || "").trim(), model: result.model };
}

function appendChunkText(session, text) {
  if (text) {
    session.transcript = session.transcript ? `${session.transcript} ${text}` : text;
  }
  session.chunks += 1;
}

async function handleSttStreamStart(env, auth) {
  const sessionId = await createSttSession(env, auth);
  return json({ sessionId });
}

async function handleSttStreamChunk(env, request, auth, sessionId) {
  let body;
  try { body = await request.json(); } catch { return json({ error: "invalid JSON body" }, 400); }
  if (!body || typeof body.audioBase64 !== "string" || !body.audioBase64) {
    return json({ error: "audioBase64 is required" }, 400);
  }
  const session = await loadOwnedSttSession(env, auth, sessionId);
  if (!session) return json({ error: "session not found" }, 404);
  const mime = typeof body.mimeType === "string" && body.mimeType ? body.mimeType : "audio/wav";
  let result;
  try {
    result = await transcribeChunk(env, body.audioBase64, mime);
  } catch (e) {
    return geminiErrorResponse(e);
  }
  appendChunkText(session, result.text);
  await saveSttSession(env, sessionId, session);
  await bumpUsage(env, auth.sub, "stt");
  return json({ sessionId, text: result.text, cumulative: session.transcript, chunks: session.chunks });
}

async function handleSttStreamGet(env, auth, sessionId) {
  const session = await loadOwnedSttSession(env, auth, sessionId);
  if (!session) return json({ error: "session not found" }, 404);
  return json({ sessionId, transcript: session.transcript, chunks: session.chunks });
}

async function handleSttStreamEnd(env, auth, sessionId) {
  const session = await loadOwnedSttSession(env, auth, sessionId);
  if (!session) return json({ error: "session not found" }, 404);
  await env.CLICKY_KV.delete(`stt-session:${sessionId}`);
  return json({ sessionId, transcript: session.transcript, chunks: session.chunks });
}

async function handleSttStreamWs(env, request) {
  const url = new URL(request.url);
  const token = bearerToken(request) || url.searchParams.get("token") || "";
  const auth = token ? await resolveTokenAuth(env, token) : null;
  if (!auth) return json({ error: "unauthorized" }, 401);
  if ((request.headers.get("Upgrade") || "").toLowerCase() !== "websocket") {
    return json({ error: "websocket upgrade required" }, 426);
  }
  const pair = new WebSocketPair();
  const [client, server] = Object.values(pair);
  server.accept();

  const send = (obj) => {
    try { server.send(JSON.stringify(obj)); } catch { /* socket gone */ }
  };

  server.addEventListener("message", async (event) => {
    let msg;
    try {
      msg = JSON.parse(typeof event.data === "string" ? event.data : "");
    } catch {
      send({ type: "error", error: "invalid JSON frame" });
      return;
    }
    try {
      if (msg.type === "start") {
        const sessionId = await createSttSession(env, auth);
        send({ type: "started", sessionId });
        return;
      }
      if (msg.type === "resume") {
        const session = await loadOwnedSttSession(env, auth, msg.sessionId);
        if (!session) { send({ type: "error", error: "session not found" }); return; }
        send({ type: "resumed", sessionId: msg.sessionId, cumulative: session.transcript });
        return;
      }
      if (msg.type === "audio") {
        if (typeof msg.audioBase64 !== "string" || !msg.audioBase64) {
          send({ type: "error", error: "audioBase64 is required" });
          return;
        }
        const session = await loadOwnedSttSession(env, auth, msg.sessionId);
        if (!session) { send({ type: "error", error: "session not found" }); return; }
        const mime = typeof msg.mimeType === "string" && msg.mimeType ? msg.mimeType : "audio/wav";
        const result = await transcribeChunk(env, msg.audioBase64, mime);
        appendChunkText(session, result.text);
        await saveSttSession(env, msg.sessionId, session);
        await bumpUsage(env, auth.sub, "stt");
        send({ type: "transcript", sessionId: msg.sessionId, text: result.text, cumulative: session.transcript });
        return;
      }
      if (msg.type === "end") {
        const session = await loadOwnedSttSession(env, auth, msg.sessionId);
        if (!session) { send({ type: "error", error: "session not found" }); return; }
        await env.CLICKY_KV.delete(`stt-session:${msg.sessionId}`);
        send({ type: "final", sessionId: msg.sessionId, transcript: session.transcript });
        try { server.close(1000, "session ended"); } catch { /* ignore */ }
        return;
      }
      send({ type: "error", error: "unknown frame type" });
    } catch (e) {
      // Relay/Gemini errors surface here as frames, not a dropped socket:
      // "relay_unavailable" means the VM relay is not connected right
      // now; "provider_rate_limited" means try again shortly.
      send({ type: "error", error: e && e.message ? e.message : "gemini_error" });
    }
  });

  return new Response(null, { status: 101, webSocket: client });
}

async function handleConnectStart(env, request, auth, provider) {
  if (!PROVIDERS[provider]) return json({ error: "unknown_provider" }, 404);
  const clientId = providerClientId(env, provider);
  if (!clientId) {
    return json({
      error: "not_configured",
      detail: `OAuth client credentials for ${provider} are not set on the Worker yet (OAUTH_${provider.toUpperCase()}_CLIENT_ID / _CLIENT_SECRET secrets)`,
    }, 501);
  }
  const state = crypto.randomUUID();
  await env.CLICKY_KV.put(
    `oauth-state:${state}`,
    JSON.stringify({ sub: auth.sub, provider, createdAt: new Date().toISOString() }),
    { expirationTtl: 600 }
  );
  const def = PROVIDERS[provider];
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: callbackUrl(request, provider),
    response_type: "code",
    state,
  });
  if (def.kind === "google" || def.kind === "microsoft") {
    params.set("scope", def.scopes.join(" "));
    params.set("access_type", "offline");
    params.set("prompt", "consent");
  } else if (def.scopes.length) {
    params.set("scope", def.scopes.join(" "));
  }
  if (provider === "dropbox") params.set("token_access_type", "offline");
  return json({ url: `${providerAuthUrl(provider)}?${params.toString()}` });
}

async function handleConnectCallback(env, request, provider) {
  if (!PROVIDERS[provider]) return json({ error: "unknown_provider" }, 404);
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const fail = (msg) =>
    new Response(`<html><body><h1>Connection failed</h1><p>${msg}</p></body></html>`,
      { status: 400, headers: { "Content-Type": "text/html" } });
  if (!code || !state) return fail("Missing code or state.");
  let stateEntry = null;
  try {
    const raw = await env.CLICKY_KV.get(`oauth-state:${state}`);
    if (raw) stateEntry = JSON.parse(raw);
  } catch { /* fall through to fail */ }
  if (!stateEntry || stateEntry.provider !== provider) return fail("Invalid or expired state.");
  await env.CLICKY_KV.delete(`oauth-state:${state}`);
  const clientId = providerClientId(env, provider);
  const clientSecret = providerClientSecret(env, provider);
  if (!clientId || !clientSecret) return fail(`OAuth credentials for ${provider} are not configured.`);
  // Exchange the code for tokens. Tokens are encrypted before storage
  // and are never returned in any response.
  let tokenData;
  try {
    const res = await fetch(providerTokenUrl(provider), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: callbackUrl(request, provider),
        grant_type: "authorization_code",
      }).toString(),
    });
    if (!res.ok) return fail("Token exchange failed.");
    tokenData = await res.json();
  } catch {
    return fail("Token exchange failed.");
  }
  if (!tokenData || typeof tokenData.access_token !== "string") {
    return fail("Token exchange returned no access token.");
  }
  const enc = await encryptToken(env, JSON.stringify(tokenData));
  if (!enc) return fail("Token encryption is not configured (TOKEN_ENCRYPTION_KEY secret).");
  await env.CLICKY_KV.put(
    `conn:${stateEntry.sub}:${provider}`,
    JSON.stringify({ enc, provider, connectedAt: new Date().toISOString(), scopes: PROVIDERS[provider].scopes })
  );
  return new Response(
    `<html><body><h1>${provider} connected</h1><p>You can close this window and go back to the app.</p></body></html>`,
    { headers: { "Content-Type": "text/html" } }
  );
}

async function handleConnectStatus(env, auth, provider) {
  if (!PROVIDERS[provider]) return json({ error: "unknown_provider" }, 404);
  let connectedAt = null;
  try {
    const raw = await env.CLICKY_KV.get(`conn:${auth.sub}:${provider}`);
    if (raw) connectedAt = JSON.parse(raw).connectedAt || null;
  } catch { /* treat as not connected */ }
  return json({ provider, connected: connectedAt !== null, connectedAt });
}

async function handleConnectDelete(env, auth, provider) {
  if (!PROVIDERS[provider]) return json({ error: "unknown_provider" }, 404);
  await env.CLICKY_KV.delete(`conn:${auth.sub}:${provider}`);
  return json({ ok: true, provider, connected: false });
}

async function handleMcpList(env) {
  let servers = [];
  try {
    const raw = await env.CLICKY_KV.get("mcp:servers");
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) servers = parsed;
    }
  } catch { /* empty list */ }
  return json({ servers });
}

async function handleMcpAdd(env, request, auth) {
  let body;
  try { body = await request.json(); } catch { return json({ error: "invalid JSON body" }, 400); }
  if (!body || typeof body.name !== "string" || !body.name.trim()) {
    return json({ error: "name is required" }, 400);
  }
  if (typeof body.url !== "string" || !body.url) {
    return json({ error: "url is required" }, 400);
  }
  const server = {
    name: body.name.trim(),
    url: body.url,
    transport: typeof body.transport === "string" ? body.transport : "sse",
    addedBy: auth.sub,
    addedAt: new Date().toISOString(),
  };
  let servers = [];
  try {
    const raw = await env.CLICKY_KV.get("mcp:servers");
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) servers = parsed;
    }
  } catch { /* start fresh */ }
  servers = servers.filter((s) => s.name !== server.name);
  servers.push(server);
  await env.CLICKY_KV.put("mcp:servers", JSON.stringify(servers));
  return json(server, 201);
}

async function handleMcpDelete(env, name) {
  let servers = [];
  try {
    const raw = await env.CLICKY_KV.get("mcp:servers");
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) servers = parsed;
    }
  } catch { /* nothing to delete */ }
  const next = servers.filter((s) => s.name !== name);
  await env.CLICKY_KV.put("mcp:servers", JSON.stringify(next));
  return json({ ok: true });
}

// --- Relay Durable Object ------------------------------------------------
// Singleton (id "relay") holding the VM relay's outbound WebSocket.
// The relay authenticates with a hello frame carrying RELAY_SECRET.
// Model jobs arrive as POST /job from the main Worker (callViaRelay),
// are forwarded over the relay socket, and the relay's {type:"result"}
// frame resolves the waiting request. If no authenticated relay socket
// is connected, /job returns 503 relay_unavailable — never a credits
// screen. Auth state is also kept in DO storage so it survives
// hibernation eviction (in-memory sets do not).
export class RelayDO {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.pending = new Map(); // job id -> { resolve, reject, timer }
    this.authed = new Set(); // WebSocket objects that passed hello
    this.authWaiters = new Map(); // auth-check nonce -> { resolve, timer }
  }

  relaySockets() {
    try {
      return this.ctx.getWebSockets("relay");
    } catch {
      return [];
    }
  }

  async isRelayConnected() {
    if (this.relaySockets().some((ws) => this.authed.has(ws))) return true;
    // Storage flag alone never trusts a socket: a fresh unauthed socket
    // must never receive jobs. /job challenges sockets (auth-check)
    // when the flag is set but no socket is authed in memory.
    try {
      return (await this.ctx.storage.get("relayAuthed")) === true;
    } catch {
      return false;
    }
  }

  failPending(reason) {
    for (const [id, job] of this.pending) {
      clearTimeout(job.timer);
      this.pending.delete(id);
      const e = new Error(reason);
      e.status = 503;
      job.reject(e);
    }
  }

  async fetch(request) {
    const url = new URL(request.url);

    // GET /relay — relay WebSocket upgrade.
    if (url.pathname === "/relay") {
      if ((request.headers.get("Upgrade") || "").toLowerCase() !== "websocket") {
        return json({ error: "websocket upgrade required" }, 426);
      }
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.ctx.acceptWebSocket(server, ["relay"]);
      return new Response(null, { status: 101, webSocket: client });
    }

    // GET /status — relay connectivity (no secret, no token).
    if (url.pathname === "/status" && request.method === "GET") {
      return json({ connected: await this.isRelayConnected() });
    }

    // POST /job — forward one model job to the relay, await its result.
    if (url.pathname === "/job" && request.method === "POST") {
      let job;
      try { job = await request.json(); } catch { return json({ ok: false, error: "invalid JSON body" }, 400); }
      if (!job || typeof job.kind !== "string" || !job.payload) {
        return json({ ok: false, error: "kind and payload are required" }, 400);
      }
      let sockets = this.relaySockets().filter((ws) => this.authed.has(ws));
      if (!sockets.length) {
        // No authed socket in memory (e.g. the DO hibernated and lost
        // its in-memory set). If a relay was ever authed, challenge the
        // connected sockets: only the genuine relay can answer with a
        // connectionId issued at its hello. Never send a job to a socket
        // that has not proven itself.
        let flag = false;
        try { flag = (await this.ctx.storage.get("relayAuthed")) === true; } catch {}
        if (!flag) {
          return json({ ok: false, error: "relay_unavailable" }, 503);
        }
        const nonce = crypto.randomUUID();
        const challenged = await new Promise((resolve) => {
          const timer = setTimeout(() => {
            this.authWaiters.delete(nonce);
            resolve(false);
          }, 5000);
          this.authWaiters.set(nonce, { resolve, timer });
          for (const ws of this.relaySockets()) {
            try { ws.send(JSON.stringify({ type: "auth-check", nonce })); } catch {}
          }
        });
        sockets = this.relaySockets().filter((ws) => this.authed.has(ws));
        if (!challenged || !sockets.length) {
          return json({ ok: false, error: "relay_unavailable" }, 503);
        }
      }
      const id = crypto.randomUUID();
      const promise = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pending.delete(id);
          const e = new Error("relay_timeout");
          e.status = 503;
          reject(e);
        }, RELAY_JOB_TIMEOUT_MS);
        this.pending.set(id, { resolve, reject, timer });
      });
      try {
        sockets[0].send(JSON.stringify({ type: "job", id, kind: job.kind, payload: job.payload }));
      } catch {
        const entry = this.pending.get(id);
        if (entry) { clearTimeout(entry.timer); this.pending.delete(id); }
        return json({ ok: false, error: "relay_unavailable" }, 503);
      }
      try {
        const result = await promise;
        return json({ ok: true, result });
      } catch (e) {
        return json({ ok: false, error: e.message || "relay_error", status: e.status || 502 }, e.status || 502);
      }
    }

    return json({ error: "not found" }, 404);
  }

  async webSocketMessage(ws, message) {
    let msg;
    try {
      msg = JSON.parse(typeof message === "string" ? message : new TextDecoder().decode(message));
    } catch {
      try { ws.send(JSON.stringify({ type: "error", error: "invalid JSON frame" })); } catch {}
      return;
    }
    // Socket not authed in memory (e.g. the DO hibernated and lost its
    // in-memory set). Three ways back in, nothing else:
    //  (a) a hello frame with the shared secret -> fresh connectionId;
    //  (b) an auth-ok answering a /job auth-check nonce with a stored id;
    //  (c) any other frame carrying a stored connectionId (the relay
    //      re-sends hello every 20 s, and its result frames carry the id).
    if (!this.authed.has(ws)) {
      if (msg.type === "hello" && typeof msg.secret === "string" &&
          this.env.RELAY_SECRET && msg.secret === this.env.RELAY_SECRET) {
        this.authed.add(ws);
        const connId = crypto.randomUUID();
        try {
          await this.ctx.storage.put("relayAuthed", true);
          const prev = (await this.ctx.storage.get("relayConns")) || [];
          const conns = Array.isArray(prev) ? prev.slice(-1) : [];
          conns.push(connId);
          await this.ctx.storage.put("relayConns", conns);
        } catch {}
        try { ws.send(JSON.stringify({ type: "hello-ok", connectionId: connId })); } catch {}
        return;
      }
      if (msg.type === "auth-ok" && typeof msg.nonce === "string") {
        const waiter = this.authWaiters.get(msg.nonce);
        if (waiter) {
          clearTimeout(waiter.timer);
          this.authWaiters.delete(msg.nonce);
          let valid = false;
          try {
            const conns = (await this.ctx.storage.get("relayConns")) || [];
            valid = Array.isArray(conns) && conns.includes(msg.connectionId);
          } catch {}
          if (valid) {
            this.authed.add(ws);
            waiter.resolve(true);
          } else {
            waiter.resolve(false);
          }
        }
        return;
      }
      if (typeof msg.connectionId === "string") {
        let valid = false;
        try {
          const conns = (await this.ctx.storage.get("relayConns")) || [];
          valid = Array.isArray(conns) && conns.includes(msg.connectionId);
        } catch {}
        if (valid) {
          this.authed.add(ws);
          // Fall through and process this frame as an authed socket.
        } else {
          try { ws.close(4403, "bad relay secret"); } catch {}
          return;
        }
      } else {
        try { ws.close(4403, "bad relay secret"); } catch {}
        return;
      }
    }
    if (msg.type === "ping") {
      try { ws.send(JSON.stringify({ type: "pong" })); } catch {}
      return;
    }
    if (msg.type === "pong") return;
    if (msg.type === "result" && typeof msg.id === "string") {
      const entry = this.pending.get(msg.id);
      if (!entry) return;
      clearTimeout(entry.timer);
      this.pending.delete(msg.id);
      if (msg.ok) entry.resolve(msg.result);
      else {
        const e = new Error(typeof msg.error === "string" ? msg.error : "relay_error");
        e.status = typeof msg.status === "number" ? msg.status : 502;
        entry.reject(e);
      }
      return;
    }
    // Unknown frame type: ignore.
  }

  async webSocketClose(ws) {
    this.authed.delete(ws);
    if (!this.relaySockets().some((s) => this.authed.has(s))) {
      try {
        await this.ctx.storage.delete("relayAuthed");
        await this.ctx.storage.delete("relayConns");
      } catch {}
      this.failPending("relay_unavailable");
    }
  }

  async webSocketError(ws) {
    this.authed.delete(ws);
    if (!this.relaySockets().some((s) => this.authed.has(s))) {
      try {
        await this.ctx.storage.delete("relayAuthed");
        await this.ctx.storage.delete("relayConns");
      } catch {}
      this.failPending("relay_unavailable");
    }
  }
}

export default {

  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
          "Access-Control-Allow-Headers": "Authorization, Content-Type",
        },
      });
    }

    // GET /health — no auth.
    if (path === "/health" && request.method === "GET") {
      return json({ ok: true });
    }

    // GET /relay-status — is the VM relay connected? (no auth, no secret)
    if (path === "/relay-status" && request.method === "GET") {
      const stub = relayStub(env);
      const res = await stub.fetch("http://relay/status");
      let data = { connected: false };
      try { data = await res.json(); } catch { /* default above */ }
      return json({ connected: data.connected === true });
    }

    // GET /relay — the VM relay's outbound WebSocket upgrade (the relay
    // authenticates with a hello frame carrying RELAY_SECRET).
    if (path === "/relay" && request.method === "GET") {
      return relayStub(env).fetch(request);
    }

    // POST /auth/google — verify a Google ID token, issue an API token.
    if (path === "/auth/google" && request.method === "POST") {
      return handleAuthGoogle(env, request);
    }

    // GET /auth/me — Bearer must be an issued API token.
    if (path === "/auth/me" && request.method === "GET") {
      const auth = await resolveAuth(env, request);
      if (!auth) return json({ error: "unauthorized" }, 401);
      return json({ email: auth.email, sub: auth.sub });
    }

    // Model endpoints — Bearer required.
    if (path === "/chat" && request.method === "POST") {
      const auth = await resolveAuth(env, request);
      if (!auth) return json({ error: "unauthorized" }, 401);
      return handleChat(env, request, auth);
    }
    if (path === "/tts" && request.method === "POST") {
      const auth = await resolveAuth(env, request);
      if (!auth) return json({ error: "unauthorized" }, 401);
      return handleTts(env, request, auth);
    }
    if (path === "/stt" && request.method === "POST") {
      const auth = await resolveAuth(env, request);
      if (!auth) return json({ error: "unauthorized" }, 401);
      return handleStt(env, request, auth);
    }

    // GET /usage — today's counters for this account (counters only,
    // never enforced; free/unlimited/no-credits locked rule).
    if (path === "/usage" && request.method === "GET") {
      const auth = await resolveAuth(env, request);
      if (!auth) return json({ error: "unauthorized" }, 401);
      const day = new Date().toISOString().slice(0, 10);
      const counts = {};
      for (const kind of ["chat", "tts", "stt"]) {
        const raw = await env.CLICKY_KV.get(`usage:${auth.sub}:${day}:${kind}`);
        counts[kind] = raw === null ? 0 : parseInt(raw, 10) || 0;
      }
      return json({ date: day, counts, unlimited: true });
    }

    // Streaming STT (live always-listening session). The WS route must
    // be checked before the :sessionId routes (sessionId "ws" would
    // otherwise match them).
    if (path === "/stt-stream/ws" && request.method === "GET") {
      return handleSttStreamWs(env, request);
    }
    if (path === "/stt-stream/start" && request.method === "POST") {
      const auth = await resolveAuth(env, request);
      if (!auth) return json({ error: "unauthorized" }, 401);
      return handleSttStreamStart(env, auth);
    }
    const sm = path.match(/^\/stt-stream\/([^/]+)\/(chunk|end)$/);
    if (sm && request.method === "POST") {
      const auth = await resolveAuth(env, request);
      if (!auth) return json({ error: "unauthorized" }, 401);
      const sessionId = decodeURIComponent(sm[1]);
      if (sm[2] === "chunk") return handleSttStreamChunk(env, request, auth, sessionId);
      return handleSttStreamEnd(env, auth, sessionId);
    }
    const sgm = path.match(/^\/stt-stream\/([^/]+)$/);
    if (sgm && request.method === "GET") {
      const auth = await resolveAuth(env, request);
      if (!auth) return json({ error: "unauthorized" }, 401);
      return handleSttStreamGet(env, auth, decodeURIComponent(sgm[1]));
    }

    // OAuth connector flows.
    const cm = path.match(/^\/connect\/([^/]+)(?:\/(start|callback|status))?$/);
    if (cm) {
      const provider = decodeURIComponent(cm[1]);
      const action = cm[2];
      if (action === "callback" && request.method === "GET") {
        return handleConnectCallback(env, request, provider);
      }
      const auth = await resolveAuth(env, request);
      if (!auth) return json({ error: "unauthorized" }, 401);
      if (action === "start" && request.method === "POST") {
        return handleConnectStart(env, request, auth, provider);
      }
      if (action === "status" && request.method === "GET") {
        return handleConnectStatus(env, auth, provider);
      }
      if (!action && request.method === "DELETE") {
        return handleConnectDelete(env, auth, provider);
      }
      return json({ error: "not found" }, 404);
    }

    // MCP server registry (KV-backed; client execution comes later).
    if (path === "/mcp/servers") {
      const auth = await resolveAuth(env, request);
      if (!auth) return json({ error: "unauthorized" }, 401);
      if (request.method === "GET") return handleMcpList(env);
      if (request.method === "POST") return handleMcpAdd(env, request, auth);
      return json({ error: "not found" }, 404);
    }
    const mm = path.match(/^\/mcp\/servers\/([^/]+)$/);
    if (mm && request.method === "DELETE") {
      const auth = await resolveAuth(env, request);
      if (!auth) return json({ error: "unauthorized" }, 401);
      return handleMcpDelete(env, decodeURIComponent(mm[1]));
    }

    return json({ error: "not found" }, 404);
  },
};
