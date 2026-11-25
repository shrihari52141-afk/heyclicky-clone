# Clicky backend contract (Cloudflare Worker)

The Windows app never holds a model API key. All model calls go through
the Clicky backend Worker, which proxies to Gemini through the key
rotation. The app reads the Worker URL from `backend.json` next to
`Clicky.exe`.

Base URL: `{workerUrl}` from `backend.json` (placeholder until deployed).

## Endpoints

### `GET /v1/health`
→ `200 {"ok": true}` when the Worker is up. Used only for diagnostics.

### `POST /v1/vision` — ask about a screenshot
Request JSON:
```json
{
  "system_prompt": "<the Clicky agent system prompt, verbatim>",
  "question": "What is this button for?",
  "image_png_base64": "<PNG bytes, base64>",
  "mouse_x": 1234,
  "mouse_y": 567
}
```
`mouse_x` / `mouse_y` are the mouse position in screenshot pixels
(top-left origin, relative to the captured monitor), read with
`GetCursorPos` at capture time; the image has a small butter-ring
marker drawn at that spot so the model can see what the user is
pointing at. Either may be `null` when no mouse position was captured.
Response JSON:
```json
{ "answer": "<short direct answer>", "next_steps": ["<tappable follow-up>", "..."] }
```

### `POST /v1/stt` — transcribe one utterance (streaming STT transport)
Multipart form, field `audio` = one utterance WAV (16 kHz 16-bit mono,
`utterance.wav`). The live session sends one chunk per call, as soon as
voice-activity detection ends the utterance — that is the chunked
streaming transport for Milestone 1. (A future step can upgrade this to
a WebSocket stream; the app side is one call site.)
Response JSON: `{ "text": "<transcript>" }` (empty string when nothing was said).

### `POST /v1/talk` — one live-session turn
Request JSON:
```json
{
  "system_prompt": "<the Clicky agent system prompt, verbatim>",
  "text": "<transcribed user speech>",
  "image_png_base64": "<fresh screenshot PNG, base64, or null>",
  "mouse_x": 1234,
  "mouse_y": 567
}
```
`mouse_x` / `mouse_y` are the mouse position in screenshot pixels
(top-left origin, relative to the captured monitor), read with
`GetCursorPos` when the question's frame was captured; the image has a
small butter-ring marker drawn at that spot. Both are `null` when no
screenshot is sent.
Response JSON:
```json
{
  "reply": "<short direct reply>",
  "audio_base64": "<TTS audio, base64, or null>",
  "audio_mime": "audio/wav",
  "next_steps": ["<tappable follow-up>", "..."]
}
```

### `POST /v1/tts` — speak text (used when `/v1/talk` returns text only)
Request JSON: `{ "text": "...", "voice": "<name or null>" }`
Response JSON: `{ "audio_base64": "...", "audio_mime": "audio/wav" }`

## Error behavior

- Provider rate limit hit (Gemini 429): return HTTP 429 with
  `{ "error": "try again in a moment" }`. The app shows exactly that
  plain message — **never a credits/paywall screen**. There is no credit
  system, no usage cap, no paywall anywhere in this app or backend.
- Backend down / not configured: the app shows "Backend not configured
  yet — set workerUrl in backend.json…" and keeps working offline (notch,
  hotkey, capture all still function; only answers need the backend).

## Model rules the Worker must follow

- Attach the app's `system_prompt` verbatim on every model call
  (vision, talk). It carries the always-yes rule: the agent never refuses.
- Gemini key rotation: Fisher-Yates shuffle, never start on the previous
  key, rotate on 401/403/429/503. Never log or return a key.
- Screenshots are never stored — only the text of the conversation is
  kept for context, and only while the session lasts. Client-side, only
  the latest frame ever sits in memory, and it is wiped the moment the
  user toggles the session OFF.

## Continuous screen watch (client-side frame policy)

While the live session is ON, the app captures a fresh screenshot every
1 second and compares it with the previous one ON THE PC (64×36
thumbnail, mean per-channel pixel difference, threshold 0.02 — a
blinking cursor or ticking clock counts as unchanged). If nothing
changed, the frame is discarded in memory and nothing is sent. Only a
changed frame is retained, and a frame reaches the Worker only in one of
these cases:

- the user asks something — the question carries a **fresh** frame
  captured at speech time, even if the screen is unchanged, plus
  `mouse_x` / `mouse_y` (see above);
- a consumer takes a changed frame from the watch (the handoff for
  future proactive/agent use).

The watch loop itself never uploads anything — there is no per-second
endpoint call. The mouse cursor is never in any frame (the capture
session is created with cursor capture forced off), so mouse movement
alone can never count as a change; the cursor position travels only
with a question, as coordinates, never as a recording.

## Design compat — milestone 5 watch tasks (NOT built here)

The M1 watch loop keeps sampling and comparison as separate steps, so
milestone 5 can reuse the sampler without the diff:

- **Watch-and-click:** same ~1 s sampling loop, but the per-tick
  consumer sends the frame to the AI with a goal instead of diffing;
  the AI answers "nothing yet" or "click at x,y" and the app clicks
  via SendInput. The 20-minute stall auto-stop and Retry apply.
- **Watch-a-video:** fixed-interval sampling (~5 s), explicitly NO
  change-detection — a playing video changes every frame, so the diff
  would fire on all of them. Honest limit: snapshots only; a fast thing
  happening entirely between two samples can be missed.

Consequence for this contract: the Worker must never assume that an
image in a `/v1/talk` or `/v1/vision` call implies a detected screen
change — frames also arrive fresh with every question and, from
milestone 5, on fixed sampling intervals.

## Gemini keys — handoff (no new key needed from Hari)

**Hari does NOT need to paste any Gemini key.** All nine Gemini keys
(`custom.gemini-1`..`custom.gemini-9`, plus `custom.gemini`) are already
saved in the Secure Vault. Their values cannot be read out of the vault,
so they cannot be copied into a Worker secret by hand.

The backend builder (parallel task) must define the exact secure
handoff that sets them as Worker secrets — e.g. a deploy step that reads
the vault credentials through the connected Gemini connector and runs
`wrangler secret put` for each, with the values never entering chat,
files, or logs. Until that handoff is done, the Worker cannot call
Gemini and the app will report the backend as not configured / failing —
that is the one open dependency for live answers. The app itself needs
nothing else from Hari.
