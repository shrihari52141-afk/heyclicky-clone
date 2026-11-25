# UI match notes — how each Milestone 1 screen matches the reference look

Source of truth: `../SPEC.md` ("Identical UI" locked rule) and the
observable values in `ui-visual-spec.md` / `drawing-visual-spec.md`
(palette, fonts, timings). All values below are implemented in our own
XAML/code in `src/Clicky/` — no reference XAML, images, icons or font
files are used. Fonts are the public OFL releases
(`src/Clicky/Assets/Fonts/`).

## Notch (collapsed) — `MainWindow.xaml`
- Dynamic-Island-style pill, top-center of the monitor under the cursor,
  8 px from the top edge, multi-monitor aware (repositions on every
  hotkey press). Collapsed size 380×64, corner radius 28, solid ink
  `#1C1E24` (the "cards read ink as solid black" value), borderless,
  topmost, not in the taskbar switcher.
- Contents left→right: our own mascot face (32 px, cream `#FFF3D6` face,
  ink features, mood changes eyes/mouth/blush), status line
  (Barlow SemiBold 13 white) + caption line (Barlow 12, white 75%),
  live listening indicator, Talk (butter `#FFD84D`) / End (coral
  `#F2706B`) pill buttons (radius 16).
- Reference match: same pill position/shape, same dark pill, same
  handwritten + clean type pairing. The mascot is our own drawing in the
  same style (small round face, moods: daydream, bashful, curious,
  sunshine, …), not their image.

## Notch (expanded) — `MainWindow.xaml`
- Expands to 480×520 with a springy scale 0.96→1 + fade, 350 ms,
  cubic-bezier(.4,.1,.3,1) via the Composition API — the easing from the
  visual spec.
- Inside: cream `#FFF3D6` card (radius 20, 8 px inset), answer in
  Patrick Hand 20 with 1.3× line height, next-step chips in butter
  `#FFD84D` (Barlow Medium 13, ink text, radius 14), question box
  (Barlow 14, white field, radius 14) + ink Ask button.
- Reference match: same cream-card-on-dark-pill look, same chip style,
  same handwritten answer type.

## Talk overlay / live session — `LiveSessionService.cs` + notch
- Live listening indicator for the WHOLE session: pulsing butter dot
  (opacity 1↔0.35, 0.8 s) + three butter waveform bars animating ScaleY
  (0.6 s loop, staggered) — visible from the first Ctrl+Alt press until
  the second.
- Live captions in the pill (Barlow 12) update as utterances are
  transcribed and replies arrive; the spoken reply shows in the cream
  card in Patrick Hand.
- Reference match: same always-on listening indicator and live captions
  during a session.

## Drawing overlay — `src/Clicky.Drawing/`
- Overlay window shell: borderless, topmost, full-monitor,
  click-through (`WS_EX_TRANSPARENT`). One real primitive in M1:
  hand-wobbled rings — bow 3% of edge length clamped 2–7 pt, seeded
  jitter so the same mark always wobbles the same way, pen brush 2.8,
  palette colours from the visual spec.
- Reference match: same ring look (wobble, taper-ready stroke, palette).
  Full engine (V8 marks, arrows/highlights/text, scroll anchoring,
  pen-reveal paced to speech) is milestone 4; true per-pixel
  transparency comes with the Win2D/DirectComposition overlay there.

## Agent job view — `src/Clicky.Agents/`
- M1 ships the real job model + runner (status, progress, Stop,
  20-minute stall auto-stop + Retry) and the notch view-model wires job
  changes into an `AgentJobs` collection. The full thread UI (progress
  card under the notch) is milestone 5 — no placeholder job UI is shown
  in M1.

## Not in Milestone 1 (later milestones, same identical-UI rule applies)
- Settings pages, onboarding tour, suggestions view, routines,
  integrations, browser extension, updater, sign-in. No paywall screens
  are ever built (free/unlimited locked rule).
- Sounds: the earcon/sound-effect events are named in the spec but no
  audio files ship in M1 — our own sounds are recorded fresh in a later
  milestone; the app stays silent rather than playing a wrong sound.
