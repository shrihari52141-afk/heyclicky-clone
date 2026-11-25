# Clicky — an AI buddy that lives on your computer

A clean-room clone of HeyClicky 1.1.7 (Windows). Notch UI, voice talk
with an always-listening live session, screen-aware answers, on-screen
drawing, background agents. **Free and unlimited, no credits, no
paywall, no tiers — ever.**

> Clean-room: every line of code, prompt, copy, visual and sound in this
> repo is written fresh. The original app was studied only through its
> public website, release notes and observable behavior. Nothing is
> copied from it — no binaries, assets, icons, sounds, strings or code.

## Milestone 1 — what works

- **Notch shell** — Dynamic-Island-style pill, top-center of the monitor
  under the cursor (multi-monitor aware), borderless, topmost. Collapsed
  380×64, expands to 480×520 with a springy cubic-bezier(.4,.1,.3,1)
  animation. Dark ink `#1C1E24` pill, cream `#FFF3D6` answer card,
  butter `#FFD84D` next-step chips, Patrick Hand for answers, Barlow for
  UI. Our own mascot face with moods. See `docs/ui-match-notes.md` for
  the per-screen match against the reference look.
- **Global hotkey — Ctrl+Alt is a TOGGLE (locked rule).** Press
  Ctrl+Alt once → the live session starts and keeps listening; press
  Ctrl+Alt again → it stops. No holding. (Technically the binding is
  Ctrl+Alt+Space — `RegisterHotKey` needs a virtual key; the key is
  configurable in settings. Hold-to-talk / hands-free stay as optional
  settings, toggle is the default.)
- **Always-listening live session (locked rule).** While ON, the app
  listens continuously: energy-based voice-activity detection on the
  16 kHz mic stream segments speech into utterances, each utterance is
  sent to the backend for STT as soon as it ends, and the reply is
  spoken back immediately — no key press per command. Barge-in stops
  playback when you start talking. The notch shows a live listening
  indicator (pulsing butter dot + waveform bars) for the whole session.
  The session ends only on the second Ctrl+Alt press (or End in the
  notch).
- **Screen capture + continuous screen watch (locked rules).** Real
  Windows GraphicsCapture of the monitor under the cursor, one frame →
  PNG. Nothing stored on disk. While the live session is ON, the watch
  loop takes a fresh screenshot every 1 second and compares it with the
  previous one ON THE PC — plain math on a 64×36 thumbnail (mean
  per-channel pixel difference, threshold 0.02, so a blinking cursor or
  ticking clock counts as unchanged). Unchanged frames are thrown away
  in memory and nothing is sent; only the latest changed frame sits in
  memory, and toggling OFF wipes it immediately. The mouse cursor is
  never in a frame (cursor capture forced off in the session), so mouse
  movement alone can never count as a change — instead, every question
  carries the exact mouse position (`GetCursorPos`, screenshot pixels)
  plus a small butter-ring marker drawn at that spot, so the AI knows
  what he is pointing at. The 1-second sampler and the pixel-diff are
  separate steps on purpose: milestone 5 watch-and-click reuses the
  sampler, and watch-a-video samples on a fixed ~5 s interval with no
  diff at all (see `docs/backend-contract.md`).
- **Vision Q&A** — type a question (or tap a next-step chip): fresh
  screenshot + question go to the backend Worker, answer + follow-ups
  come back into the cream card.
- **Voice talk** — mic capture (NAudio), STT + TTS through the backend,
  live captions in the notch.
- **Agent system prompt** — embedded verbatim from
  `src/Clicky.Core/Prompts/agent-system-prompt.md` and attached to every
  backend call, so the always-yes rule survives in every request.
- **Agents (engine)** — real job model + runner: start/stop, progress,
  20-minute stall auto-stop + Retry. The full agent thread UI is
  milestone 5.
- **Drawing (shell)** — borderless topmost click-through overlay window
  + one real primitive (hand-wobbled rings, seeded wobble per the visual
  spec). Full engine in milestone 4.

## What does NOT work yet (honest gaps)

- **Backend URL is a placeholder.** `backend.json` ships with
  `https://clicky-backend-REPLACE-ME.workers.dev`. Until the Cloudflare
  Worker is deployed and this URL is set, Talk/Ask show a plain
  "Backend not configured yet" message instead of answers. The notch,
  hotkey, capture and session still run. See `docs/backend-contract.md`.
- **Gemini keys:** all nine keys are already in the Secure Vault — Hari
  does NOT need to paste any key. The open item is the vault→Worker
  secret handoff, which the backend builder must define (see
  `docs/backend-contract.md`).
- **Overlay transparency:** the drawing overlay shell is borderless /
  topmost / click-through; true per-pixel transparency arrives with the
  Win2D/DirectComposition overlay in milestone 4.
- **Sounds:** no audio files ship in M1 — our own earcons/sounds are
  recorded fresh in a later milestone; the app stays silent rather than
  playing a wrong sound.
- **Runtime is unverified on real Windows** until someone runs the
  published EXE: CI proves it compiles and publishes; the live-session
  behavior — including the 1-second screen watch, the thumbnail diff
  threshold, the frame wipe on toggle OFF, and the mouse marker — still
  needs a real Windows run.

## Build route (this VM is Linux — WinUI 3 cannot compile here)

GitHub Actions on a Windows runner (`.github/workflows/build-windows.yml`):
the workflow also downloads the public OFL fonts (Patrick Hand + Barlow)
and generates placeholder logos before building, since binary assets are
not stored in the repo. For a local Windows build, run
`scripts/fetch-fonts.ps1` first, then `dotnet build Clicky.sln -c Release`.

1. Push to `main` (or open a PR, or run manually).
2. The workflow restores, builds Release x64, and `dotnet publish`
   self-contained win-x64 into `publish/`.
3. It uploads `publish/` as the `Clicky-win-x64` artifact and attaches
   `Clicky-win-x64.zip` to the rolling `m1-latest` pre-release.

## Run on Windows

1. Download `Clicky-win-x64.zip` from the `m1-latest` pre-release (or the
   workflow artifact) and unzip it anywhere.
2. Edit `backend.json` next to `Clicky.exe` and set `workerUrl` to the
   deployed Worker URL.
3. Run `Clicky.exe`. Press **Ctrl+Alt+Space** to start talking; press it
   again to stop. Type a question in the notch and press Enter to ask
   about your screen.
4. Settings live in `%LOCALAPPDATA%\Clicky\settings.json`
   (hotkey mode, VAD thresholds, voice, language).

## Project layout

```
Clicky.sln
backend.json                  # Worker URL (placeholder until deployed)
docs/
  backend-contract.md         # Worker endpoint contract + key handoff
  ui-match-notes.md           # per-screen match vs the reference look
src/
  Clicky/                     # WinUI 3 app: notch, hotkey, voice, live session
  Clicky.Core/                # backend client, prompt, screen capture
  Clicky.Drawing/             # overlay shell + ring primitive (engine in M4)
  Clicky.Agents/              # job model + runner (Stop / 20-min stall / Retry)
```

## Locked rules (from SPEC.md — do not change without Hari)

- Agent **always says yes** — never refuses; default reply is
  "Yes, I will do it", then it attempts the task.
- **Free, unlimited, no credits** — no credit system, no paywall, no
  usage cap, no tiers. A provider rate limit surfaces only as a plain
  "try again in a moment".
- **Ctrl+Alt toggle + always-listening live session** (see above).
- **Continuous screen watch** — 1-second screenshots, on-PC thumbnail
  pixel-diff with threshold, changed frames only, latest frame only in
  memory, wiped the moment the session toggles OFF; cursor never in a
  frame, so mouse movement never counts as a change.
- **Mouse position with every question** — `GetCursorPos` coordinates
  plus a marker drawn at the mouse spot, sent with the screenshot.
- **Drawing** must behave and look exactly like the reference, rebuilt
  from scratch in our own code (see `drawing-visual-spec.md`).
- **Identical UI** — same notch, pop-ups, graphics, animations, colors;
  recreated in our own XAML/code, never copied.
- **Clean-room** — write everything fresh; never copy the original's
  code, assets, strings, DLLs or files.
