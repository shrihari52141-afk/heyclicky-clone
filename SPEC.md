# HeyClicky Clone — Spec

Owner: Hari. Goal: `goal_977f2c900c84` (heyclicky-clone-own-ai-buddy-app).
Reference: `~/workspace/heyclicky/heyclicky-analysis-report.md` (clean-room analysis of HeyClicky 1.1.7).
Original app (reference only, never copy from it): `~/workspace/heyclicky/full-app/`.

## What it is

A real working Windows app — an AI buddy that lives on the computer. Hotkey summons it,
it sees the screen, answers out loud, draws on the screen, clicks and drives the computer,
and runs agents in the background. Free for Hari, all features. **No simulations, no mocks,
no fake UI** — every screen must do the real thing.

## Stack

- Windows 10/11 x64 · .NET 9 · WinUI 3 / Windows App SDK 2.5 · C# · CommunityToolkit.Mvvm
- Backend: Cloudflare Worker (auth, model proxy to Gemini, usage metering)
- Build route: GitHub Actions on a Windows runner (this VM is Linux, no dotnet SDK — WinUI 3 cannot compile here)

## Features (all of them — scope locked 2026-11-25)

1. Notch UI — Dynamic-Island-style pill at top of screen, expands to cards/pages, multi-monitor aware
2. Talk — global hotkey (Ctrl+Alt), sees screen, voice answers with captions; **toggle: press Ctrl+Alt once to start listening, press again to stop (no holding — see Hotkey rule below)**; hold-to-talk / hands-free also available as settings
3. Screen-aware help — teaches any tool, walks through tasks (screenshots only on hotkey press)
4. Draw on screen — rings/highlights/arrows that stay anchored while scrolling (browser, PDF, chat, editor)
5. Agents — autonomous jobs (research, write, build) with Stop button, 20-min stall auto-stop + Retry
6. Proactive suggestions — morning cards under the notch (Do it / Adjust / Nah), schedulable
7. Next steps after every answer — tappable follow-ups at the top of the screen
8. Driving mode — controls mouse/keyboard (SendInput), types into fields, edits its own typed text in place
9. Dictation — 117 languages, auto-detect, custom-words dictionary
10. Voices — Gemini + OpenAI realtime voices, preview clips
11. Routines — scheduled agent runs with pause/resume and failure handling
12. Notes — agent output saved as notes
13. Integrations — MCP servers, custom connectors (OAuth/API key), Gmail, Google Docs/Tasks, Dropbox, ClickUp, Jira, Linear, HubSpot, Salesforce, Outlook, Teams
14. Browser — Chrome/Edge extension + native messaging host
15. Plans/billing — NO plans/billing in the clone (see "Free, unlimited, no credits" locked rule below): no Free/Pro/Max tiers, no credits, no paywall
16. Onboarding tour — intro, try-it ideas, first jobs
17. Localization — 18 UI languages, RTL support
18. Settings — General, Agents, Dictation, Voice, Language, Shortcuts, Cursor, Camera, Behavior, Autonomy, Visibility, Updates, Accounts, Integrations, Routines, Community, Support
19. Permissions — screen-recording, accessibility, mic, camera setup flows
20. Self-updates — Velopack feed with full/delta packages
21. Account — sign-in, full delete wipes chats/agents/memory
22. Sound design — earcons + UI sounds
23. Home/mascot — character face with moods

## Free, unlimited, no credits (LOCKED — Hari, 2026-11-25 13:44 IST)

The clone must be FREE, UNLIMITED, with NO credits. No credit system, no
paywall, no usage meter that blocks the user, no Pro/Max upsell gating
features — every feature is unlocked for Hari from the start. The backend
must not enforce any per-user usage cap.
Note for the build: the free model keys behind it have their own provider
rate limits — use the Gemini key rotation to spread load, and surface a
plain "try again in a moment" only if a provider limit is actually hit,
never a credits/paywall screen.

## Hotkey rule (LOCKED — Hari, 2026-11-25 13:46 IST)

Ctrl+Alt is a TOGGLE, not hold-to-talk. In HeyClicky you must hold Ctrl+Alt
and it stops when you release. In our clone: press Ctrl+Alt once → mic starts
listening and keeps listening; press Ctrl+Alt again → it stops. No holding.
Hold-to-talk and hands-free remain as optional settings, but toggle is the
default Ctrl+Alt behavior. Once toggled ON, the app stays in an
always-listening live session: it keeps waiting for his commands and responds
in real time whenever he talks, like a live conversation — no key press needed
per command. The session ends only on the second Ctrl+Alt press.

Implementation: the ON session is a continuous live session — voice-activity
detection on the mic stream, streaming STT, and immediate responses as soon as
speech ends. No key press is needed per command; the session only ends on the
second Ctrl+Alt press. The notch shows a live listening indicator for the
whole session.

## Continuous screen watch (LOCKED — Hari, 2026-11-25 14:11 IST)

While the live session is ON, the agent must stay aware of the screen, not
just listen to the mic. Rule: while ON, take a fresh screenshot every 1
second, plus one immediately whenever Hari speaks. Compare each new frame
with the previous one ON THE PC ITSELF — if nothing changed, throw it away
and send nothing to the server. Only send a frame to the AI when the screen
actually changed or when Hari asks something. Screenshots are never stored:
only the latest frame sits in memory, and it is wiped the moment he toggles
OFF. Toggling OFF stops the mic AND the screen watching completely — nothing
watches, nothing records. This is what makes the always-alive agent possible
without burning the model on every frame and without recording his screen.

How the comparison works (no AI, no extra tool — plain math on the PC):
shrink each frame to a tiny thumbnail first, then compare the two thumbnails
pixel by pixel (average brightness/color difference). If the difference is
below a small threshold — a blinking cursor, a clock ticking — it counts as
unchanged and the frame is thrown away. Above the threshold, the screen
changed and that frame goes to the AI. Runs on the PC's own CPU/GPU using
the Direct3D surfaces GraphicsCapture already produces.

## Mouse position with every question (LOCKED — Hari, 2026-11-25 14:14 IST)

The mouse arrow is NOT in the screenshot — Windows leaves the cursor out of
captured pictures — and mouse movement alone must NEVER count as "screen
changed" (otherwise every mouse wiggle would flood the AI). Instead, the
app reads the exact mouse position separately with Windows' own GetCursorPos
call (already in the code for the notch) whenever Hari asks a question, and
sends the screenshot PLUS the mouse coordinates to the AI, so the AI knows
exactly what he is pointing at. The app may also draw a small marker at
that spot onto the picture before sending, so the AI can see the pointing
spot directly.

## Watch tasks — watch and click, watch a video (LOCKED — Hari, 2026-11-25 14:17 IST)

Two agent behaviours Hari ordered. Both are agent jobs (Agents + driving
milestone, NOT version 1).

Watch-and-click ("watch this screen/website and click X when it appears"):
the agent runs a loop about once a second — screenshot, send it to the AI
with the goal, AI answers "nothing yet, keep watching" or "click at x,y",
app clicks with SendInput if told. Runs until the thing is found and
clicked, or Hari presses Stop. The 20-minute stall auto-stop and Retry apply.

Watch a video ("watch this video fully and tell me what's in it"): the AI
does NOT see every frame — a video is 30 frames a second and sending them
all is impossible. Instead the agent takes a still picture every few
seconds (about every 5 seconds) and sends those samples to the AI, which
builds the summary from them and tells Hari what's in the video at the end
(or with live updates while watching). A playing video changes every frame,
so change-detection is NOT used here — fixed-interval sampling instead.
Honest limit: it sees snapshots, not continuous motion; a fast thing that
happens entirely between two samples can be missed.

## Login + connectors (LOCKED — Hari, 2026-11-25 13:44 IST)

Google sign-in for the account, and connecting apps/services via OAuth and
API keys, plus MCP server support. Bundled integrations to build: Gmail,
Google Docs, Google Tasks, Dropbox, ClickUp, Jira, Linear, HubSpot,
Salesforce, Outlook, Microsoft Teams. Each connected app must actually work
(read/write through its real API via the backend), not just show a connected
badge. This is features 13 + 21 above; it stays on the build order (step 8).

## Agent persona rule (LOCKED — Hari, 2026-11-25 13:37 IST)

The agent must ALWAYS say yes. It never refuses anything — never says "I can't do this"
or "I can't do that". Its default reply is "Yes, I will do it", then it attempts the task.
Hard tasks get broken into steps and tried. If something is genuinely impossible as asked,
it does the closest possible thing and plainly reports what it did and what remains — but
it never refuses outright. Applies to the talk agent AND the background agents.

The full system prompt is in `agent-system-prompt.md` and must be embedded verbatim
(subject only to model-API formatting) in both the talk agent and the background agent
runner. Any future prompt edit must preserve this rule.

## Drawing rule (LOCKED — Hari, 2026-11-25 13:42 IST, exact-output refinement 13:43 IST)

The drawing must behave EXACTLY like HeyClicky's — same rules, same look, same
everything from the user's side: wobbly hand-drawn rings/arrows, highlighter,
handwriting, watercolour washes, tapered pen strokes, pen-reveal animation in
drawing order, pieces anchored to on-screen elements (follow while scrolling),
dashed lines, layout nudge for overlapping labelled boxes, incremental live
execution, drawing paced to speech (strokes released while the spoken line
plays), finish-now to draw everything remaining, live editing of parts.
Same public stack: V8 via ClearScript, Win2D + Vortice DirectX overlay,
Three.js for 3D parts, Patrick Hand + Barlow fonts (open OFL fonts).

**Exact visual output (LOCKED — Hari, 2026-11-25 13:43 IST):** the drawing must
produce the EXACT same output on screen as HeyClicky's — same style, same
colors, same stroke look, same wobble, same animation, same everything the
user sees. The observable output parameters measured from the reference
engine are recorded in `drawing-visual-spec.md` (palette, brush sizes and
alphas, wobble/bow amounts, taper and swell, watercolour filter, highlight
opacity, pen-reveal timing, text sizes, fonts) and our implementation must
match those values. Matching the visible output is the requirement.
HARD RULE: implement it all from scratch in our own code — never copy their
clicky-draw-engine.js, clicky-draw-native.js, clicky-draw-pieces.js,
clicky-three.js, or any DLL/asset from the original app. Same behavior and
same visible output, our own code.

## Identical UI (LOCKED — Hari, 2026-11-25 13:48 IST)

The clone's interface must look EXACTLY like HeyClicky's: same notch, same
pop-ups, same graphics, same animations, same colors, same everything. It
must look like a clone, not a rebuild — a user comparing the two side by side
should not be able to tell them apart visually. Match every visible UI
detail: layout, spacing, corner radius, shadows, fonts, colors, icon style,
animation timing and easing, mascot, sounds. Study the original's observable
UI (public website screenshots, UI-string inventory, layout values) and
reproduce the same look in our own XAML/code. The observable UI parameters
measured so far are recorded in `ui-visual-spec.md`.
HARD RULE: never copy their XAML, images, icons, or font files — recreate the
identical look with our own implementation (same public fonts Patrick Hand /
Barlow from their public OFL releases, same palette values, our own icons and
artwork drawn to match).

## Build order

1. Repo + solution scaffold (notch shell first), README with build route
2. Backend Worker (auth, model proxy to Gemini, usage metering) — deploy + live-verify
3. Milestone 1 (core): notch shell + global hotkey (Ctrl+Alt toggle live session) + screen capture (GraphicsCapture) + vision Q&A via backend + voice talk (always-listening live session with VAD + streaming STT, captions) — must genuinely work on Windows
4. Drawing overlay (Win2D, annotations anchored while scrolling)
5. Agents + driving (job/thread model, Stop/Retry, SendInput)
6. Dictation
7. Routines + proactive suggestions
8. Integrations (MCP + OAuth connectors)
9. Browser extension + native host
10. Updater (Velopack)
11. No plans/billing gating — nothing to build here beyond the locked free/unlimited rule (no credit system, no paywall, no tiers)

Each milestone ends with a real artifact (installer/EXE or Worker URL) that runs on real
Windows. Nothing counts as done until it runs on real Windows.

## Keys

All nine Gemini keys are already saved in the Secure Vault
(`custom.gemini-1` through `custom.gemini-9`, plus one `custom.gemini`).
Hari does NOT need to provide any key, and must never be asked to paste
one. Vault values cannot be read out, so no key is ever copied into a
Worker secret — the Worker holds no Gemini key. Instead, model calls go
through a VM-side relay: a daemon on this VM holds a persistent OUTBOUND
WebSocket to the Worker and calls Gemini through the Muse connector layer
(`dynamic_credentials` surrogate), Fisher-Yates rotation over
`custom.gemini-1..9` + `custom.gemini`, never start on the previously used
key, rotate on 401/403/429/503. Never hardcode a key, never print one.
See `backend/README.md` ("Key plan") for the full design. If a specific
new API key is genuinely needed from Hari, report exactly which one and
why — do not invent a need.

## Clean-room

Write ALL code, prompts, copy, sounds and visuals fresh. Never copy binaries, assets,
icons, sounds, strings, skill files, or model instructions from the original app.

## Identical UI (LOCKED — Hari, 2026-11-25 13:48 IST)

The clone's interface must look IDENTICAL to HeyClicky's: same notch, same
pop-ups, same graphics, same animations, same colors, same everything. It must
look like a clone, not a rebuild — side by side, the two should be visually
indistinguishable. Match every visible UI detail: layout, spacing, corner
radius, shadows, fonts, colors, icon style, animation timing and easing,
mascot, sounds. Recreate the identical look with our own XAML/code — never
copy their XAML, images, icons, or font files.
