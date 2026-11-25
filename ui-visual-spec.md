# UI Visual Spec — HeyClicky Clone

Owner: Hari. Source of truth: `SPEC.md` ("Identical UI" locked rule,
2026-11-25 13:48 IST). This file records the OBSERVABLE look of HeyClicky's
interface, so our own XAML/code can reproduce it pixel-for-pixel in behavior
and appearance. No reference XAML, images, icons, or font files are copied
here or into the build — only measured values and descriptions of what the
user sees. Where a value could not be read from the package, the source to
study is named (public website screenshots at heyclicky.com).

## Screens to reproduce

- **Notch (collapsed → expanded)** — Dynamic-Island-style pill at the top
  of the screen; the main interaction surface. Collapses to a small pill;
  expands to cards/pages. Multi-monitor aware (moves to the hovered
  screen's notch).
- **Talk overlay** — voice conversation with live captions and next-step
  chips; live listening indicator while the always-listening session is on.
- **Agent job view** — thread, live progress, Stop / Retry.
- **Suggestions view** — morning cards, "See all" spreads them on screen
  with hover plans.
- **Drawing overlay** — full-screen transparent overlay; annotations
  anchored to content (see `drawing-visual-spec.md` for the drawing look).
- **Settings** — multi-page: General, Agents, Dictation, Voice, Language,
  Shortcuts, Cursor, Camera, Behavior, Autonomy, Visibility, Updates,
  Accounts, Integrations, Routines, Community, Support.
- **Onboarding tour** — intro video, 7 try-it ideas, first jobs.
- **Plans / paywall** — NOT in the clone (free/unlimited locked rule); do
  not build paywall screens.
- **Update window** — download + install progress.
- **Sign-in / permissions setup** — Google sign-in, OS permission grants.
- **Home** — mascot + greeting.

## Colours

The app's ink palette is the TONES palette recorded in
`drawing-visual-spec.md` (ink #30333A soft near-black, grey #7E838D,
butter #FFD84D, sun #FFB930, coral #F2706B, red #E5484D, violet #6E5BD8,
sky #5AA8F5, blue #1F5FCC, mint #7ED6A0, leaf #3E9E5C, cream #FFF3D6, and
the rest). Cards read ink as solid black (#1C1E24 on cards). Use these same
values for UI chrome, not just drawings.

## Fonts

- UI text in drawings and handwritten elements: Patrick Hand (public OFL
  release — fetch from the public source, never from the reference app).
- Library cards / clean UI text: Barlow (Regular / Medium / SemiBold,
  public OFL release).
- Name pills / badges that mark the real screen: system font
  (system-ui, sans-serif).
- Newspaper-style headlines: Georgia / Times New Roman serif.
- Drawn text sizes: title 24, body 17, caps 14, default 20; line height
  1.3× font size (see `drawing-visual-spec.md`).

## Animation timing and easing (measured)

- Pen reveal easing: cubic-bezier(.4, .1, .3, 1); other animations ease-out.
- Marquee (drag-open selection frame): 0.55 s.
- Pen stroke duration: clamp(length / 600, 0.14 s, 0.7 s).
- Highlight swipe: 0.35 s. Erase: 0.4 s per pen. Move/scale glide: 0.5 s.
- The app's spring settles a little after a frame drags open (marquee).
- The notch expands/collapses with a springy ease (match the
  cubic-bezier(.4,.1,.3,1) feel used across the app).

## Mascot

A small character face on the home screen with moods: daydream, bashful,
curious, sunshine, and others. Recreate the same character style with our
own artwork — same look and moods, drawn fresh, never the original image
files.

## Sound design (inventory — names only; recreate our own sounds)

The original ships 17 earcons + 69 sound effects. Earcons (short UI
jingles): agent-close, agent-done, agent-launch, agent-needs-you,
clicky-question, clicky-surprised, clicky-text-close, clicky-text-open,
clicky-text-receive, clicky-text-send, connection-question, hatching,
home-reveal, reveal-boot, skill-down, skill-up, tapback-thumbs-up.
Sound-effect families (multiple variants each): badge-pop, bin-drop, boing,
build-3d, button-appear, copy-tick, and more (clicks, pops, paper, typing,
chimes). Tour music: one m4a track. Our clone must have the same sound
events at the same moments, with our own freshly made sounds in the same
style — never copy the .wav/.mp3/.m4a files.

## Voice previews

30 Gemini voices + 10 OpenAI realtime voices, each with a preview clip.
Our clone: same voice list and preview behavior, with our own preview
audio generated through the backend.

## Localization

18 UI languages in the original (en, es, ar, pt-BR, hi, fr, de, ru, ur, it,
zh-Hans, nl, tr, id, ko, ja, pl, he; RTL for ar/ur). Our clone must support
the same language list with our own translated strings — never copy the
original's string files. Tamil is not among the original's languages.

## What to study

- Public website screenshots and videos at heyclicky.com (hero, notch,
  talk overlay, drawing, agents) — the primary visual reference for layout,
  spacing, corner radius, shadows, and the notch shape.
- The onboarding intro video and spatial demo describe the intended look
  and motion; recreate the same motion in our own code.
- The UI-string inventory (3,132 strings) defines what copy appears where;
  write our own copy to match in meaning and placement, not the original's
  wording verbatim.

## What NOT to copy

Never copy XAML, images (.png/.svg/.ico), icons, font files, sound files,
videos, or string files from the reference app. Recreate the identical look
with our own implementation: our own XAML, our own icons/artwork, public
OFL font releases, our own sounds, our own copy.
