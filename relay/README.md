# clicky-relay — VM-side Gemini relay for the HeyClicky clone

The Cloudflare Worker holds **no Gemini key**. This daemon runs on the VM,
opens a persistent **outbound** WebSocket to the Worker's `RelayDO` Durable
Object, and executes model jobs by calling Gemini through the Muse connector
layer (an `hsurr:*` surrogate fetched from authd per attempt; the egress
layer swaps it for the real key). No key value is ever stored, printed, or
logged — only connector names.

## Files

- `relay.mjs` — the daemon. Node >= 22, zero dependencies (global
  `WebSocket` + `fetch`, `net` for the authd Unix socket).
- `clicky-relay.service` — systemd unit (installed in `/etc` by
  `~/workspace/claude-opencode-rebuild/restore_services.sh`, which also
  verifies the relay is connected after every reboot drill).
- `state/last-connector.txt`, `state/quarantine.json` — rotation state
  (connector names + expiry only, never key material).

## Config

Environment (systemd `EnvironmentFile`, never in this repo):

- `~/.config/clicky-relay/relay.env` (0600): `RELAY_SECRET` (shared secret
  the relay presents in its hello frame; the Worker holds the matching
  `RELAY_SECRET` wrangler secret) and `RELAY_URL`
  (default `wss://clicky-clone-backend.shrihari52141.workers.dev/relay`).
- `~/.config/nvidia-rotation/.env`: egress proxy vars (same file the other
  bot services load). Without them the VM has no outbound route.
- Unit also sets `NODE_USE_ENV_PROXY=1` and
  `NODE_EXTRA_CA_CERTS=/run/hatch/egress-tls/ca-bundle.pem` — the egress
  proxy MITMs TLS, and Node does not read `SSL_CERT_FILE`. Without the
  bundle, `fetch` to Gemini fails with "self-signed certificate in
  certificate chain" (the WebSocket still connects, which makes this
  failure mode confusing — check `journalctl -u clicky-relay` for it).

## Protocol (relay <-> Worker)

- Relay sends `{type:"hello", secret}` on connect and re-sends it every
  20 s (the DO hibernates when idle and loses its in-memory auth set; the
  heartbeat re-authenticates, and the DO also issues a `connectionId` in
  `hello-ok` which result frames carry so a hibernation wake can re-trust
  the socket without ever trusting an unauthed one).
- Worker sends `{type:"job", id, kind, payload}`; relay replies
  `{type:"result", id, ok, result|error, status}`.
- Job kinds: `chat` (payload = Gemini `generateContent` body, system
  prompt included by the Worker), `tts`, `stt`. The relay returns
  `{text, model}` (chat/stt) or `{audioBase64, mime, model}` (tts).

## Rotation (locked rule)

Fisher-Yates shuffle over `custom.gemini-1..9` + `custom.gemini`, never
start on the previously used connector, rotate on 401/403/429/503, and on
400 only when Gemini says "API key not valid" (a dead key, not a bad
payload — any other 400 stops immediately so one malformed request cannot
quarantine the pool). Failed connectors are quarantined 30 min. Per-attempt
timeout 10 s; whole-job deadline 75 s (inside the DO's 90 s timeout).
Models: chat `gemini-3.8-flash` -> `gemini-3.5-flash-lite` fallback,
STT `gemini-3.5-transcribe`, TTS `gemini-2.5-flash-preview-tts`.

## Key-pool health (measured 2026-11-25)

Only **2 of 10** connectors answer: `custom.gemini-3` and
`custom.gemini-5`. The other seven `custom.gemini-1/2/4/6/7/8/9` return
401 "The bound service account is deleted or disabled", and
`custom.gemini` returns 400 "API key not valid". Rotation + quarantine
absorbs this, but the pool is effectively 2 keys. If those two die, all
model calls fail until the vault keys are repaired — that repair needs
Hari (new keys in the vault), not this relay. Also: `gemini-3.8-flash`
is currently overloaded — it often stalls instead of answering 503, so
chat calls usually fall back to `gemini-3.5-flash-lite` after two 10 s
timeouts (~21–44 s per chat call; TTS/STT are fast, ~3–7 s).

## Endpoints / ops

- `GET /relay-status` on the Worker — `{"connected":true|false}` (no auth).
- Logs: `journalctl -u clicky-relay` (job id, kind, model, connector,
  latency; never secrets, surrogates, or payload contents).
- Restart: `systemctl restart clicky-relay` (auto-reconnects with backoff
  1 s -> 30 s). Restore drill: `sudo
  ~/workspace/claude-opencode-rebuild/restore_services.sh` (exit 0 =
  all 6 services active + enabled and relay connected).

## Verified live 2026-11-25 (public Worker URL, Bearer token)

- `/chat` -> real Gemini reply (`RELAYOK`, `SERVICEOK`, `RESTARTOK` via
  `gemini-3.5-flash-lite`); `/tts` -> 200, real PCM audio;
  `/stt` -> exact transcript via `gemini-3.5-transcribe`;
  `/stt-stream` chunk + WS `audio` frame -> exact cumulative transcript.
- Relay down -> `/chat` 503 `relay_unavailable` "try again in a moment"
  (never a credits screen); `systemctl restart` -> re-registered and
  `/chat` works again.
