# Drawing Visual Spec — HeyClicky Clone

Owner: Hari. Source of truth: `SPEC.md` (Drawing rule, exact-output refinement
2026-11-25 13:43 IST). This file records the OBSERVABLE output parameters of
HeyClicky's on-screen drawing, measured from the reference engine's behavior
on 2026-11-25. Our implementation must reproduce these same visible values
in our own from-scratch code. No reference code is copied here — only the
numbers and rules that define what the user sees.

Reference engine: "Clicky draws: lab engine 1.6" (JS draw engine, runs on V8
via ClearScript; rendered through a Win2D + Vortice DirectX overlay;
Three.js r186 for 3D parts). The model sends a drawing as data (marks) or as
a tiny program that makes marks; the engine turns marks into hand-drawn SVG.

## Colour palette (2D marks)

| name | hex |
|---|---|
| ink | #30333A (soft near-black; reads as solid black on cards — #1C1E24 is the card-read value) |
| white | #FFFFFF |
| grey | #7E838D |
| butter | #FFD84D |
| sun | #FFB930 |
| orange | #FF9A3C |
| peach | #FFB59A |
| coral | #F2706B |
| red | #E5484D |
| pink | #F59AB5 |
| lilac | #A897F5 |
| violet | #6E5BD8 |
| sky | #5AA8F5 |
| blue | #1F5FCC |
| mint | #7ED6A0 |
| leaf | #3E9E5C |
| brown | #A0673D |
| tan | #D9A877 |
| cream | #FFF3D6 |

A hex colour given directly by a drawing is used as-is. A "shade" helper mixes
a hex toward black by a factor k (0..1).

3D figures use a separate, more realistic palette (same names, photo-like
values, not the candy ink): ink #2C2E33, white #E8E6E1, grey #8B8E93,
butter #E0C477, sun #D6A83C, orange #C9692E, peach #D8A287, coral #C1604F,
red #A8352D, pink #C7848F, lilac #9E92C0, violet #5D4D90, sky #8AAFCC,
blue #2F5689, mint #94BCA2, leaf #53794A, brown #6D4A2F, tan #B9946F,
cream #E4D9C2.

## Brushes

| brush | size | alpha |
|---|---|---|
| pen | 2.8 | 1.0 |
| marker | 8 | 0.9 |
| pencil | 1.8 | 0.85 |
| brush | 6 | 0.95 |

## Hand-drawn wobble (HAND = 1, full original wobble)

- Wobble amount is 1 on a 0–1 scale (0 = ruler-straight, 0.35 = the rejected
  "clean chart-tool" look). Use the full original wobble.
- Every straight edge bows once, clearly, to one side: bow is 3% of the
  edge's length, clamped to 2–7 points (short edges under 24pt bow 3%
  anyway). The bow direction is one side per edge, chosen at random.
- Edges are subdivided into segments of at most 5pt; corners land up to the
  bow amount off their ideal position (jitter).
- Smoothing: Catmull-Rom spline through the points (segment count scales
  with length, ~1 point per 4pt, min 2, max 3× the base segment count).
- The wobble is SEEDED: the same drawing always wobbles the same way
  (deterministic seeded noise, LCG-style). Re-rendering the same marks must
  give identical wobble.
- "Pen" bow style: one clear single bend per edge (the old walkthrough's
  hand). Default bow style: small random bend ("paper look").
- Dashed lines: centreline cut into hand-drawn dashes (on/off lengths from
  the mark's dash setting).

## Taper and swell (felt-pen look)

- Strokes are drawn as tapered outlines around a centreline (a small cousin
  of perfect-freehand): light taper into and out of each stroke, with a
  slight swell along it, like a felt pen.
- Taper ramp: min(total length × 0.3, size × 5), scaled by the mark's taper
  factor (default 1).
- Taper 0 = the "screen pen": one even width end to end with round ends, no
  felt-pen swell (used for the on-screen pointing marks).
- Multi-piece strokes (e.g. dashed pieces) use taper 0.3; arrow heads use
  taper 0.4.
- Arrow head: half-opening angle π/7.
- A "heartbeat" swell: strokes swell and shrink back along their length,
  amount 0.08 (8% bigger at fullest).

## Watercolour wash

- Fills get a watercolour filter: fractal-noise turbulence, base frequency
  0.035, 2 octaves, seed 3; displacement map scale 3.5.
- The wash is skipped when a mark sets wash off (label pills, number badges
  stay crisp) and for very large fills (costly to animate).
- Pencil strokes additionally get a grain filter.

## Highlighter

- Default tone: butter (#FFD84D).
- The band is a hand-drawn quad: slight bow (±1–2px on the control points),
  fill opacity 0.72, blend mode multiply (no multiply on a "sky" surface).
- Behind text: the band pads the text box by 6px on the sides and 2px
  top / 2px bottom (box is w+12, h+4, offset −6, −2).
- Draw (swipe) duration: 0.35 s.
- Coral marker variant (used to mark words or trace thin strokes): marker
  brush, size 13, alpha 0.5, taper 0.4.

## Pen-reveal animation (drawing order, paced)

- The pen draws at: duration = clamp(0 + length / 600, min 0.14 s, max 0.7 s)
  per stroke, where length is in canvas points.
- Easing for the pen: cubic-bezier(.4, .1, .3, 1). Other animations ease-out.
- Per-mark natural durations: arrow = pen duration + 0.16 s (advance +0.10 s);
  circle/ellipse = pen duration of π × (rx + ry) × 1.06 (0.3 s if no outline);
  highlight = 0.35 s; text = 0.4 + 0.015 s per character (advance
  (0.35 + 0.012 s per character) × 0.7); molecule = 0.6 s; path with curves =
  0.4 s, otherwise pen duration of its points.
- Edit timings: erase runs each pen backwards in 0.4 s (staggered, capped);
  repaint redraws at 0.55 pace; move/scale glides take 0.5 s; highlight edit
  0.6 s; recolor/restyle minimum 0.3 s. Brisk edits: stagger 0.03 s,
  spread 0.3 s.
- Speech pacing: strokes after a spoken line are released while that line is
  spoken and spread across it; default gap between groups 0.25 s (0 when
  continuous); fastest pace 0.35 s, slowest 2 s. `finishNow` draws everything
  still waiting immediately (the voice carries on).
- The animation clock starts at 0.15 s. Marquee (drag-open selection frame)
  takes 0.55 s.
- Halo/glow: a screen mark's glow is a real blurred shadow in its own colour
  ([opacity, radius]); otherwise a halo outline is drawn under strokes of
  that ink instead of blurred CSS shadows.

## Text

- One handwriting for everything drawn: Patrick Hand (all styles — hand,
  title, body, mono, caps). Titles are drawn bold (weight 600; Patrick Hand
  has one weight, so bold is rendered by the renderer).
- Barlow is used ONLY for library cards (generative widgets); screen drawings
  always keep Patrick Hand.
- Sizes: title 24, body 17, caps 14, default 20. Minimum readable size 13
  (UI name pills/badges: floor 8pt).
- Line height: 1.3 × font size.
- Caps style: upper case, weight 600, letters tracked out with hair spaces
  (Latin/Greek/Cyrillic only — joined scripts like Arabic/Devanagari are
  left alone).
- Name pills/badges that mark the real screen use the system font
  (system-ui, sans-serif). Newspaper-style headlines use a classic serif
  (Georgia, Times New Roman).
- UI words are sized in screen points, not canvas units (on a big display one
  canvas unit is ~2pt).

## Anchors and layout

- Pieces can be anchored to on-screen elements (graph axes/curves/shifts/
  crossings/marked points, timelines). Anchored pieces follow their element
  while it scrolls or is dragged.
- Layout check for labelled boxes: boxes that pile on each other are warned
  about and nudged when safe.
- Every piece of a drawing has an id (p1, p2, … in program order) and every
  mark an id (m0, m1, …); each has a short description and a bounding box.
- Live editing ops on the existing card, each animated in the engine's style:
  recolor, restyle, move, moveTo, scale, erase (pen runs backwards), redraw,
  add, highlight, undo. A new edit can cut into a running one (settle jumps
  it to its end). Pause/resume holds the pen after the current stroke.
- Incremental live execution: each new statement runs once instead of
  re-running the prefix.
- The drawing context is sandboxed (optional Web Worker sandbox with a time
  limit): no network, no files, no native bridge beyond the host functions.

## What NOT to copy

The values above are the visible output. Implement them from scratch in our
own code. Never copy the reference engine's source files, its DLLs, its
fonts' bundled files (use the public OFL Patrick Hand / Barlow releases
instead), or its UI strings. Three.js is a public MIT library (r186 in the
reference); use the public release.
