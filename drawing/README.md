# Drawing engine — HeyClicky clone (clean-room)

From-scratch rebuild of the observable drawing behaviour in
`../drawing-visual-spec.md`. No reference engine source, DLL, or asset was
read or copied; only the numbers in the visual spec were used.

## Files

- `draw-engine.js` — the engine. Dependency-free, no DOM needed; runs in
  V8 (ClearScript in the .NET app) or Node. UMD: `require('./draw-engine.js')`
  or `window.ClickyDraw`.
- `draw-engine.test.js` — Node tests, no extra deps. Run:
  `node --test draw-engine.test.js` (7 tests, all passing).
- `demo.html` — open in a browser; renders a ring + arrow + highlight +
  handwritten label, with Replay / Live (speech-paced) / determinism check.
- `fonts/` — Patrick Hand + Barlow (OFL), fetched from the public
  google/fonts repo. The app bundles these; the demo also loads them from
  Google Fonts CDN for convenience.

## API

```js
const D = require('./draw-engine.js');

// Static render: marks -> SVG string (pen-reveal baked in as CSS).
const svg = D.render(marks, { width: 800, height: 600, anchors: { btn: { x, y } } });
// Detailed: { svg, marks: [{id,type,description,start,dur,end,bbox}], nudges, warnings }
const d = D.renderDetailed(marks, opts);

// Live incremental execution, speech-paced, with a host bridge.
const ctl = D.live(spec, host, { pace: 'speech' | 'off', sandbox: true });
ctl.start();
ctl.pause(); ctl.resume(); ctl.finishNow(); ctl.settle();
ctl.recolor(id, color); ctl.restyle(id, patch);
ctl.move(id, dx, dy); ctl.moveTo(id, x, y); ctl.scale(id, factor);
ctl.erase(id); ctl.redraw(id); ctl.add(mark); ctl.highlight(id, color);
ctl.undo(); ctl.svg(); ctl.dispose();
```

`spec` is a mark array, `{ marks }`, `{ steps: [{ marks, say, duration }] }`,
or a data program `{ program: [{ op: 'circle'|'arrow'|..., ... }, { op: 'say', text, duration }] }`.
Function programs are rejected when `sandbox: true` — the sandbox only
accepts data statements (in the app, the Worker + time limit enforces it).

`host` supplies `onMark(mark, timing)`, `onDone`, `onSay`, `onEdit`,
`resolveAnchor(id)`, and optionally `setTimeout`/`clearTimeout`.

Marks: `line, arrow, circle, ellipse, rect, path, text, highlight, dot,
graph, timeline, molecule, dashed`. Anchors: `mark.anchor = { id, dx, dy }`
(or a string id); the host resolves ids to screen positions so drawings
follow scrolling. `D.threeScene(marks)` returns a data-only scene for the
host's public Three.js r186 renderer.

## Spec values implemented

Palette (2D + 3D), brushes (pen 2.8/1.0, marker 8/0.9, pencil 1.8/0.85,
brush 6/0.95), seeded wobble (bow 3% clamp 2–7, short edges <24pt bow 3%,
segments ≤5pt, Catmull-Rom), taper ramp min(len·0.3, size·5) + 8% heartbeat
swell, taper 0 = even screen pen, dashed taper 0.3, arrow head π/7,
watercolour wash (feTurbulence 0.035, 2 octaves, seed 3, displacement 3.5),
pencil grain, highlight butter #FFD84D opacity 0.72 multiply, padding
w+12/h+4 offset −6/−2, swipe 0.35s, penDur clamp(len/600, 0.14, 0.7),
per-mark durations, clock start 0.15s, group gap 0.25s, speech pacing
0.35–2s, edit timings (erase 0.4s backwards, repaint 0.55, move/scale 0.5,
highlight edit 0.6, recolor min 0.3, stagger 0.03, spread 0.3), text sizes
(title 24, body 17, caps 14, default 20, min 13, pill floor 8), line height
1.3, caps hair-spacing (Latin/Greek/Cyrillic only), layout nudge for
overlapping labelled boxes, ids p1…/m0…, descriptions + bboxes.

## Known gaps (honest)

- Closed shapes (circle/ellipse/rect) render as wobbly stroked paths, not
  tapered-outline polygons — SVG strokes can't vary width along a path, and
  the outline-polygon builder is only exact for open strokes. Visually the
  same weight; the felt-pen taper shows on open strokes (lines/arrows/paths).
- Text width is estimated (~0.5em/char for Patrick Hand) for highlight
  boxes and layout; the real renderer measures exactly. Highlight `of:` a
  text mark therefore pads the estimate, not a measured box.
- The heartbeat swell uses a single sin(π·t) hump along the stroke; the
  spec's "swell and shrink back" is reproduced as one swell, not a
  multi-beat pattern (the spec gives amount 0.08, not a frequency).
- Pen-reveal for filled tapered outlines uses a CSS clip wipe; stroked
  paths use stroke-dashoffset. The host overlay (Win2D) will drive reveal
  from the `data-start`/`data-dur` attributes instead.
- 3D is a data-only scene description (`threeScene`); the host must load
  public Three.js r186 and render it — no 3D rendering happens in this file.
- Demo eyeballing is by the parent agent in a browser; the engine itself
  was verified by the Node tests, not by a visual screenshot here.
