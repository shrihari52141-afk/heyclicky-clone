# clicky-clone-backend — Cloudflare Worker

Live: https://clicky-clone-backend.shrihari52141.workers.dev
Wrangler project: `clicky-clone-backend` · KV: `CLICKY_KV` (`ddcb1a59b55c40d08f669632ec1f8228`)
Source: `~/workspace/heyclicky-clone/backend/` (`worker.js`, `wrangler.toml`)
Deployed: 2026-11-25 (version f2060fe6-8099-446e-93b9-eb143b3c9211)

## Locked rules this backend enforces

- FREE, UNLIMITED, NO credits — no paywall, no per-user cap anywhere.
  Usage counters (`GET /usage`) are counters only; nothing reads them
  to block a request. A real provider rate limit returns 503
  `provider_rate_limited` with "try again in a moment" — never a
  credits screen.
- Always-yes agent persona: the system prompt in `worker.js`
  (`SYSTEM_PROMPT`) is embedded verbatim from
  `~/workspace/heyclicky-clone/agent-system-prompt.md`.

## Endpoints

| Route | Auth | Notes |
|---|---|---|
| `GET /health` | none | `{ok:true}` |
| `POST /auth/google` | none | Body `{"idToken": "<Google ID token>"}` — verified via Google tokeninfo; returns `{"token","email","sub"}`. The Google token is never stored. |
| `GET /auth/me` | Bearer API token | Returns `{"email","sub"}` |
| `POST /chat` | Bearer | Body `{"messages":[{"role":"user"\|"model","text":"..."}], "imageBase64"?,"imageMime"?}`. Models: gemini-3.8-flash, fallback gemini-3.5-flash-lite. Returns `{"text","model"}`. |
| `POST /tts` | Bearer | Body `{"text","voice"?}` — Gemini TTS (gemini-2.5-flash-preview-tts), default voice `Kore`. Returns audio bytes (`audio/wav`). |
| `POST /stt` | Bearer | Body `{"audioBase64","mimeType"?}` — gemini-3.5-transcribe. Returns `{"text","model"}`. |
| `POST /stt-stream/start` | Bearer | Start a live listening session → `{"sessionId"}`. Sessions live 1 h in KV, per-account. |
| `POST /stt-stream/:id/chunk` | Bearer | Body `{"audioBase64","mimeType"?}` — one VAD-segmented utterance or ~1–3 s window; transcribed immediately (gemini-3.5-transcribe) → `{"sessionId","text","cumulative","chunks"}`. |
| `GET /stt-stream/:id` | Bearer | Current cumulative transcript → `{"sessionId","transcript","chunks"}`. |
| `POST /stt-stream/:id/end` | Bearer | Close the session → `{"sessionId","transcript","chunks"}`. |
| `GET /stt-stream/ws?token=<api-token>` | Bearer header or `?token=` | WebSocket live session (same engine as the chunked REST path). Frames: `{"type":"start"}` → `{"type":"started","sessionId"}`; `{"type":"audio","sessionId","audioBase64","mimeType"?}` → `{"type":"transcript","sessionId","text","cumulative"}`; `{"type":"resume","sessionId"}` → `{"type":"resumed","sessionId","cumulative"}`; `{"type":"end","sessionId"}` → `{"type":"final","sessionId","transcript"}` then close. Errors arrive as `{"type":"error","error"}` frames without dropping the socket. Cumulative transcripts persist in KV per chunk, so a dropped socket can reconnect + resume. If the Worker isolate is recycled the socket drops — the app must reconnect and resume. |
| `GET /usage` | Bearer | Today's counters for this account + `"unlimited": true`. |
| `POST /connect/:provider/start` | Bearer | Returns OAuth authorization URL, or 501 `not_configured` until that provider's OAuth client secrets are set. |
| `GET /connect/:provider/callback` | none (browser redirect) | Exchanges code, encrypts tokens (AES-GCM), stores in KV. |
| `GET /connect/:provider/status` | Bearer | `{"provider","connected","connectedAt"}` — never returns a token. |
| `DELETE /connect/:provider` | Bearer | Disconnect (deletes stored tokens). |
| `GET /mcp/servers` | Bearer | Lists registered MCP servers (KV-backed). |
| `POST /mcp/servers` | Bearer | Register one: `{"name","url","transport"?}`. Execution comes in a later milestone. |
| `DELETE /mcp/servers/:name` | Bearer | Remove one. |

Providers: `gmail`, `googledocs`, `googletasks`, `dropbox`, `clickup`,
`jira`, `linear`, `hubspot`, `salesforce`, `outlook`, `teams`.
Per-provider API proxying comes in a later milestone.

## Secrets (set via `wrangler secret put`, never in this repo)

- `RELAY_SECRET` — shared secret the VM-side relay presents when it
  connects its outbound WebSocket to the Worker (see "Key plan" below).
  The Worker never holds a Gemini key.
- `TOKEN_ENCRYPTION_KEY` — set at deploy time (base64 32-byte AES-GCM key).
- `GOOGLE_CLIENT_ID` (optional) — when set, /auth/google rejects ID
  tokens whose audience is not this client.
- `GOOGLE_CLIENT_SECRET` (optional) — Google-provider connector OAuth.
- `OAUTH_<PROVIDER>_CLIENT_ID` / `OAUTH_<PROVIDER>_CLIENT_SECRET` —
  per-provider OAuth credentials for /connect flows.
- `TTS_VOICE` (optional) — default TTS voice name.

## Verified live 2026-11-25

- `GET /health` → 200 `{"ok":true}`
- All model/auth/connect/mcp endpoints without a token → 401 `unauthorized`
- `POST /auth/google` with a bad ID token → 401 `invalid_google_token`
- Unknown route → 404

## Verified live 2026-11-25 (relay — see `../relay/README.md`)

- Relay daemon live as systemd service `clicky-relay` (Restart=always,
  covered by `restore_services.sh`, exit 0 with all 6 services active +
  enabled). Worker version `a1647c55-dd14-4bd6-be6b-8d17d4a24bf4`
  (RelayDO, SQLite-backed, migration v1).
- `GET /relay-status` -> `{"connected":true}`; relay re-registers after
  `systemctl restart` and `/chat` works again.
- `POST /chat` (Bearer) -> real Gemini reply (`RELAYOK` / `SERVICEOK` /
  `RESTARTOK`, model `gemini-3.5-flash-lite` — `gemini-3.8-flash` is
  currently overloaded and usually falls back after 10 s timeouts).
- `POST /tts` -> 200, real PCM audio (`audio/L16;codec=pcm;rate=24000`).
- `POST /stt` -> exact transcript via `gemini-3.5-transcribe`
  (round-tripped the relay's own TTS audio).
- `POST /stt-stream/:id/chunk` and WS `audio` frame -> exact cumulative
  transcript. Auth was a test token minted directly in KV in the same
  `sync:` format `/auth/google` writes (no legitimate Google ID token
  was available to test the Google path); the token was deleted after
  verification. The Google sign-in path itself is unchanged and still
  needs a real Google ID token to verify end to end.
- Relay down -> `/chat` 503 `relay_unavailable` "try again in a moment"
  (never a credits screen).
- Key-pool health: only `custom.gemini-3` and `custom.gemini-5` answer;
  `custom.gemini-1/2/4/6/7/8/9` return 401 (bound service account
  deleted/disabled), `custom.gemini` returns 400 (key not valid).
  Rotation + 30-min quarantine absorbs this; if the last two die, model
  calls fail until the vault keys are repaired.

## NOT yet verified (blocked)

- Full OAuth connect flow per provider — needs each provider's OAuth
  client credentials (later milestone).
- `/auth/google` with a real Google ID token (needs Hari's sign-in).

## Key plan — how the Worker gets Gemini WITHOUT holding a key (verified 2026-11-25 13:55 IST)

- ALL NINE Gemini keys are already saved in the Secure Vault
  (`custom.gemini-1` through `custom.gemini-9`, each already_connected,
  plus one `custom.gemini`). **Hari does NOT need to provide any key,
  and must never be asked to paste one.** The connector docs for
  gemini-1..9 are missing from disk — only the vault credentials exist.
- Vault values cannot be read out, so they cannot be copied into a
  Worker secret. The old `GEMINI_API_KEYS` Worker-secret plan is
  DEAD — do not use it. The Worker never holds a Gemini key.
- The vault credentials only reach API calls through the vault's
  surrogate exchange: code on THIS VM requests an `hsurr:*` surrogate
  from authd and the egress layer swaps it for the real key on approved
  outbound requests to the registered host. That swap only works for
  requests issued from this VM — never inside a Cloudflare Worker.
- There is no inbound route to this VM (no tunnel, no public IP), and
  the localhost routers (FreeLLMAPI :3001, LiteLLM :4000) are not
  reachable from Hari's PC. The 3 NVIDIA keys cannot substitute — the
  design needs Gemini models specifically (`gemini-3.8-flash`,
  `gemini-3.5-flash-lite`, `gemini-3.5-transcribe`,
  `gemini-2.5-flash-preview-tts`).

### The real plan: VM-side relay (outbound WebSocket)

1. A small relay daemon runs on this VM. It opens a persistent
   OUTBOUND WebSocket to the Worker's Durable Object (this VM can
   always initiate outbound connections; nothing inbound is needed).
   It authenticates with `RELAY_SECRET`.
2. The Worker routes all model calls (`/chat`, `/tts`, `/stt`,
   `/stt-stream` chunks and WS audio frames) through that socket to
   the relay instead of calling Gemini directly.
3. The relay calls Gemini through the Muse connector layer
   (`dynamic_credentials` surrogate, same pattern as
   `custom.telegram/bin/media_reaction.py`): Fisher-Yates rotation
   over `custom.gemini-1..9` + `custom.gemini`, never start on the
   previously used key, rotate on 401/403/429/503. Keys are never
   logged, printed, or stored anywhere by the relay.
4. The relay is a service under the same restore drill as the other
   five services (`restore_services.sh`, Restart=always) so it
   reconnects automatically after the ~2-hourly reboots. While the
   relay is down, model endpoints return 503 "try again in a moment"
   — never a credits screen.
5. The Worker still enforces auth (Google sign-in → Bearer API token)
   and keeps usage counters only; no per-user cap anywhere.

### Still to verify (relay builder)

- That the surrogate exchange works from a long-running daemon
  process (not just one-shot scripts) — prove with a live `/chat`
  call through the public Worker URL once the relay is built.
- Relay reconnect behaviour across a VM reboot.
- No key from Hari is needed at any step of this plan.
