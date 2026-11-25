/* Tests for draw-engine.js — run with: node --test draw-engine.test.js
 * No extra dependencies. Verifies the observable values in
 * ../drawing-visual-spec.md. */
const test = require('node:test');
const assert = require('node:assert/strict');
const D = require('./draw-engine.js');

test('(a) palette hex values match drawing-visual-spec.md', () => {
  const expected = {
    ink: '#30333A', white: '#FFFFFF', grey: '#7E838D', butter: '#FFD84D',
    sun: '#FFB930', orange: '#FF9A3C', peach: '#FFB59A', coral: '#F2706B',
    red: '#E5484D', pink: '#F59AB5', lilac: '#A897F5', violet: '#6E5BD8',
    sky: '#5AA8F5', blue: '#1F5FCC', mint: '#7ED6A0', leaf: '#3E9E5C',
    brown: '#A0673D', tan: '#D9A877', cream: '#FFF3D6'
  };
  assert.deepEqual(D.PALETTE, expected);
  // 3D palette is the separate realistic set.
  assert.equal(D.PALETTE_3D.ink, '#2C2E33');
  assert.equal(D.PALETTE_3D.butter, '#E0C477');
  assert.equal(D.PALETTE_3D.blue, '#2F5689');
  assert.equal(Object.keys(D.PALETTE_3D).length, 19);
  // shade helper mixes toward black.
  assert.equal(D.shade('#FFD84D', 0), '#ffd84d');
  assert.equal(D.shade('#FFD84D', 1), '#000000');
  assert.equal(D.shade('#808080', 0.5), '#404040');
});

test('(b) brush sizes and alphas match the spec', () => {
  assert.deepEqual(D.BRUSHES.pen, { size: 2.8, alpha: 1.0 });
  assert.deepEqual(D.BRUSHES.marker, { size: 8, alpha: 0.9 });
  assert.deepEqual(D.BRUSHES.pencil, { size: 1.8, alpha: 0.85 });
  assert.deepEqual(D.BRUSHES.brush, { size: 6, alpha: 0.95 });
  // brushOf falls back to pen and honours explicit overrides.
  assert.deepEqual(D.brushOf({}), { size: 2.8, alpha: 1.0 });
  assert.deepEqual(D.brushOf({ brush: 'marker' }), { size: 8, alpha: 0.9 });
  assert.deepEqual(D.brushOf({ brush: 'pen', size: 4 }), { size: 4, alpha: 1.0 });
});

test('(c) penDur = clamp(len/600, 0.14, 0.7) at several lengths', () => {
  assert.equal(D.penDur(0), 0.14);        // clamped at the floor
  assert.equal(D.penDur(60), 0.14);       // 60/600 = 0.10 -> floor
  assert.equal(D.penDur(84), 0.14);       // 84/600 = 0.14 exactly
  assert.equal(D.penDur(120), 0.2);
  assert.equal(D.penDur(300), 0.5);
  assert.equal(D.penDur(420), 0.7);       // 420/600 = 0.7 exactly
  assert.equal(D.penDur(600), 0.7);       // clamped at the ceiling
  assert.equal(D.penDur(5000), 0.7);
  // Per-mark timings derived from it.
  assert.equal(D.markTiming({ type: 'line', x1: 0, y1: 0, x2: 300, y2: 0 }).dur, 0.5);
  const arrow = D.markTiming({ type: 'arrow', x1: 0, y1: 0, x2: 300, y2: 0 });
  assert.equal(arrow.dur, 0.66);          // pen + 0.16
  assert.equal(arrow.advance, 0.76);      // + 0.10 advance
  assert.equal(D.markTiming({ type: 'highlight', x: 0, y: 0, w: 10, h: 10 }).dur, 0.35);
  assert.equal(D.markTiming({ type: 'molecule', atoms: [] }).dur, 0.6);
  const text = D.markTiming({ type: 'text', text: 'hello world' }); // 11 chars
  assert.equal(text.dur, 0.4 + 0.015 * 11);
  // Circle: pen duration of PI*(rx+ry)*1.06; no outline -> 0.3s.
  assert.equal(D.markTiming({ type: 'circle', rx: 50, ry: 50, outline: false }).dur, 0.3);
  const circ = D.markTiming({ type: 'circle', rx: 50, ry: 50 });
  assert.ok(Math.abs(circ.dur - Math.min(0.7, Math.PI * 100 * 1.06 / 600)) < 1e-9);
});

test('(d) highlight: butter default, opacity 0.72, padding w+12/h+4, offset -6,-2', () => {
  assert.equal(D.HIGHLIGHT.color, 'butter');
  assert.equal(D.HIGHLIGHT.opacity, 0.72);
  assert.equal(D.HIGHLIGHT.duration, 0.35);
  assert.equal(D.PALETTE[D.HIGHLIGHT.color], '#FFD84D');
  // Explicit box: band is w+12, h+4, offset -6,-2.
  const svg = D.render([
    { type: 'highlight', x: 100, y: 50, w: 200, h: 30, id: 'hl1' }
  ]);
  assert.match(svg, /fill="#FFD84D" fill-opacity="0\.72"/);
  assert.match(svg, /mix-blend-mode:multiply/);
  // Quad starts at x=94 (100-6), y=48 (50-2); ends at x=306 (100+200+6).
  assert.match(svg, /M94 4[678]/);       // top-left, bow may shift y by +-2
  assert.match(svg, /306 /);             // right edge at 100+200+6
  // Behind text: highlight `of` a text mark pads its estimated box.
  const d = D.renderDetailed([
    { type: 'text', x: 50, y: 50, text: 'hello', id: 't1' },
    { type: 'highlight', of: 't1', id: 'hl2' }
  ]);
  const hl = d.marks.find((m) => m.id === 'hl2');
  assert.ok(hl, 'highlight mark present in detailed output');
  assert.match(d.svg, /fill-opacity="0\.72"/);
  // Coral marker variant constants.
  assert.deepEqual(D.HIGHLIGHT.coralMarker, { size: 13, alpha: 0.5, taper: 0.4 });
});

test('(e) deterministic wobble: same input -> byte-identical SVG', () => {
  const marks = [
    { type: 'circle', x: 200, y: 150, rx: 80, ry: 60, color: 'coral', id: 'c1' },
    { type: 'arrow', x1: 50, y1: 250, x2: 350, y2: 250, color: 'blue', id: 'a1' },
    { type: 'path', points: [[60, 300], [150, 280], [240, 310], [330, 290]], color: 'leaf', id: 'p1' },
    { type: 'text', x: 60, y: 330, text: 'deterministic', id: 't1' },
    { type: 'highlight', x: 60, y: 320, w: 120, h: 24, id: 'h1' }
  ];
  const a = D.render(marks);
  const b = D.render(marks);
  assert.equal(a, b, 'identical input must render byte-identical SVG');
  const c = D.render(marks.slice().reverse());
  assert.notEqual(a, c, 'different mark order must change the output');
  // Bow amounts: 3% of length, clamped 2-7 (short edges <24pt bow 3%).
  assert.equal(D.bowAmount(10), 0.3);
  assert.equal(D.bowAmount(100), 3);
  assert.equal(D.bowAmount(300), 7);
  assert.equal(D.bowAmount(1000), 7);
});

test('(f) circle / arrow / highlight / text render valid SVG with expected structure', () => {
  const d = D.renderDetailed([
    { type: 'circle', x: 200, y: 150, rx: 80, ry: 60, color: 'coral', id: 'c1', description: 'ring around the button' },
    { type: 'arrow', x1: 50, y1: 250, x2: 350, y2: 250, color: 'blue', id: 'a1' },
    { type: 'highlight', x: 60, y: 320, w: 120, h: 24, id: 'h1' },
    { type: 'text', x: 60, y: 350, text: 'Click here', style: 'title', id: 't1' }
  ], { width: 800, height: 600 });
  const svg = d.svg;
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.match(svg, /<\/svg>\s*$/);
  // Watercolour wash filter: feTurbulence 0.035, 2 octaves, seed 3, scale 3.5.
  assert.match(svg, /baseFrequency="0\.035" numOctaves="2" seed="3"/);
  assert.match(svg, /feDisplacementMap[^>]*scale="3\.5"/);
  // Groups carry ids, data attributes and pen-reveal timing.
  assert.match(svg, /<g id="c1" data-mark="circle" data-start="0\.15"/);
  assert.match(svg, /<g id="a1" data-mark="arrow"/);
  assert.match(svg, /<g id="h1" data-mark="highlight"/);
  assert.match(svg, /<g id="t1" data-mark="text"/);
  // Arrow head present (filled path with the tip at 350,250).
  assert.match(svg, /M350 250 L/);
  // Text uses Patrick Hand at title size 24, weight 600.
  assert.match(svg, /font-family="'Patrick Hand'[^"]*" font-size="24" font-weight="600"/);
  assert.match(svg, />Click here<\/tspan>/);
  // Pen easing present.
  assert.match(svg, /cubic-bezier\(\.4,\.1,\.3,1\)/);
  // Detailed metadata: ids in program order, descriptions, bboxes.
  assert.deepEqual(d.marks.map((m) => m.id), ['c1', 'a1', 'h1', 't1']);
  assert.equal(d.marks[0].description, 'ring around the button');
  assert.ok(d.marks[0].bbox.w > 0 && d.marks[0].bbox.h > 0);
  // Schedule starts at the 0.15s clock.
  assert.equal(d.marks[0].start, 0.15);
  // Rect / dashed / graph / timeline / molecule / dot all render.
  const extra = D.render([
    { type: 'rect', x: 10, y: 10, w: 100, h: 50, color: 'leaf', id: 'r1' },
    { type: 'dashed', points: [[10, 100], [200, 100]], color: 'grey', id: 'd1' },
    { type: 'dot', x: 50, y: 150, color: 'red', id: 'dot1' },
    { type: 'graph', x: 300, y: 300, w: 200, h: 120, curves: [{ points: [[300, 400], [400, 350], [500, 380]] }], id: 'g1' },
    { type: 'timeline', x: 300, y: 450, x2: 600, events: [{ x: 400, label: 'v1' }], id: 'tl1' },
    { type: 'molecule', atoms: [{ x: 100, y: 500, label: 'O' }, { x: 160, y: 500, label: 'H' }], bonds: [[0, 1]], id: 'mol1' }
  ]);
  assert.match(extra, /data-mark="rect"/);
  assert.match(extra, /data-mark="dashed"/);
  assert.match(extra, /data-mark="dot"/);
  assert.match(extra, /data-mark="graph"/);
  assert.match(extra, /data-mark="timeline"/);
  assert.match(extra, /data-mark="molecule"/);
  // Anchors: host-resolved positions move the mark; unresolved warns.
  const anchored = D.renderDetailed(
    [{ type: 'circle', x: 0, y: 0, rx: 20, ry: 20, anchor: { id: 'btn', dx: 5, dy: 5 }, id: 'ac1' }],
    { anchors: { btn: { x: 400, y: 300 } } });
  assert.equal(anchored.marks[0].bbox.x, 400 + 5 - 20);
  const missing = D.renderDetailed(
    [{ type: 'circle', x: 0, y: 0, rx: 20, ry: 20, anchor: 'ghost', id: 'ac2' }], { anchors: {} });
  assert.equal(missing.warnings.length, 1);
  assert.equal(missing.warnings[0].reason, 'anchor-unresolved');
  // Layout nudge: overlapping labelled boxes get pushed apart.
  const nudged = D.renderDetailed([
    { type: 'rect', x: 100, y: 100, w: 120, h: 40, box: true, id: 'b1' },
    { type: 'rect', x: 110, y: 110, w: 120, h: 40, box: true, id: 'b2' }
  ]);
  assert.ok(nudged.nudges.length >= 1, 'overlap should produce a nudge');
  assert.equal(nudged.nudges[0].id, 'b2');
  // Caps: Latin upper-cased with hair spaces; joined scripts untouched.
  assert.equal(D.capsText('abc'), 'A\u200AB\u200AC');
  assert.equal(D.capsText('مرحبا'), 'مرحبا');
  // Text sizes.
  assert.equal(D.textSize({ style: 'title' }), 24);
  assert.equal(D.textSize({ style: 'body' }), 17);
  assert.equal(D.textSize({ style: 'caps' }), 14);
  assert.equal(D.textSize({}), 20);
  // Taper-0 screen pen renders an even stroke (no filled outline).
  const screenPen = D.render([{ type: 'line', x1: 0, y1: 0, x2: 100, y2: 0, taper: 0, id: 'sp1' }]);
  assert.match(screenPen, /stroke-linecap="round"/);
  // Three.js scene description (data only, host loads three r186).
  const scene = D.threeScene([{ type: 'circle', x: 10, y: 20, rx: 30, color: 'butter', id: 's1' }]);
  assert.equal(scene.three, 'r186');
  assert.equal(scene.objects[0].kind, 'sphere');
  assert.equal(scene.objects[0].color, '#E0C477'); // 3D palette butter
});

test('(g) live() emits marks in drawing order with increasing reveal times', async () => {
  const seen = [];
  let done = null;
  const ctl = D.live([
    { type: 'circle', x: 200, y: 150, rx: 60, ry: 60, color: 'coral', id: 'c1' },
    { type: 'arrow', x1: 50, y1: 250, x2: 350, y2: 250, color: 'blue', id: 'a1' },
    { type: 'text', x: 60, y: 300, text: 'hi', id: 't1' }
  ], {
    onMark: (mark, timing) => seen.push({ id: mark.id, start: timing.start, dur: timing.dur }),
    onDone: (r) => { done = r; }
  });
  ctl.start();
  await new Promise((res) => setTimeout(res, 2500));
  assert.deepEqual(seen.map((s) => s.id), ['c1', 'a1', 't1']);
  assert.ok(seen[0].start < seen[1].start && seen[1].start < seen[2].start,
    `reveal times must increase: ${JSON.stringify(seen)}`);
  assert.equal(seen[0].start, 0.15, 'clock starts at 0.15s');
  assert.ok(done && done.marks.length === 3, 'onDone fires with all marks');
  // finishNow draws everything remaining immediately.
  const seen2 = [];
  const ctl2 = D.live([
    { type: 'line', x1: 0, y1: 0, x2: 500, y2: 0, id: 'l1' },
    { type: 'line', x1: 0, y1: 20, x2: 500, y2: 20, id: 'l2' }
  ], { onMark: (m) => seen2.push(m.id) });
  ctl2.start();
  ctl2.finishNow();
  assert.deepEqual(seen2, ['l1', 'l2']);
  ctl2.dispose();
  // Live editing ops mutate state and report timings.
  const edits = [];
  const ctl3 = D.live([{ type: 'circle', x: 100, y: 100, rx: 30, ry: 30, color: 'coral', id: 'c1' }],
    { onMark: () => {}, onEdit: (op, p, t) => edits.push([op, t.dur]) });
  ctl3.start();
  await new Promise((res) => setTimeout(res, 600));
  ctl3.recolor('c1', 'blue');
  assert.equal(ctl3.state.marks[0].color, 'blue');
  assert.ok(edits.find((e) => e[0] === 'recolor' && e[1] >= 0.3), 'recolor min 0.3s');
  ctl3.move('c1', 10, 5);
  assert.equal(ctl3.state.marks[0].x, 110);
  ctl3.erase('c1');
  assert.equal(ctl3.state.marks.length, 0, 'erase removes the mark');
  ctl3.undo(); // undo of an empty list is a no-op, must not throw
  ctl3.dispose();
  // Sandbox rejects function programs.
  assert.throws(() => D.live(() => {}, {}, { sandbox: true }), /sandbox/);
  // A data program runs incrementally, one statement at a time.
  const progMarks = [];
  const ctl4 = D.live({ program: [
    { op: 'circle', x: 50, y: 50, r: 20, color: 'coral' },
    { op: 'say', text: 'look here', duration: 1.2 },
    { op: 'arrow', x1: 10, y1: 90, x2: 90, y2: 90, color: 'blue' }
  ] }, { onMark: (m) => progMarks.push(m.id) });
  ctl4.start();
  await new Promise((res) => setTimeout(res, 2500));
  assert.deepEqual(progMarks, ['m0', 'm1']);
  assert.equal(ctl4.state.marks[0].piece, 'p1');
  assert.equal(ctl4.state.marks[1].piece, 'p2');
  // Regression: program ops become the mark type (a missing type used to
  // default to 'line' and produce NaN timings for r-only circles).
  assert.equal(ctl4.state.marks[0].type, 'circle');
  assert.equal(ctl4.state.marks[1].type, 'arrow');
  assert.ok(ctl4.schedule.every((s) => Number.isFinite(s.start) && Number.isFinite(s.dur)),
    'schedule must contain no NaN values');
  assert.ok(!Number.isNaN(D.markLength({ type: 'circle', x: 50, y: 50, r: 20 })));
  assert.ok(!Number.isNaN(D.markLength({ type: 'line', x: 10, y: 10 })));
  ctl4.dispose();
});
