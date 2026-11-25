/* ============================================================================
 * HeyClicky Clone — Drawing Engine (clean-room, from scratch)
 * ============================================================================
 * Rebuilds the OBSERVABLE drawing behaviour recorded in
 * ../drawing-visual-spec.md (palette, brushes, wobble, taper, watercolour,
 * highlighter, pen-reveal timing, text, anchors, live editing) in our own
 * code. No reference engine source was read or copied; only the numbers in
 * the visual spec were used.
 *
 * Runs dependency-free inside V8 (ClearScript in the .NET app) or Node.
 * No DOM is required: render() returns an SVG string. The host bridge
 * supplies anchor resolution and timers; the engine never touches the
 * network, the filesystem, or any native bridge beyond the host functions
 * it is given.
 *
 * Public stack used: plain JavaScript, SVG output, Patrick Hand / Barlow
 * (OFL, fetched from the public google/fonts repo — see fonts/), and a
 * data-only scene description for Three.js r186 (public MIT release) for
 * 3D parts; the host loads Three.js itself.
 *
 * Determinism: every random choice comes from a seeded LCG keyed by a hash
 * of the mark's canonical JSON, so the same marks always produce a
 * byte-identical SVG.
 * ========================================================================== */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.ClickyDraw = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ------------------------------------------------------------------ */
  /* Constants — from drawing-visual-spec.md                             */
  /* ------------------------------------------------------------------ */

  var PALETTE = {
    ink: '#30333A', white: '#FFFFFF', grey: '#7E838D', butter: '#FFD84D',
    sun: '#FFB930', orange: '#FF9A3C', peach: '#FFB59A', coral: '#F2706B',
    red: '#E5484D', pink: '#F59AB5', lilac: '#A897F5', violet: '#6E5BD8',
    sky: '#5AA8F5', blue: '#1F5FCC', mint: '#7ED6A0', leaf: '#3E9E5C',
    brown: '#A0673D', tan: '#D9A877', cream: '#FFF3D6'
  };
  // 3D figures use a separate, more realistic palette (same names).
  var PALETTE_3D = {
    ink: '#2C2E33', white: '#E8E6E1', grey: '#8B8E93', butter: '#E0C477',
    sun: '#D6A83C', orange: '#C9692E', peach: '#D8A287', coral: '#C1604F',
    red: '#A8352D', pink: '#C7848F', lilac: '#9E92C0', violet: '#5D4D90',
    sky: '#8AAFCC', blue: '#2F5689', mint: '#94BCA2', leaf: '#53794A',
    brown: '#6D4A2F', tan: '#B9946F', cream: '#E4D9C2'
  };

  var BRUSHES = {
    pen:    { size: 2.8, alpha: 1.0 },
    marker: { size: 8,   alpha: 0.9 },
    pencil: { size: 1.8, alpha: 0.85 },
    brush:  { size: 6,   alpha: 0.95 }
  };

  // Hand-drawn wobble (HAND = 1, full original wobble).
  var WOBBLE = {
    hand: 1, maxSegment: 5, bowPct: 0.03, bowMin: 2, bowMax: 7,
    shortEdge: 24,      // edges under this bow 3% anyway (no clamp floor)
    ptsPerLen: 4, minPts: 2, maxMult: 3
  };

  // Watercolour wash filter.
  var WASH = { baseFrequency: 0.035, octaves: 2, seed: 3, displacement: 3.5 };

  // Highlighter.
  var HIGHLIGHT = {
    color: 'butter', opacity: 0.72, duration: 0.35,
    padX: 6, padY: 2,            // band is w+12, h+4, offset -6,-2
    bow: 2,                      // quad control-point bow, px
    coralMarker: { size: 13, alpha: 0.5, taper: 0.4 }
  };

  // Pen-reveal animation.
  var PEN = {
    perLen: 600, min: 0.14, max: 0.7, easing: 'cubic-bezier(.4,.1,.3,1)',
    clockStart: 0.15, groupGap: 0.25, fastest: 0.35, slowest: 2,
    arrowExtra: 0.16, arrowAdvance: 0.10, circleNoOutline: 0.3,
    textBase: 0.4, textPerChar: 0.015, textAdvanceBase: 0.35,
    textAdvancePerChar: 0.012, molecule: 0.6, pathCurves: 0.4,
    marquee: 0.55, highlightEdit: 0.6, moveScale: 0.5, repaintPace: 0.55,
    erase: 0.4, recolorMin: 0.3, stagger: 0.03, spread: 0.3
  };

  var TEXT = {
    font: "'Patrick Hand', 'Comic Sans MS', cursive",
    systemFont: "system-ui, sans-serif",
    serifFont: "Georgia, 'Times New Roman', serif",
    sizes: { title: 24, body: 17, caps: 14, default: 20 },
    minSize: 13, pillFloor: 8, lineHeight: 1.3, titleWeight: 600
  };

  var ARROW_HEAD_HALF_ANGLE = Math.PI / 7;   // half-opening angle
  var HEARTBEAT_SWELL = 0.08;                // 8% bigger at fullest
  var TAPER_DEFAULT = 1, TAPER_DASHED = 0.3, TAPER_ARROW_HEAD = 0.4;

  /* ------------------------------------------------------------------ */
  /* Small utilities                                                     */
  /* ------------------------------------------------------------------ */

  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function dist(ax, ay, bx, by) {
    var dx = bx - ax, dy = by - ay; return Math.sqrt(dx * dx + dy * dy);
  }
  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function num(n) { return Math.round(n * 100) / 100; }

  // FNV-1a hash of a string -> uint32. Canonical JSON keeps key order stable.
  function canonical(v) {
    if (v === null || typeof v !== 'object') return JSON.stringify(v);
    if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
    return '{' + Object.keys(v).sort().map(function (k) {
      return JSON.stringify(k) + ':' + canonical(v[k]);
    }).join(',') + '}';
  }
  function hash32(str) {
    var h = 0x811c9dc5;
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h >>> 0;
  }
  // Mulberry32 — small deterministic LCG-style PRNG.
  function rng(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function seedFor(mark) {
    return hash32(canonical(mark));
  }

  // "shade" helper: mix a hex colour toward black by factor k (0..1).
  function shade(hex, k) {
    var m = /^#?([0-9a-f]{6})$/i.exec(hex);
    if (!m) return hex;
    var n = parseInt(m[1], 16), f = 1 - clamp(k, 0, 1);
    var r = Math.round(((n >> 16) & 255) * f);
    var g = Math.round(((n >> 8) & 255) * f);
    var b = Math.round((n & 255) * f);
    return '#' + ((r << 16) | (g << 8) | b).toString(16).padStart(6, '0');
  }

  function resolveColor(c) {
    if (!c) return PALETTE.ink;
    if (c[0] === '#') return c;
    return PALETTE[c] || PALETTE.ink;
  }

  function brushOf(mark) {
    var b = BRUSHES[mark.brush] || BRUSHES.pen;
    var size = mark.size != null ? mark.size : b.size;
    var alpha = mark.alpha != null ? mark.alpha : b.alpha;
    return { size: size, alpha: alpha };
  }

  /* ------------------------------------------------------------------ */
  /* Pen duration — penDur = clamp(len / 600, 0.14, 0.7)                */
  /* ------------------------------------------------------------------ */

  function penDur(len) {
    return clamp(len / PEN.perLen, PEN.min, PEN.max);
  }

  function markLength(mark) {
    switch (mark.type) {
      case 'line': case 'arrow': case 'highlight': {
        var ax = mark.x1 ?? mark.x ?? 0, ay = mark.y1 ?? mark.y ?? 0;
        var bx = mark.x2 ?? mark.x1 ?? mark.x ?? 0, by = mark.y2 ?? mark.y1 ?? mark.y ?? 0;
        return dist(ax, ay, bx, by);
      }
      case 'circle': return Math.PI * ((mark.rx || mark.r || 0) + (mark.ry || mark.r || 0)) * 1.06;
      case 'ellipse': return Math.PI * ((mark.rx || 0) + (mark.ry || 0)) * 1.06;
      case 'rect': {
        var w = mark.w || 0, h = mark.h || 0;
        return 2 * (w + h);
      }
      case 'path': case 'dashed': {
        var pts = mark.points || [];
        var L = 0;
        for (var i = 1; i < pts.length; i++) L += dist(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]);
        return L;
      }
      case 'text': return (mark.text || '').length * 12;
      case 'dot': return 0;
      default: return 100;
    }
  }

  // Natural per-mark duration + the "advance" (time the clock moves on).
  function markTiming(mark) {
    var len = markLength(mark);
    var dur, adv;
    switch (mark.type) {
      case 'arrow':
        dur = penDur(len) + PEN.arrowExtra;
        adv = dur + PEN.arrowAdvance;
        break;
      case 'circle': case 'ellipse': {
        var crx = mark.rx || mark.r || 0, cry = mark.ry || mark.r || 0;
        dur = mark.outline === false ? PEN.circleNoOutline : penDur(Math.PI * (crx + cry) * 1.06);
        adv = dur;
        break;
      }
      case 'highlight':
        dur = HIGHLIGHT.duration; adv = dur;
        break;
      case 'text': {
        var n = (mark.text || '').length;
        dur = PEN.textBase + PEN.textPerChar * n;
        adv = (PEN.textAdvanceBase + PEN.textAdvancePerChar * n) * 0.7;
        break;
      }
      case 'molecule': dur = PEN.molecule; adv = dur; break;
      case 'path':
        dur = mark.curves ? PEN.pathCurves : penDur(len); adv = dur;
        break;
      default:
        dur = penDur(len); adv = dur;
    }
    return { len: len, dur: dur, advance: adv };
  }

  /* ------------------------------------------------------------------ */
  /* Wobble: subdivide, bow once per edge, jitter corners, Catmull-Rom  */
  /* ------------------------------------------------------------------ */

  // Bow for one edge: 3% of length; clamped 2-7pt, except short edges
  // under 24pt which bow 3% anyway (no clamp floor).
  function bowAmount(len) {
    if (len < WOBBLE.shortEdge) return WOBBLE.bowPct * len;
    return clamp(WOBBLE.bowPct * len, WOBBLE.bowMin, WOBBLE.bowMax);
  }

  // Wobble an open polyline. Returns smoothed points (array of [x, y]).
  function wobblePolyline(pts, rand, closed) {
    var out = [];
    var n = pts.length;
    var segs = closed ? n : n - 1;
    for (var s = 0; s < segs; s++) {
      var a = pts[s], b = pts[(s + 1) % n];
      var len = dist(a[0], a[1], b[0], b[1]);
      var bow = bowAmount(len) * WOBBLE.hand;
      var side = rand() < 0.5 ? -1 : 1;
      // Unit normal.
      var nx = len ? -(b[1] - a[1]) / len : 0;
      var ny = len ? (b[0] - a[0]) / len : 0;
      var steps = Math.max(1, Math.ceil(len / WOBBLE.maxSegment));
      for (var i = 0; i < steps; i++) {
        var t = i / steps;
        // Single clear bend per edge: bow peaks mid-edge.
        var bend = bow * Math.sin(Math.PI * t) * side;
        var x = lerp(a[0], b[0], t) + nx * bend;
        var y = lerp(a[1], b[1], t) + ny * bend;
        // Corner jitter: up to the bow amount off the ideal position.
        if (i === 0 && (s > 0 || closed)) {
          x += (rand() * 2 - 1) * bow;
          y += (rand() * 2 - 1) * bow;
        }
        out.push([x, y]);
      }
    }
    var last = closed ? pts[0] : pts[n - 1];
    out.push([last[0] + (rand() * 2 - 1) * bowAmount(10),
              last[1] + (rand() * 2 - 1) * bowAmount(10)]);
    return out;
  }

  // Catmull-Rom spline through points -> cubic Bezier SVG path data.
  function smoothPath(pts, closed) {
    var n = pts.length;
    if (n < 2) return pts.length ? 'M' + num(pts[0][0]) + ' ' + num(pts[0][1]) : '';
    // Segment count scales with length, ~1 point per 4pt, min 2,
    // max 3x the base segment count — the wobble subdivision already
    // gives ~1 point per <=5pt, so we smooth through the given points.
    var d = 'M' + num(pts[0][0]) + ' ' + num(pts[0][1]);
    var count = closed ? n : n - 1;
    for (var i = 0; i < count; i++) {
      var p0 = pts[closed ? (i - 1 + n) % n : Math.max(0, i - 1)];
      var p1 = pts[i];
      var p2 = pts[(i + 1) % n];
      var p3 = pts[closed ? (i + 2) % n : Math.min(n - 1, i + 2)];
      var c1x = p1[0] + (p2[0] - p0[0]) / 6, c1y = p1[1] + (p2[1] - p0[1]) / 6;
      var c2x = p2[0] - (p3[0] - p1[0]) / 6, c2y = p2[1] - (p3[1] - p1[1]) / 6;
      d += ' C' + num(c1x) + ' ' + num(c1y) + ' ' + num(c2x) + ' ' + num(c2y) +
           ' ' + num(p2[0]) + ' ' + num(p2[1]);
    }
    if (closed) d += ' Z';
    return d;
  }

  function polylineLength(pts) {
    var L = 0;
    for (var i = 1; i < pts.length; i++) L += dist(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]);
    return L;
  }

  /* ------------------------------------------------------------------ */
  /* Tapered outline — felt-pen stroke around a centreline               */
  /* Taper ramp: min(len*0.3, size*5), scaled by the taper factor.      */
  /* Heartbeat swell: 8% bigger at fullest. Taper 0 = even width.       */
  /* ------------------------------------------------------------------ */

  function taperedOutline(pts, size, taper) {
    var L = polylineLength(pts);
    if (taper === 0 || L === 0) return null; // caller draws an even stroke
    var ramp = Math.min(L * 0.3, size * 5) * taper;
    var left = [], right = [];
    var cum = [0];
    for (var i = 1; i < pts.length; i++) cum.push(cum[i - 1] + dist(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]));
    for (var j = 0; j < pts.length; j++) {
      var t = L ? cum[j] / L : 0;
      var dEnd = Math.min(cum[j], L - cum[j]);
      var taperF = ramp > 0 ? clamp(dEnd / ramp, 0, 1) : 1;
      taperF = 0.3 + 0.7 * (taperF * taperF * (3 - 2 * taperF)); // smoothstep, ends stay visible
      var swell = 1 + HEARTBEAT_SWELL * Math.sin(Math.PI * t);
      var half = (size / 2) * taperF * swell;
      var k = j === 0 ? 0 : j === pts.length - 1 ? pts.length - 2 : j - 1;
      var m = j === pts.length - 1 ? pts.length - 1 : j + 1;
      var dx = pts[m][0] - pts[k][0], dy = pts[m][1] - pts[k][1];
      var dl = Math.sqrt(dx * dx + dy * dy) || 1;
      var nx = -dy / dl, ny = dx / dl;
      left.push([pts[j][0] + nx * half, pts[j][1] + ny * half]);
      right.push([pts[j][0] - nx * half, pts[j][1] - ny * half]);
    }
    var d = 'M' + left.map(function (p) { return num(p[0]) + ' ' + num(p[1]); }).join(' L');
    d += ' L' + right.reverse().map(function (p) { return num(p[0]) + ' ' + num(p[1]); }).join(' L');
    return d + ' Z';
  }

  // Render one open stroke: tapered filled outline, or an even round-ended
  // stroke when taper is 0 ("screen pen").
  function strokeSvg(pts, closed, mark, rand) {
    var brush = brushOf(mark);
    var color = resolveColor(mark.color);
    var taper = mark.taper != null ? mark.taper : TAPER_DEFAULT;
    var smooth = smoothPath(pts, closed);
    var filter = mark.brush === 'pencil' ? ' filter="url(#grain)"' : '';
    if (taper === 0 || closed) {
      return '<path d="' + smooth + '" fill="none" stroke="' + color +
        '" stroke-width="' + brush.size + '" stroke-linecap="round" stroke-linejoin="round"' +
        ' stroke-opacity="' + brush.alpha + '"' + filter + ' pathLength="1" class="pen-stroke"/>';
    }
    var outline = taperedOutline(pts, brush.size, taper);
    if (!outline) return '';
    return '<path d="' + outline + '" fill="' + color + '" fill-opacity="' +
      brush.alpha + '"' + filter + ' class="pen-fill"/>';
  }

  /* ------------------------------------------------------------------ */
  /* Text helpers                                                        */
  /* ------------------------------------------------------------------ */

  // Caps: upper case, weight 600, hair spaces between letters — Latin,
  // Greek and Cyrillic only; joined scripts (Arabic, Devanagari) untouched.
  var CAPS_RE = /^[\u0041-\u024F\u0370-\u03FF\u0400-\u04FF\s\d\p{P}]*$/u;
  function capsText(s) {
    if (!CAPS_RE.test(s)) return s;
    return s.toUpperCase().split('').join('\u200A');
  }
  function textSize(mark) {
    if (mark.size != null) return mark.size;
    if (mark.style === 'title') return TEXT.sizes.title;
    if (mark.style === 'body') return TEXT.sizes.body;
    if (mark.style === 'caps') return TEXT.sizes.caps;
    return TEXT.sizes.default;
  }
  // Rough Patrick Hand advance: ~0.5em per character (used for highlight
  // boxes and layout; the real renderer measures exactly).
  function estimateTextWidth(text, size) {
    var w = 0;
    for (var i = 0; i < text.length; i++) {
      var ch = text[i];
      w += ch === ' ' ? 0.28 : ch === 'i' || ch === 'l' || ch === '.' ? 0.25 : 0.5;
    }
    return w * size;
  }
  function textLines(text) { return String(text == null ? '' : text).split('\n'); }

  /* ------------------------------------------------------------------ */
  /* Bounding boxes + layout nudge                                      */
  /* ------------------------------------------------------------------ */

  function bboxOf(mark) {
    switch (mark.type) {
      case 'line': case 'arrow': case 'highlight':
        return { x: Math.min(mark.x1 ?? mark.x, mark.x2), y: Math.min(mark.y1 ?? mark.y, mark.y2),
                 w: Math.abs(mark.x2 - (mark.x1 ?? mark.x)), h: Math.abs(mark.y2 - (mark.y1 ?? mark.y)) };
      case 'circle': case 'ellipse':
        return { x: (mark.x || 0) - (mark.rx || mark.r || 0), y: (mark.y || 0) - (mark.ry || mark.r || 0),
                 w: 2 * (mark.rx || mark.r || 0), h: 2 * (mark.ry || mark.r || 0) };
      case 'rect':
        return { x: mark.x || 0, y: mark.y || 0, w: mark.w || 0, h: mark.h || 0 };
      case 'text': {
        var size = textSize(mark);
        var lines = textLines(mark.text);
        var w = 0;
        lines.forEach(function (ln) { w = Math.max(w, estimateTextWidth(ln, size)); });
        return { x: mark.x || 0, y: mark.y || 0, w: w, h: lines.length * size * TEXT.lineHeight };
      }
      case 'path': case 'dashed': {
        var pts = mark.points || [];
        var xs = pts.map(function (p) { return p[0]; }), ys = pts.map(function (p) { return p[1]; });
        if (!pts.length) return { x: 0, y: 0, w: 0, h: 0 };
        return { x: Math.min.apply(null, xs), y: Math.min.apply(null, ys),
                 w: Math.max.apply(null, xs) - Math.min.apply(null, xs),
                 h: Math.max.apply(null, ys) - Math.min.apply(null, ys) };
      }
      case 'dot':
        return { x: (mark.x || 0) - 4, y: (mark.y || 0) - 4, w: 8, h: 8 };
      default: return { x: mark.x || 0, y: mark.y || 0, w: mark.w || 0, h: mark.h || 0 };
    }
  }

  function overlaps(a, b) {
    return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
  }

  // Layout check for labelled boxes: boxes that pile on each other are
  // warned about and nudged when safe (smallest-axis push-apart + 4px).
  function layoutNudge(marks) {
    var nudges = [];
    var boxes = marks.filter(function (m) {
      return m.box === true || m.type === 'rect' || (m.type === 'text' && m.labelBox);
    });
    for (var pass = 0; pass < 3; pass++) {
      var moved = false;
      for (var i = 0; i < boxes.length; i++) {
        for (var j = i + 1; j < boxes.length; j++) {
          var a = bboxOf(boxes[i]), b = bboxOf(boxes[j]);
          if (!overlaps(a, b)) continue;
          var ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
          var oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
          var dx = 0, dy = 0;
          if (ox < oy) dx = (a.x + a.w / 2 <= b.x + b.w / 2 ? -1 : 1) * (ox / 2 + 4);
          else dy = (a.y + a.h / 2 <= b.y + b.h / 2 ? -1 : 1) * (oy / 2 + 4);
          boxes[j].x = (boxes[j].x || 0) + dx;
          boxes[j].y = (boxes[j].y || 0) + dy;
          if (boxes[j].type === 'line' || boxes[j].type === 'arrow') {
            boxes[j].x1 = (boxes[j].x1 || 0) + dx; boxes[j].y1 = (boxes[j].y1 || 0) + dy;
            boxes[j].x2 = (boxes[j].x2 || 0) + dx; boxes[j].y2 = (boxes[j].y2 || 0) + dy;
          }
          nudges.push({ id: boxes[j].id, dx: num(dx), dy: num(dy), reason: 'overlap-nudge' });
          moved = true;
        }
      }
      if (!moved) break;
    }
    return nudges;
  }

  /* ------------------------------------------------------------------ */
  /* Anchors — host resolves anchor ids to screen positions              */
  /* ------------------------------------------------------------------ */

  function resolveAnchors(marks, opts, warnings) {
    var resolver = null;
    if (opts && typeof opts.resolveAnchor === 'function') resolver = opts.resolveAnchor;
    else if (opts && opts.anchors) {
      var map = opts.anchors;
      resolver = function (id) { return map[id] || null; };
    }
    if (!resolver) return marks;
    return marks.map(function (mark) {
      var a = mark.anchor;
      if (!a) return mark;
      var id = typeof a === 'string' ? a : a.id;
      var pos = resolver(id, mark);
      if (!pos) {
        warnings.push({ id: mark.id, anchor: id, reason: 'anchor-unresolved' });
        return mark;
      }
      var dx = (typeof a === 'object' ? a.dx || 0 : 0);
      var dy = (typeof a === 'object' ? a.dy || 0 : 0);
      var m = Object.assign({}, mark);
      var ox = pos.x + dx - (mark.x || 0), oy = pos.y + dy - (mark.y || 0);
      m.x = pos.x + dx; m.y = pos.y + dy;
      if (m.x1 != null) { m.x1 += ox; m.x2 += ox; }
      if (m.y1 != null) { m.y1 += oy; m.y2 += oy; }
      if (m.points) m.points = m.points.map(function (p) { return [p[0] + ox, p[1] + oy]; });
      m._anchorResolved = { id: id, x: pos.x, y: pos.y };
      return m;
    });
  }

  /* ------------------------------------------------------------------ */
  /* Per-mark SVG rendering                                              */
  /* ------------------------------------------------------------------ */

  function ellipsePoints(cx, cy, rx, ry, rand, steps) {
    var pts = [];
    for (var i = 0; i < steps; i++) {
      var t = (i / steps) * Math.PI * 2;
      // Hand-drawn ring: radius breathes a little (wobble), one bow.
      var wob = 1 + (rand() * 2 - 1) * 0.015 + 0.02 * Math.sin(t);
      pts.push([cx + Math.cos(t) * rx * wob, cy + Math.sin(t) * ry * wob]);
    }
    return pts;
  }

  function markToSvg(mark, ctx) {
    var rand = rng(seedFor(mark));
    var color = resolveColor(mark.color);
    var brush = brushOf(mark);
    var anim = ' style="animation-delay:' + ctx.start + 's;animation-duration:' + ctx.dur + 's"';
    var open = '<g id="' + esc(mark.id) + '" data-mark="' + esc(mark.type) + '" data-start="' + ctx.start +
      '" data-dur="' + ctx.dur + '" class="mark"' + anim + '>';
    var close = '</g>';
    var wash = mark.wash === false || mark.type === 'highlight' ? '' : ' filter="url(#wash)"';
    var fill = mark.fill ? resolveColor(mark.fill) : null;

    switch (mark.type) {
      case 'line': case 'arrow': {
        var x1 = mark.x1 ?? mark.x, y1 = mark.y1 ?? mark.y;
        var pts = wobblePolyline([[x1, y1], [mark.x2, mark.y2]], rand, false);
        var body = strokeSvg(pts, false, mark, rand);
        if (mark.type === 'line') return open + body + close;
        // Arrow head: half-opening angle PI/7, taper 0.4.
        var ang = Math.atan2(mark.y2 - y1, mark.x2 - x1);
        var headLen = clamp(brush.size * 5, 12, 28);
        var half = ARROW_HEAD_HALF_ANGLE;
        var tip = [mark.x2, mark.y2];
        var b1 = [mark.x2 - headLen * Math.cos(ang - half), mark.y2 - headLen * Math.sin(ang - half)];
        var b2 = [mark.x2 - headLen * Math.cos(ang + half), mark.y2 - headLen * Math.sin(ang + half)];
        var base = [mark.x2 - headLen * 0.55 * Math.cos(ang), mark.y2 - headLen * 0.55 * Math.sin(ang)];
        var j = function () { return (rand() * 2 - 1) * 1.5; };
        var head = '<path d="M' + num(tip[0]) + ' ' + num(tip[1]) +
          ' L' + num(b1[0] + j()) + ' ' + num(b1[1] + j()) +
          ' L' + num(base[0]) + ' ' + num(base[1]) +
          ' L' + num(b2[0] + j()) + ' ' + num(b2[1] + j()) + ' Z" fill="' + color +
          '" fill-opacity="' + brush.alpha + '"/>';
        return open + body + head + close;
      }
      case 'circle': case 'ellipse': {
        var rx = mark.rx || mark.r || 40, ry = mark.ry || mark.r || 40;
        var pts = ellipsePoints(mark.x || 0, mark.y || 0, rx, ry, rand, 48);
        var d = smoothPath(pts, true);
        var inner = '';
        if (fill) inner = '<path d="' + d + '" fill="' + fill + '" fill-opacity="' +
          (mark.fillAlpha != null ? mark.fillAlpha : 0.25) + '"' + wash + '/>';
        var outline = mark.outline === false ? '' :
          '<path d="' + d + '" fill="none" stroke="' + color + '" stroke-width="' + brush.size +
          '" stroke-linecap="round" stroke-opacity="' + brush.alpha + '" pathLength="1" class="pen-stroke"/>';
        return open + inner + outline + close;
      }
      case 'rect': {
        var rpts = wobblePolyline([
          [mark.x, mark.y], [mark.x + mark.w, mark.y],
          [mark.x + mark.w, mark.y + mark.h], [mark.x, mark.y + mark.h]
        ], rand, true);
        var d = smoothPath(rpts, true);
        var inner = fill ? '<path d="' + d + '" fill="' + fill + '" fill-opacity="' +
          (mark.fillAlpha != null ? mark.fillAlpha : 0.25) + '"' + wash + '/>' : '';
        return open + inner +
          '<path d="' + d + '" fill="none" stroke="' + color + '" stroke-width="' + brush.size +
          '" stroke-linejoin="round" stroke-opacity="' + brush.alpha + '" pathLength="1" class="pen-stroke"/>' + close;
      }
      case 'path': case 'dashed': {
        var raw = mark.points || [];
        if (raw.length < 2) return open + close;
        if (mark.type === 'dashed') {
          var dash = mark.dash || { on: 14, off: 8 };
          var pieces = cutDashes(raw, dash.on, dash.off);
          var s = '';
          pieces.forEach(function (piece) {
            var wpts = wobblePolyline(piece, rand, false);
            var dm = Object.assign({}, mark, { taper: TAPER_DASHED });
            s += strokeSvg(wpts, false, dm, rand);
          });
          return open + s + close;
        }
        var wpts = wobblePolyline(raw, rand, !!mark.closed);
        return open + strokeSvg(wpts, !!mark.closed, mark, rand) + close;
      }
      case 'dot': {
        var r = (mark.r != null ? mark.r : brush.size * 1.6);
        return open + '<circle cx="' + num(mark.x || 0) + '" cy="' + num(mark.y || 0) +
          '" r="' + num(r) + '" fill="' + color + '" fill-opacity="' + brush.alpha + '"/>' + close;
      }
      case 'text': {
        var size = textSize(mark);
        var shown = mark.style === 'caps' ? capsText(mark.text || '') : (mark.text || '');
        var weight = (mark.style === 'title' || mark.style === 'caps' || mark.bold) ? TEXT.titleWeight : 400;
        var lh = size * TEXT.lineHeight;
        var lines = textLines(shown);
        var tspans = lines.map(function (ln, i) {
          return '<tspan x="' + num(mark.x || 0) + '" dy="' + (i === 0 ? 0 : num(lh)) + '">' + esc(ln) + '</tspan>';
        }).join('');
        var font = mark.serif ? TEXT.serifFont : (mark.system ? TEXT.systemFont : TEXT.font);
        var y = (mark.y || 0) + size; // baseline: first line sits size below y
        return open + '<text x="' + num(mark.x || 0) + '" y="' + num(y) +
          '" font-family="' + font + '" font-size="' + size + '" font-weight="' + weight +
          '" fill="' + color + '" class="pen-text">' + tspans + '</text>' + close;
      }
      case 'highlight': {
        var box = highlightBox(mark, ctx);
        var bx = box.x, by = box.y, bw = box.w, bh = box.h;
        var b = HIGHLIGHT.bow;
        var j1 = (rand() * 2 - 1) * b, j2 = (rand() * 2 - 1) * b;
        // Hand-drawn quad: slight bow (+-1-2px) on the control points.
        var d = 'M' + num(bx) + ' ' + num(by + j1) +
          ' Q' + num(bx + bw / 2) + ' ' + num(by - b + j1) + ' ' + num(bx + bw) + ' ' + num(by + j2) +
          ' L' + num(bx + bw) + ' ' + num(by + bh + j2) +
          ' Q' + num(bx + bw / 2) + ' ' + num(by + bh + b) + ' ' + num(bx) + ' ' + num(by + bh + j1) + ' Z';
        var tone = resolveColor(mark.color || HIGHLIGHT.color);
        var blend = mark.surface === 'sky' ? '' : ' style="mix-blend-mode:multiply"';
        return open + '<path d="' + d + '" fill="' + tone + '" fill-opacity="' + HIGHLIGHT.opacity + '"' + blend + ' class="pen-highlight"/>' + close;
      }
      case 'graph': return open + graphSvg(mark, rand) + close;
      case 'timeline': return open + timelineSvg(mark, rand) + close;
      case 'molecule': return open + moleculeSvg(mark, rand) + close;
      default:
        return open + '<!-- unknown mark type: ' + esc(mark.type) + ' -->' + close;
    }
  }

  // Highlight band box: behind text it pads the text box by 6px sides,
  // 2px top/bottom (w+12, h+4, offset -6,-2). Explicit x/y/w/h wins.
  function highlightBox(mark, ctx) {
    if (mark.w != null && mark.h != null) {
      return { x: (mark.x || 0) - HIGHLIGHT.padX, y: (mark.y || 0) - HIGHLIGHT.padY,
               w: mark.w + HIGHLIGHT.padX * 2, h: mark.h + HIGHLIGHT.padY * 2 };
    }
    if (mark.of && ctx && ctx.byId && ctx.byId[mark.of]) {
      var b = bboxOf(ctx.byId[mark.of]);
      return { x: b.x - HIGHLIGHT.padX, y: b.y - HIGHLIGHT.padY,
               w: b.w + HIGHLIGHT.padX * 2, h: b.h + HIGHLIGHT.padY * 2 };
    }
    if (mark.x2 != null) {
      return { x: Math.min(mark.x1 ?? mark.x, mark.x2) - HIGHLIGHT.padX,
               y: Math.min(mark.y1 ?? mark.y, mark.y2) - HIGHLIGHT.padY,
               w: Math.abs(mark.x2 - (mark.x1 ?? mark.x)) + HIGHLIGHT.padX * 2,
               h: Math.abs(mark.y2 - (mark.y1 ?? mark.y)) + HIGHLIGHT.padY * 2 };
    }
    return { x: (mark.x || 0) - HIGHLIGHT.padX, y: (mark.y || 0) - HIGHLIGHT.padY, w: 120, h: 24 };
  }

  // Cut a polyline centreline into hand-drawn dashes (on/off lengths).
  function cutDashes(pts, on, off) {
    var pieces = [], cur = [pts[0]], remaining = on, drawing = true;
    for (var i = 1; i < pts.length; i++) {
      var a = pts[i - 1], b = pts[i];
      var seg = dist(a[0], a[1], b[0], b[1]);
      var t0 = 0;
      while (seg - t0 > 0.0001) {
        var step = Math.min(remaining, seg - t0);
        var t1 = (t0 + step) / seg;
        var p = [lerp(a[0], b[0], t1), lerp(a[1], b[1], t1)];
        if (drawing) cur.push(p);
        else if (cur.length === 0) cur = [p];
        else cur = [p];
        t0 += step; remaining -= step;
        if (remaining <= 0.0001) {
          if (drawing && cur.length > 1) pieces.push(cur);
          drawing = !drawing;
          remaining = drawing ? on : off;
          cur = [p];
        }
      }
    }
    if (drawing && cur.length > 1) pieces.push(cur);
    return pieces;
  }

  /* Composite pieces: graph / timeline / molecule. Each is built from the
   * same primitives above, so wobble, taper and timing stay consistent. */
  function graphSvg(mark, rand) {
    var s = '';
    var ox = mark.x || 0, oy = mark.y || 0, w = mark.w || 320, h = mark.h || 200;
    var axis = { type: 'line', x1: ox, y1: oy + h, x2: ox + w, y2: oy + h, color: 'ink', taper: 0 };
    var axisY = { type: 'line', x1: ox, y1: oy + h, x2: ox, y2: oy, color: 'ink', taper: 0 };
    s += strokeSvg(wobblePolyline([[axis.x1, axis.y1], [axis.x2, axis.y2]], rand, false), false, axis, rand);
    s += strokeSvg(wobblePolyline([[axisY.x1, axisY.y1], [axisY.x2, axisY.y2]], rand, false), false, axisY, rand);
    (mark.curves || []).forEach(function (curve, ci) {
      var pts = curve.points || [];
      if (pts.length < 2) return;
      var cm = { type: 'path', color: curve.color || ['blue', 'coral', 'leaf'][ci % 3], brush: 'pen' };
      s += strokeSvg(wobblePolyline(pts, rand, false), false, cm, rand);
    });
    (mark.points || []).forEach(function (p) {
      s += '<circle cx="' + num(p[0]) + '" cy="' + num(p[1]) + '" r="4" fill="' +
        resolveColor(p.color || 'coral') + '"/>';
    });
    if (mark.xLabel) s += '<text x="' + num(ox + w / 2) + '" y="' + num(oy + h + 22) +
      '" font-family="' + TEXT.font + '" font-size="14" fill="' + PALETTE.ink + '">' + esc(mark.xLabel) + '</text>';
    if (mark.yLabel) s += '<text x="' + num(ox - 8) + '" y="' + num(oy + 12) +
      '" font-family="' + TEXT.font + '" font-size="14" fill="' + PALETTE.ink + '">' + esc(mark.yLabel) + '</text>';
    return s;
  }

  function timelineSvg(mark, rand) {
    var s = '';
    var x1 = mark.x || 0, y = mark.y || 0, x2 = mark.x2 || (mark.x || 0) + (mark.w || 400);
    var base = { type: 'line', color: 'ink', taper: 0 };
    s += strokeSvg(wobblePolyline([[x1, y], [x2, y]], rand, false), false, base, rand);
    (mark.events || []).forEach(function (ev) {
      var ex = ev.x;
      s += strokeSvg(wobblePolyline([[ex, y - 8], [ex, y + 8]], rand, false), false,
        { type: 'line', color: ev.color || 'coral', taper: 0 }, rand);
      s += '<circle cx="' + num(ex) + '" cy="' + num(y) + '" r="4.5" fill="' +
        resolveColor(ev.color || 'coral') + '"/>';
      if (ev.label) {
        s += '<text x="' + num(ex) + '" y="' + num(y - 14) + '" text-anchor="middle" font-family="' +
          TEXT.font + '" font-size="14" fill="' + PALETTE.ink + '">' + esc(ev.label) + '</text>';
      }
    });
    return s;
  }

  function moleculeSvg(mark, rand) {
    var s = '';
    var atoms = mark.atoms || [];
    (mark.bonds || []).forEach(function (bond) {
      var a = atoms[bond[0]], b = atoms[bond[1]];
      if (!a || !b) return;
      s += strokeSvg(wobblePolyline([[a.x, a.y], [b.x, b.y]], rand, false), false,
        { type: 'line', color: 'ink', taper: 0 }, rand);
    });
    atoms.forEach(function (a) {
      s += '<circle cx="' + num(a.x) + '" cy="' + num(a.y) + '" r="' + num(a.r || 14) +
        '" fill="' + resolveColor(a.color || 'sky') + '" fill-opacity="0.85" stroke="' + PALETTE.ink +
        '" stroke-width="2"/>';
      if (a.label) {
        s += '<text x="' + num(a.x) + '" y="' + num((a.y || 0) + 5) + '" text-anchor="middle" font-family="' +
          TEXT.font + '" font-size="14" fill="' + PALETTE.ink + '">' + esc(a.label) + '</text>';
      }
    });
    return s;
  }

  /* ------------------------------------------------------------------ */
  /* Scheduling — clock starts at 0.15s; groups gap 0.25s (0 continuous) */
  /* ------------------------------------------------------------------ */

  function computeSchedule(marks, opts) {
    opts = opts || {};
    var t = PEN.clockStart;
    var gap = opts.continuous ? 0 : (opts.groupGap != null ? opts.groupGap : PEN.groupGap);
    var schedule = [];
    var groups = groupMarks(marks, opts);
    groups.forEach(function (group, gi) {
      if (gi > 0) t += gap;
      var speechDur = group.speechDuration; // seconds the spoken line lasts
      if (opts.pace === 'speech' && speechDur) {
        // Strokes released while the spoken line plays, spread across it.
        var per = clamp(speechDur / Math.max(1, group.marks.length), PEN.fastest, PEN.slowest);
        group.marks.forEach(function (m) {
          var timing = markTiming(m);
          var dur = clamp(timing.dur, PEN.fastest, PEN.slowest);
          schedule.push({ id: m.id, start: num(t), dur: num(dur), end: num(t + dur), advance: num(per) });
          t += per;
        });
        t = Math.max(t, schedule[schedule.length - 1].start + speechDur * 0); // keep clock honest
      } else {
        group.marks.forEach(function (m) {
          var timing = markTiming(m);
          schedule.push({ id: m.id, start: num(t), dur: num(timing.dur), end: num(t + timing.dur), advance: num(timing.advance) });
          t += timing.advance;
        });
      }
    });
    return schedule;
  }

  // Marks may carry group / say / sayDuration to pace against speech.
  function groupMarks(marks, opts) {
    var groups = [], byKey = {};
    marks.forEach(function (m) {
      var key = m.group != null ? 'g:' + m.group : (m.say != null ? 's:' + m.say : 'solo:' + m.id);
      if (!byKey[key]) {
        byKey[key] = { marks: [], speechDuration: m.sayDuration || null };
        groups.push(byKey[key]);
      }
      byKey[key].marks.push(m);
      if (m.sayDuration) byKey[key].speechDuration = m.sayDuration;
    });
    if (opts && opts.speech && opts.speech.length) {
      // opts.speech: [{text, duration}] lines, one group per line, in order.
      var gi = 0;
      groups.forEach(function (g) { g.speechDuration = opts.speech[gi++] ? opts.speech[gi - 1].duration : g.speechDuration; });
    }
    return groups;
  }

  /* ------------------------------------------------------------------ */
  /* render(marks, opts) -> SVG string                                   */
  /* renderDetailed(marks, opts) -> { svg, marks, nudges, warnings }    */
  /* ------------------------------------------------------------------ */

  function normalizeMarks(input) {
    var list = Array.isArray(input) ? input : (input && input.marks) || [];
    return list.map(function (m, i) {
      var c = Object.assign({}, m);
      if (!c.id) c.id = 'm' + i;
      if (!c.type) c.type = 'line';
      return c;
    });
  }

  function renderDetailed(input, opts) {
    opts = opts || {};
    var warnings = [];
    var marks = normalizeMarks(input);
    marks = resolveAnchors(marks, opts, warnings);
    var nudges = (opts.layoutNudge === false) ? [] : layoutNudge(marks);
    var byId = {};
    marks.forEach(function (m) { byId[m.id] = m; });
    var schedule = computeSchedule(marks, opts);
    var schedById = {};
    schedule.forEach(function (s) { schedById[s.id] = s; });

    var width = opts.width || 800, height = opts.height || 600;
    var parts = [];
    parts.push('<svg xmlns="http://www.w3.org/2000/svg" width="' + width + '" height="' + height +
      '" viewBox="0 0 ' + width + ' ' + height + '" font-family="' + TEXT.font + '">');
    parts.push('<defs>');
    // Watercolour wash: fractal-noise turbulence, baseFrequency 0.035,
    // 2 octaves, seed 3; displacement scale 3.5.
    parts.push('<filter id="wash" x="-5%" y="-5%" width="110%" height="110%">' +
      '<feTurbulence type="fractalNoise" baseFrequency="' + WASH.baseFrequency +
      '" numOctaves="' + WASH.octaves + '" seed="' + WASH.seed + '" result="n"/>' +
      '<feDisplacementMap in="SourceGraphic" in2="n" scale="' + WASH.displacement + '"/>' +
      '</filter>');
    // Pencil grain.
    parts.push('<filter id="grain" x="-5%" y="-5%" width="110%" height="110%">' +
      '<feTurbulence type="fractalNoise" baseFrequency="0.8" numOctaves="2" seed="7" result="g"/>' +
      '<feColorMatrix in="g" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 0.12 0" result="ga"/>' +
      '<feComposite in="SourceGraphic" in2="ga" operator="over"/></filter>');
    parts.push('</defs>');
    parts.push('<style>' +
      '.mark{opacity:0;animation-fill-mode:both;animation-timing-function:' + PEN.easing + ';}' +
      '.mark .pen-stroke{stroke-dasharray:1;stroke-dashoffset:1;animation:penDraw 1s linear both;animation-delay:inherit;animation-duration:inherit;}' +
      '.mark .pen-fill,.mark .pen-text,.mark .pen-highlight{animation:penFade 1s ease-out both;animation-delay:inherit;animation-duration:inherit;}' +
      '.mark .pen-highlight{animation-name:penSwipe;}' +
      '@keyframes penDraw{to{stroke-dashoffset:0}}' +
      '@keyframes penFade{from{opacity:0}to{opacity:1}}' +
      '@keyframes penSwipe{from{opacity:0;transform:scaleX(0);transform-origin:left center}to{opacity:1;transform:scaleX(1)}}' +
      '.mark{animation-name:penFade;}' +
      '</style>');
    // Halo/glow: a screen mark's glow is a real blurred shadow in its own
    // colour ([opacity, radius]); otherwise a halo outline under the ink.
    marks.forEach(function (m) {
      var s = schedById[m.id] || { start: PEN.clockStart, dur: 0.4 };
      var ctx = { start: s.start, dur: s.dur, byId: byId };
      var svg = markToSvg(m, ctx);
      if (m.glow) {
        var op = m.glow[0], rad = m.glow[1];
        svg = '<g style="filter:drop-shadow(0 0 ' + rad + 'px ' + resolveColor(m.color) +
          ')" opacity="' + op + '">' + svg + '</g>';
      }
      parts.push(svg);
    });
    parts.push('</svg>');

    var detailed = marks.map(function (m) {
      var s = schedById[m.id] || { start: PEN.clockStart, dur: 0.4, end: PEN.clockStart + 0.4 };
      return { id: m.id, type: m.type, description: m.description || m.label || m.text || m.type,
               start: s.start, dur: s.dur, end: s.end, bbox: bboxOf(m) };
    });
    return { svg: parts.join('\n'), marks: detailed, nudges: nudges, warnings: warnings,
             width: width, height: height };
  }

  function render(input, opts) {
    return renderDetailed(input, opts).svg;
  }

  /* ------------------------------------------------------------------ */
  /* Tiny program — the model sends data or a tiny program that makes    */
  /* marks. Statements run once each (incremental live execution).       */
  /* A statement is data: { op, ...fields } or { op:'draw', mark:{...} } */
  /* or { op:'say', text, duration }.                                    */
  /* ------------------------------------------------------------------ */

  var PROGRAM_OPS = ['line', 'arrow', 'circle', 'ellipse', 'rect', 'path',
    'text', 'highlight', 'dot', 'graph', 'timeline', 'molecule', 'dashed', 'draw', 'say'];

  function runProgram(program, emit) {
    // program: array of statement objects. Returns the marks produced.
    var marks = [];
    var p = 0;
    program.forEach(function (st) {
      if (!st || typeof st !== 'object') return;
      if (PROGRAM_OPS.indexOf(st.op) === -1) return; // unknown op: ignored
      if (st.op === 'say') {
        emit({ kind: 'say', text: st.text || '', duration: st.duration || 0 });
        return;
      }
      var mark = st.op === 'draw' ? Object.assign({}, st.mark) : Object.assign({}, st);
      delete mark.op;
      if (!mark.type) mark.type = st.op; // the op IS the mark type
      p += 1;
      mark.piece = 'p' + p;
      if (!mark.id) mark.id = 'm' + (marks.length);
      if (st.say) { mark.say = st.say; mark.sayDuration = st.duration; }
      marks.push(mark);
      emit({ kind: 'mark', mark: mark, piece: mark.piece });
    });
    return marks;
  }

  /* ------------------------------------------------------------------ */
  /* live(spec, host, opts) — incremental execution with speech pacing   */
  /* ------------------------------------------------------------------ */

  function live(spec, host, opts) {
    host = host || {};
    opts = opts || {};
    var setTimeoutFn = host.setTimeout || setTimeout;
    var clearTimeoutFn = host.clearTimeout || clearTimeout;

    // Sandbox: only data programs are accepted when sandboxed. A function
    // program is rejected — the engine never executes untrusted code, and
    // in the app the sandbox is a Web Worker with a time limit; here the
    // same rule is enforced by only accepting data.
    var statements = null, initialMarks = [];
    if (Array.isArray(spec)) { initialMarks = normalizeMarks(spec); }
    else if (spec && Array.isArray(spec.program)) {
      if (opts.sandbox && typeof spec.program === 'function') {
        throw new Error('sandbox: function programs are not allowed; send data statements');
      }
      statements = spec.program;
    } else if (spec && Array.isArray(spec.marks)) { initialMarks = normalizeMarks(spec.marks); }
    else if (spec && Array.isArray(spec.steps)) {
      // steps: [{ marks:[...], say, duration, continuous }] — one group each.
      spec.steps.forEach(function (step, si) {
        (step.marks || []).forEach(function (m) {
          var c = Object.assign({}, m);
          c.group = 'step' + si;
          if (step.say) c.say = step.say;
          if (step.duration) c.sayDuration = step.duration;
          initialMarks.push(c);
        });
      });
      initialMarks = normalizeMarks(initialMarks);
    }
    if (typeof spec === 'function') {
      if (opts.sandbox) throw new Error('sandbox: function programs are not allowed; send data statements');
      // Non-sandboxed: run the builder with only the mark helpers.
      var built = [];
      spec(makeDrawApi(built));
      initialMarks = normalizeMarks(built);
    }

    var state = {
      marks: [], schedule: [], started: false, paused: false,
      finished: false, currentIndex: -1, edits: [], undone: []
    };
    var timers = [];
    var pieceCounter = 0;

    function emitMark(mark, timing) {
      state.marks.push(mark);
      state.currentIndex = state.marks.length - 1;
      if (host.onMark) host.onMark(mark, timing);
    }

    function buildSchedule(marks) {
      return computeSchedule(marks, opts);
    }

    function scheduleAll(marks) {
      var sched = buildSchedule(marks);
      state.schedule = sched;
      var byId = {};
      sched.forEach(function (s) { byId[s.id] = s; });
      marks.forEach(function (m, i) {
        var s = byId[m.id];
        var delay = Math.max(0, (s.start - PEN.clockStart) * 1000);
        var fire;
        fire = function () {
          if (state.paused) { // hold the pen after the current stroke
            timers.push(setTimeoutFn(fire, 100));
            return;
          }
          emitMark(m, s);
          if (i === marks.length - 1 && host.onDone) host.onDone({ marks: state.marks, schedule: state.schedule });
        };
        timers.push(setTimeoutFn(fire, delay));
      });
    }

    function start() {
      if (state.started) return controller;
      state.started = true;
      if (statements) {
        // Incremental: each new statement runs once, never re-runs prefix.
        var emitted = [];
        runProgram(statements, function (ev) {
          if (ev.kind === 'mark') emitted.push(ev.mark);
          else if (ev.kind === 'say' && host.onSay) host.onSay(ev.text, ev.duration);
        });
        initialMarks = normalizeMarks(emitted);
        initialMarks.forEach(function (m) { pieceCounter += 1; if (!m.piece) m.piece = 'p' + pieceCounter; });
      }
      scheduleAll(initialMarks);
      return controller;
    }

    function clearTimers() {
      timers.forEach(function (t) { try { clearTimeoutFn(t); } catch (e) { /* host timer */ } });
      timers = [];
    }

    function svg() {
      return render(state.marks, opts);
    }

    // Live editing ops (each animated in the engine's style; a new edit
    // can cut into a running one — settle() jumps it to its end).
    function edit(op, payload) {
      var timing = { op: op, at: Date.now ? Date.now() : 0 };
      switch (op) {
        case 'recolor': case 'restyle':
          timing.dur = Math.max(PEN.recolorMin, 0.3); break;
        case 'move': case 'moveTo': case 'scale':
          timing.dur = PEN.moveScale; break;
        case 'erase':
          timing.dur = PEN.erase; timing.stagger = PEN.stagger; timing.spread = PEN.spread; break;
        case 'redraw': timing.dur = 0; timing.pace = PEN.repaintPace; break;
        case 'highlight': timing.dur = PEN.highlightEdit; break;
        default: timing.dur = 0.3;
      }
      state.edits.push(Object.assign({ op: op }, payload || {}, timing));
      applyEdit(op, payload || {});
      if (host.onEdit) host.onEdit(op, payload || {}, timing);
      return timing;
    }

    function applyEdit(op, p) {
      var m = state.marks.find(function (x) { return x.id === p.id; });
      switch (op) {
        case 'recolor': if (m) m.color = p.color; break;
        case 'restyle':
          if (m) { if (p.brush) m.brush = p.brush; if (p.color) m.color = p.color; if (p.size != null) m.size = p.size; }
          break;
        case 'move':
          if (m) shiftMark(m, p.dx || 0, p.dy || 0);
          break;
        case 'moveTo':
          if (m) { var b = bboxOf(m); shiftMark(m, (p.x || 0) - b.x, (p.y || 0) - b.y); }
          break;
        case 'scale':
          if (m) scaleMark(m, p.factor || 1, p.cx, p.cy);
          break;
        case 'erase':
          // Pen runs backwards: remove, keep in undone for undo().
          if (m) {
            state.marks = state.marks.filter(function (x) { return x.id !== p.id; });
            state.undone.push(m);
          }
          break;
        case 'redraw':
          if (m) { /* re-emit with repaint pace */ if (host.onMark) host.onMark(m, { start: 0, dur: PEN.repaintPace, redraw: true }); }
          break;
        case 'add': {
          var nm = normalizeMarks([p.mark])[0];
          state.marks.push(nm);
          var s = computeSchedule(state.marks, opts).find(function (x) { return x.id === nm.id; });
          if (host.onMark) host.onMark(nm, s || { start: 0, dur: 0.4 });
          break;
        }
        case 'highlight': {
          var hm = { type: 'highlight', of: p.id, id: 'm' + state.marks.length + '_hl', color: p.color };
          state.marks.push(hm);
          if (host.onMark) host.onMark(hm, { start: 0, dur: PEN.highlightEdit });
          break;
        }
        case 'undo': {
          var last = state.marks.pop();
          if (last) state.undone.push(last);
          break;
        }
      }
    }

    function shiftMark(m, dx, dy) {
      m.x = (m.x || 0) + dx; m.y = (m.y || 0) + dy;
      if (m.x1 != null) { m.x1 += dx; m.x2 += dx; }
      if (m.y1 != null) { m.y1 += dy; m.y2 += dy; }
      if (m.points) m.points = m.points.map(function (pt) { return [pt[0] + dx, pt[1] + dy]; });
    }
    function scaleMark(m, f, cx, cy) {
      cx = cx != null ? cx : (m.x || 0); cy = cy != null ? cy : (m.y || 0);
      var sc = function (x, y) { return [cx + (x - cx) * f, cy + (y - cy) * f]; };
      if (m.x != null) { var p = sc(m.x, m.y); m.x = p[0]; m.y = p[1]; }
      if (m.x1 != null) { var a = sc(m.x1, m.y1), b = sc(m.x2, m.y2); m.x1 = a[0]; m.y1 = a[1]; m.x2 = b[0]; m.y2 = b[1]; }
      if (m.rx != null) { m.rx *= f; m.ry *= f; }
      if (m.w != null) { m.w *= f; m.h *= f; }
      if (m.points) m.points = m.points.map(function (pt) { var q = sc(pt[0], pt[1]); return q; });
      if (m.size != null) m.size *= f;
    }

    var controller = {
      start: start,
      pause: function () { state.paused = true; },
      resume: function () { state.paused = false; },
      finishNow: function () {
        // Draw everything still waiting immediately (voice carries on).
        clearTimers();
        var remaining = initialMarks.filter(function (m) {
          return !state.marks.some(function (x) { return x.id === m.id; });
        });
        remaining.forEach(function (m) {
          var s = state.schedule.find(function (x) { return x.id === m.id; }) || { start: 0, dur: 0.1 };
          emitMark(m, Object.assign({}, s, { finishedNow: true }));
        });
        state.finished = true;
        if (host.onDone) host.onDone({ marks: state.marks, schedule: state.schedule, finishedNow: true });
      },
      settle: function () { // jump any running edit to its end
        clearTimers();
        var remaining = initialMarks.filter(function (m) {
          return !state.marks.some(function (x) { return x.id === m.id; });
        });
        remaining.forEach(function (m) { emitMark(m, { start: 0, dur: 0 }); });
      },
      undo: function () { return edit('undo', {}); },
      recolor: function (id, color) { return edit('recolor', { id: id, color: color }); },
      restyle: function (id, patch) { return edit('restyle', Object.assign({ id: id }, patch || {})); },
      move: function (id, dx, dy) { return edit('move', { id: id, dx: dx, dy: dy }); },
      moveTo: function (id, x, y) { return edit('moveTo', { id: id, x: x, y: y }); },
      scale: function (id, factor, cx, cy) { return edit('scale', { id: id, factor: factor, cx: cx, cy: cy }); },
      erase: function (id) { return edit('erase', { id: id }); },
      redraw: function (id) { return edit('redraw', { id: id }); },
      add: function (mark) { return edit('add', { mark: mark }); },
      highlight: function (id, color) { return edit('highlight', { id: id, color: color }); },
      svg: svg,
      get state() { return state; },
      get schedule() { return state.schedule; },
      dispose: function () { clearTimers(); state.finished = true; }
    };
    return controller;
  }

  // Builder API handed to a (non-sandboxed) function program. Only mark
  // construction — no network, files, or host access by construction.
  function makeDrawApi(out) {
    function push(type, fields) {
      var m = Object.assign({ type: type }, fields || {});
      out.push(m); return m;
    }
    return {
      line: function (x1, y1, x2, y2, o) { return push('line', Object.assign({ x1: x1, y1: y1, x2: x2, y2: y2 }, o)); },
      arrow: function (x1, y1, x2, y2, o) { return push('arrow', Object.assign({ x1: x1, y1: y1, x2: x2, y2: y2 }, o)); },
      circle: function (x, y, r, o) { return push('circle', Object.assign({ x: x, y: y, rx: r, ry: r }, o)); },
      ellipse: function (x, y, rx, ry, o) { return push('ellipse', Object.assign({ x: x, y: y, rx: rx, ry: ry }, o)); },
      rect: function (x, y, w, h, o) { return push('rect', Object.assign({ x: x, y: y, w: w, h: h }, o)); },
      path: function (points, o) { return push('path', Object.assign({ points: points }, o)); },
      text: function (x, y, text, o) { return push('text', Object.assign({ x: x, y: y, text: text }, o)); },
      highlight: function (x, y, w, h, o) { return push('highlight', Object.assign({ x: x, y: y, w: w, h: h }, o)); },
      dot: function (x, y, o) { return push('dot', Object.assign({ x: x, y: y }, o)); },
      graph: function (o) { return push('graph', o); },
      timeline: function (o) { return push('timeline', o); },
      molecule: function (o) { return push('molecule', o); },
      dashed: function (points, o) { return push('dashed', Object.assign({ points: points }, o)); }
    };
  }

  /* ------------------------------------------------------------------ */
  /* 3D scene description for the host's Three.js r186 renderer          */
  /* Data only — the host loads the public Three.js release itself.      */
  /* ------------------------------------------------------------------ */

  function threeScene(marks, opts) {
    opts = opts || {};
    var objects = [];
    (marks || []).forEach(function (m, i) {
      var color = PALETTE_3D[m.color] || PALETTE_3D.ink;
      if (m.type === 'circle' || m.type === 'ellipse' || m.type === 'dot') {
        objects.push({ kind: 'sphere', id: m.id || ('m' + i), position: [m.x || 0, m.y || 0, 0],
                       radius: m.rx || m.r || 20, color: color });
      } else if (m.type === 'rect') {
        objects.push({ kind: 'box', id: m.id || ('m' + i), position: [(m.x || 0) + (m.w || 0) / 2, (m.y || 0) + (m.h || 0) / 2, 0],
                       size: [m.w || 0, m.h || 0, 8], color: color });
      } else if (m.type === 'line' || m.type === 'arrow') {
        objects.push({ kind: 'tube', id: m.id || ('m' + i),
                       from: [m.x1 ?? m.x, m.y1 ?? m.y, 0], to: [m.x2, m.y2, 0], radius: 2, color: color });
      } else if (m.type === 'text') {
        objects.push({ kind: 'label', id: m.id || ('m' + i), position: [m.x || 0, m.y || 0, 0],
                       text: m.text || '', size: textSize(m), color: color });
      }
    });
    return { three: 'r186', objects: objects };
  }

  /* ------------------------------------------------------------------ */
  /* Public API                                                          */
  /* ------------------------------------------------------------------ */

  return {
    version: '1.0.0',
    PALETTE: PALETTE, PALETTE_3D: PALETTE_3D, BRUSHES: BRUSHES,
    WASH: WASH, HIGHLIGHT: HIGHLIGHT, PEN: PEN, TEXT: TEXT,
    WOBBLE: WOBBLE, ARROW_HEAD_HALF_ANGLE: ARROW_HEAD_HALF_ANGLE,
    HEARTBEAT_SWELL: HEARTBEAT_SWELL,
    penDur: penDur, markTiming: markTiming, markLength: markLength,
    bowAmount: bowAmount, shade: shade, resolveColor: resolveColor,
    brushOf: brushOf, capsText: capsText, textSize: textSize,
    estimateTextWidth: estimateTextWidth, bboxOf: bboxOf,
    layoutNudge: layoutNudge, computeSchedule: computeSchedule,
    render: render, renderDetailed: renderDetailed,
    runProgram: runProgram, live: live, threeScene: threeScene,
    makeDrawApi: makeDrawApi
  };
});
