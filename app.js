import * as pdfjs from './vendor/pdfjs/pdf.min.mjs';
import { PhononTTS } from './vendor/phonon/index.js';
import { VOICES, VOICE_BASE } from './voices.js';
import { ai, AiError } from './ai.js';

const VENDOR = new URL('./vendor/pdfjs/', import.meta.url).href;
pdfjs.GlobalWorkerOptions.workerSrc = VENDOR + 'pdf.worker.min.mjs';

const $ = (id) => document.getElementById(id);
const els = {
  bar: $('bar'), docTitle: $('docTitle'), pageInd: $('pageInd'), welcome: $('welcome'), pages: $('pages'),
  player: $('player'), playBtn: $('playBtn'), nowText: $('nowText'), nowSub: $('nowSub'), retryBtn: $('retryBtn'),
  prevBtn: $('prevBtn'), nextBtn: $('nextBtn'), keepBtn: $('keepBtn'), voiceBtn: $('voiceBtn'), voiceMenu: $('voiceMenu'),
  speedSel: $('speedSel'), stopBtn: $('stopBtn'), progress: $('progress'), veil: $('veil'), toast: $('toast'),
  fileInput: $('fileInput'), voiceNote: $('voiceNote'), aiChip: $('aiChip'), aiChipText: $('aiChipText'),
  chat: $('chat'), chatLog: $('chatLog'), chatForm: $('chatForm'), chatInput: $('chatInput'),
  chatExplain: $('chatExplain'), chatClose: $('chatClose'),
  keyDialog: $('keyDialog'), keyForm: $('keyForm'), keyInput: $('keyInput'), keyErr: $('keyErr'), keySave: $('keySave'),
};

// ── Settings ────────────────────────────────────────────────────────────────

const SPEEDS = [0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];
const STORE = 'reader.settings.v2';

const settings = { voice: 'Miles', speed: 1, keepReading: false, zoom: 1, ai: true };
try { Object.assign(settings, JSON.parse(localStorage.getItem(STORE) || '{}')); } catch {}
if (!VOICES.some((v) => v.name === settings.voice)) settings.voice = 'Miles';
if (!SPEEDS.includes(settings.speed)) settings.speed = 1;
settings.zoom = Math.min(3, Math.max(0.5, Number(settings.zoom) || 1));
const saveSettings = () => { try { localStorage.setItem(STORE, JSON.stringify(settings)); } catch {} };

// ── Text analysis: PDF text items → lines → paragraphs → sentences ──────────
// Lines come from the PDF. Which lines form a paragraph is Claude's call (see `narration`),
// with a guess from the page geometry standing in until its answer arrives.

const mul = (a, b) => [
  a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1],
  a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3],
  a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5],
];
const half = (n) => Math.round(n * 2) / 2;

function finishLine(line) {
  const weight = new Map();
  const key = (g) => g.font + '|' + half(g.size);
  for (const g of line.glyphs) weight.set(key(g), (weight.get(key(g)) || 0) + g.str.length);
  const best = [...weight].sort((a, b) => b[1] - a[1])[0][0];
  const dom = line.glyphs.find((g) => key(g) === best);
  line.size = dom.size;
  line.font = dom.font;
  line.base = dom.base;
  line.top = line.base - line.size * 0.86;
  line.bottom = line.base + line.size * 0.28;
  // Small text sitting above or below the baseline is a superscript or subscript (y grows downward).
  for (const g of line.glyphs) {
    g.shift = g.size >= 0.86 * line.size ? 0
      : g.base < line.base - 0.1 * line.size ? 1
      : g.base > line.base + 0.06 * line.size ? -1 : 0;
  }
  // The line as text, with ^{...} and _{...} around super- and subscripts: what Claude is shown.
  let text = '', prev = null;
  for (const g of line.glyphs) {
    if (prev && !/\s$/.test(text) && !/^\s/.test(g.str) && (g.spaced || g.x0 - prev.x1 > 0.15 * line.size)) text += ' ';
    text += g.shift > 0 ? `^{${g.str}}` : g.shift < 0 ? `_{${g.str}}` : g.str;
    prev = g;
  }
  line.text = text.replace(/\}\^\{|\}_\{/g, '').replace(/\s+/g, ' ').trim();
}

/** A page's text items → its lines of text, in the PDF's own order. Coordinates are page units, y down. */
function extractLines(items, vt) {
  const lines = [];
  let line = null;
  let spaced = false;
  for (const it of items) {
    if (!it.str || !it.str.trim()) { spaced = spaced || !!it.str; continue; }
    const m = mul(vt, it.transform);
    if (Math.abs(Math.atan2(m[1], m[0])) > 0.2) continue; // sideways text (margin stamps)
    const size = Math.hypot(m[2], m[3]) || it.height || 10;
    const g = { str: it.str, x0: m[4], x1: m[4] + it.width, base: m[5], size, font: it.fontName, spaced };
    spaced = false;
    // A glyph continues a line when it sits on its baseline just past its end. Formulas bend both
    // rules: radicals, superscripts and the halves of a fraction sit above or below the baseline,
    // and a fraction's denominator starts back under its numerator.
    const near = (ln, tol) => Math.abs(g.base - ln.base) < tol * Math.max(ln.size, size);
    const after = (ln, reach) => g.x0 > ln.x1 - 0.6 * ln.size && g.x0 - ln.x1 < reach * Math.max(ln.size, size);
    const stacked = (ln) => !near(ln, 0.25) && g.x0 > ln.x1 - 4 * ln.size && g.x0 - ln.x1 < 1.2 * ln.size;
    const before = lines[lines.length - 2];
    if (line && near(line, 0.5) && after(line, 1.2)) {
      // the ordinary case
    } else if (before && near(before, 0.5) && after(before, 4)) {
      line = before; // back on the baseline after a stray symbol (a big sigma, a tall bracket)
    } else if (!(line && near(line, 0.9) && (after(line, 1.2) || stacked(line)))) {
      line = { glyphs: [], x0: g.x0, x1: g.x1, base: g.base, size };
      lines.push(line);
    }
    line.glyphs.push(g);
    line.x1 = Math.max(line.x1, g.x1);
    if (size > line.size * 1.05) { line.size = size; line.base = g.base; }
  }
  lines.forEach(finishLine);
  lines.forEach((ln, i) => { ln.id = i; });
  return lines;
}

/**
 * Guess which lines make up each paragraph from spacing, size and indentation. This is the
 * stand-in until Claude has looked at the page (and the only grouping when Claude is off).
 */
function guessGroups(lines) {
  // Typical line spacing per font size, so a paragraph gap can be told from a line gap.
  const tally = new Map();
  for (let i = 1; i < lines.length; i++) {
    const a = lines[i - 1], b = lines[i], dy = b.base - a.base;
    if (Math.abs(a.size - b.size) > 0.08 * a.size || dy < 0.7 * a.size || dy > 3 * a.size) continue;
    if (b.x1 < a.x0 || b.x0 > a.x1) continue;
    const k = half(a.size);
    if (!tally.has(k)) tally.set(k, new Map());
    const t = tally.get(k);
    t.set(half(dy), (t.get(half(dy)) || 0) + 1);
  }
  const leading = new Map();
  for (const [k, t] of tally) {
    const top = Math.max(...t.values());
    if (top < 2) continue;
    const floor = Math.max(2, top * 0.3);
    leading.set(k, Math.min(...[...t].filter(([, n]) => n >= floor).map(([d]) => d)));
  }

  const fits = (b, ln) => {
    const last = b.lines[b.lines.length - 1];
    const dy = ln.base - last.base;
    if (dy < 0.5 * ln.size) return false;
    const ratio = ln.size / b.size;
    if (ratio > 1.15 || ratio < 0.87) return false;
    const lead = leading.get(half(b.size)) ?? (b.lines.length > 1 ? b.lines[1].base - b.lines[0].base : b.size * 1.5);
    if (dy > lead * 1.25) return false;
    if (ln.x1 < b.x0 || ln.x0 > b.x1) return false;
    if (b.lines.length === 1 && last.font !== ln.font) return false; // heading over body text
    if (b.lines.length > 1) {
      const centered = Math.abs((ln.x0 + ln.x1) / 2 - (last.x0 + last.x1) / 2) < 0.6 * b.size;
      if (!centered && Math.abs(ln.x0 - last.x0) > 0.8 * b.size) return false; // indent or outdent starts a new one
    }
    return true;
  };
  const groups = [];
  let cur = null, held = null; // `held` is the paragraph a stray formula fragment interrupted
  const letters = (ln) => ln.glyphs.reduce((n, g) => n + g.str.replace(/[^\p{L}\p{N}]/gu, '').length, 0);
  for (const ln of lines) {
    if (cur && !fits(cur, ln) && held && fits(held, ln)) { cur = held; held = null; }
    if (cur && fits(cur, ln)) {
      cur.lines.push(ln);
      cur.x0 = Math.min(cur.x0, ln.x0);
      cur.x1 = Math.max(cur.x1, ln.x1);
    } else {
      const fragment = letters(ln) <= 6 && ln.x1 - ln.x0 < 8 * ln.size;
      held = fragment && cur ? (held && cur.lines.length === 1 && letters(cur.lines[0]) <= 6 ? held : cur) : null;
      cur = { lines: [ln], x0: ln.x0, x1: ln.x1, size: ln.size };
      groups.push(cur);
    }
  }

  return groups.map((g) => g.lines);
}

/** Join lines into one block: its text, and where every piece of that text sits on the page. */
function buildBlock(lines) {
  let text = '';
  const spans = [];
  lines.forEach((ln, li) => {
    if (li > 0) {
      const first = ln.glyphs[0].str.trimStart();
      if (/\p{L}[-­‐]$/u.test(text) && /^\p{Ll}/u.test(first)) {
        text = text.slice(0, -1); // word hyphenated across the line break
        const lastSpan = spans[spans.length - 1];
        lastSpan.end = Math.max(lastSpan.start, text.length);
      } else if (!/\s$/.test(text)) {
        text += ' ';
      }
    }
    let prev = null;
    for (const g of ln.glyphs) {
      if (prev && !/\s$/.test(text) && !/^\s/.test(g.str) && (g.spaced || g.x0 - prev.x1 > 0.15 * ln.size)) text += ' ';
      const start = text.length;
      text += g.str;
      spans.push({ start, end: text.length, x0: g.x0, x1: g.x1, line: ln, shift: g.shift });
      prev = g;
    }
  });
  if ((text.match(/\p{L}/gu) || []).length < 2) return null;
  // The block's type size is that of the line carrying most of its text (not a stray formula fragment).
  const main = lines.reduce((a, b) => (b.text.length > a.text.length ? b : a));
  return {
    text, spans, size: main.size,
    x0: Math.min(...lines.map((l) => l.x0)), x1: Math.max(...lines.map((l) => l.x1)),
    top: Math.min(...lines.map((l) => l.top)), bottom: Math.max(...lines.map((l) => l.bottom)),
  };
}

function cleanForSpeech(s) {
  return s
    .normalize('NFKC')
    .replace(/­/g, '')
    .replace(/\s*\[\d+(?:\s*[,–—-]\s*\d+)*\]/g, '') // citation markers like [12] or [3, 4]
    .replace(/[•‣▪●◦⁃∙]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const MAX_CHUNK = 280;
const ABBREV = /(?:\b(?:et al|e\.g|i\.e|vs|cf|Figs?|Eqs?|Secs?|Refs?|No|Dr|Mrs?|Ms|Prof|St|Jr|Sr|approx|ca|pp?|Vol|Ch)|\b\p{Lu})\.\s*$/u;
const segmenter = typeof Intl !== 'undefined' && Intl.Segmenter ? new Intl.Segmenter('en', { granularity: 'sentence' }) : null;

function splitLong(t, s, e, out) {
  if (e - s <= MAX_CHUNK) { out.push([s, e]); return; }
  const mid = (s + e) / 2;
  const sub = t.slice(s, e);
  let best = -1;
  for (const re of [/[,;:–—]\s/g, /\s/g]) {
    let bestD = Infinity, m;
    while ((m = re.exec(sub))) {
      const pos = s + m.index + m[0].length;
      if (pos - s < 40 || e - pos < 40) continue;
      const d = Math.abs(pos - mid);
      if (d < bestD) { bestD = d; best = pos; }
    }
    if (best >= 0) break;
  }
  if (best < 0) best = Math.round(mid);
  splitLong(t, s, best, out);
  splitLong(t, best, e, out);
}

/** Split a block into sentence-sized pieces the voice speaks one after another. */
function chunkBlock(block) {
  if (block.chunks) return block.chunks;
  const t = block.text;
  const parts = [];
  if (segmenter) {
    for (const s of segmenter.segment(t)) parts.push([s.index, s.index + s.segment.length]);
  } else {
    const re = /[^.!?]+(?:[.!?]+["'”’)\]]*\s*|$)/g;
    let m;
    while ((m = re.exec(t)) && m[0]) parts.push([m.index, m.index + m[0].length]);
  }
  const merged = [];
  for (const p of parts) {
    const last = merged[merged.length - 1];
    if (last && (last[1] - last[0] < 40 || ABBREV.test(t.slice(last[0], last[1])))) last[1] = p[1];
    else merged.push([p[0], p[1]]);
  }
  if (merged.length > 1) {
    const tail = merged[merged.length - 1];
    if (tail[1] - tail[0] < 25) { merged.pop(); merged[merged.length - 1][1] = tail[1]; }
  }
  const ranges = [];
  for (const [s, e] of merged) splitLong(t, s, e, ranges);
  block.chunks = ranges
    // `say` is the text as written; `aiSay` is Claude's spoken version, when it needed one.
    .map(([start, end]) => ({
      start, end, raw: t.slice(start, end).trim(), say: cleanForSpeech(t.slice(start, end)), aiSay: null,
      notation: NOTATION.test(t.slice(start, end)) || block.spans.some((sp) => sp.shift && sp.end > start && sp.start < end),
    }))
    .filter((c) => /[\p{L}\p{N}]/u.test(c.say));
  return block.chunks;
}

// Signs that a sentence holds something a voice would misread (a formula, a symbol, a variable,
// an abbreviation). Such sentences wait for Claude's version; plain prose is spoken straight away.
const NOTATION = new RegExp([
  '[\\u0370-\\u03FF\\u2070-\\u209F\\u2100-\\u214F\\u2190-\\u23FF\\u25A0-\\u27BF\\u2980-\\u2AFF\\u{1D400}-\\u{1D7FF}±×÷°µ]', // Greek, math, arrows
  '[=<>^_|~\\\\+*/%$#@]',
  '\\p{L}\\d|\\d\\p{L}',                                      // E4, x2, 3D
  '(?:^|[\\s(\\[])[b-hj-zB-HJ-Z](?=[\\s,.;:)\\]]|$)',          // a lone letter that isn't a word: a variable
  '\\b(?:Figs?|Eqs?|Secs?|Tabs?|Refs?|et al|e\\.g|i\\.e|cf|vs|resp|approx|ca)\\.',
  '\\d\\s*[\\u2013\\u2014-]\\s*\\d',                        // ranges
].join('|'), 'u');

/** A stretch of a block's text with ^{...} and _{...} around super- and subscripts, for Claude. */
function markedText(block, start, end) {
  let out = '', pos = start;
  for (const sp of block.spans) {
    if (sp.end <= start || sp.start >= end) continue;
    const a = Math.max(sp.start, start), b = Math.min(sp.end, end);
    out += block.text.slice(pos, a);
    const piece = block.text.slice(a, b);
    out += sp.shift > 0 ? `^{${piece}}` : sp.shift < 0 ? `_{${piece}}` : piece;
    pos = b;
  }
  return (out + block.text.slice(pos, end)).replace(/\}\^\{|\}_\{/g, '').replace(/\s+/g, ' ').trim();
}

// How far into a run of text a character offset falls, as a fraction of its width. The PDF's own
// font isn't available here, but letter proportions in a stand-in font land close enough.
const ruler = document.createElement('canvas').getContext('2d');
ruler.font = '16px Helvetica, Arial, sans-serif';
function widthFraction(str, k) {
  if (k <= 0) return 0;
  if (k >= str.length) return 1;
  const total = ruler.measureText(str).width;
  return total ? ruler.measureText(str.slice(0, k)).width / total : k / str.length;
}

/** Page rectangles (one per line, top to bottom) covering a chunk of a block's text. */
function chunkRects(block, chunk) {
  const byLine = new Map();
  for (const sp of block.spans) {
    if (sp.end <= chunk.start || sp.start >= chunk.end) continue;
    const str = block.text.slice(sp.start, sp.end);
    const f0 = widthFraction(str, chunk.start - sp.start);
    const f1 = widthFraction(str, chunk.end - sp.start);
    const x0 = sp.x0 + (sp.x1 - sp.x0) * f0;
    const x1 = sp.x0 + (sp.x1 - sp.x0) * f1;
    const r = byLine.get(sp.line);
    if (r) { r.x0 = Math.min(r.x0, x0); r.x1 = Math.max(r.x1, x1); }
    else byLine.set(sp.line, { x0, x1, top: sp.line.top, bottom: sp.line.bottom });
  }
  return [...byLine.values()].sort((a, b) => a.top - b.top);
}

/**
 * One outline around a sentence's lines, with rounded corners: the lines are joined edge to
 * edge, nearly aligned sides are straightened, and every corner (inner and outer) is eased.
 */
function sentencePath(rects, size) {
  const padX = size * 0.22, padY = size * 0.1, snap = size * 0.7, radius = size * 0.45;
  const rows = rects.map((q) => ({ x0: q.x0 - padX, x1: q.x1 + padX, top: q.top, bottom: q.bottom }));
  rows[0].top -= padY;
  rows[rows.length - 1].bottom += padY;
  for (let i = 1; i < rows.length; i++) rows[i - 1].bottom = rows[i].top = (rows[i - 1].bottom + rows[i].top) / 2;
  for (const order of [1, -1]) {
    for (let i = order > 0 ? 1 : rows.length - 1; i >= 1 && i < rows.length; i += order) {
      const a = rows[i - 1], b = rows[i];
      if (Math.abs(a.x0 - b.x0) < snap) a.x0 = b.x0 = Math.min(a.x0, b.x0);
      if (Math.abs(a.x1 - b.x1) < snap) a.x1 = b.x1 = Math.max(a.x1, b.x1);
    }
  }
  let pts = [];
  for (const q of rows) pts.push([q.x1, q.top], [q.x1, q.bottom]); // down the right side
  for (let i = rows.length - 1; i >= 0; i--) pts.push([rows[i].x0, rows[i].bottom], [rows[i].x0, rows[i].top]); // up the left
  const same = (p, q) => Math.abs(p[0] - q[0]) < 0.01 && Math.abs(p[1] - q[1]) < 0.01;
  pts = pts.filter((p, i) => !same(p, pts[(i + pts.length - 1) % pts.length]));
  pts = pts.filter((p, i) => {
    const a = pts[(i + pts.length - 1) % pts.length], b = pts[(i + 1) % pts.length];
    return !((Math.abs(a[0] - p[0]) < 0.01 && Math.abs(b[0] - p[0]) < 0.01) || (Math.abs(a[1] - p[1]) < 0.01 && Math.abs(b[1] - p[1]) < 0.01));
  });
  const f = (p) => `${p[0].toFixed(2)} ${p[1].toFixed(2)}`;
  let d = '';
  pts.forEach((p, i) => {
    const a = pts[(i + pts.length - 1) % pts.length], b = pts[(i + 1) % pts.length];
    const la = Math.hypot(a[0] - p[0], a[1] - p[1]), lb = Math.hypot(b[0] - p[0], b[1] - p[1]);
    const k = Math.min(radius, la / 2, lb / 2);
    const p1 = [p[0] + (a[0] - p[0]) / la * k, p[1] + (a[1] - p[1]) / la * k];
    const p2 = [p[0] + (b[0] - p[0]) / lb * k, p[1] + (b[1] - p[1]) / lb * k];
    d += `${i ? 'L' : 'M'}${f(p1)}Q${f(p)} ${f(p2)}`;
  });
  return d + 'Z';
}

// ── Document view ───────────────────────────────────────────────────────────

const view = { doc: null, task: null, pages: [], token: 0, bytes: null, name: '' };
const blockOf = new WeakMap();
const MAX_PIXELS = 16e6;
const SVG = 'http://www.w3.org/2000/svg';

const pct = (v, total) => (100 * v / total).toFixed(3) + '%';
const place = (el, x0, top, x1, bottom, p) => {
  el.style.left = pct(x0, p.w);
  el.style.top = pct(top, p.h);
  el.style.width = pct(x1 - x0, p.w);
  el.style.height = pct(bottom - top, p.h);
};

const nearObserver = new IntersectionObserver((entries) => {
  for (const e of entries) {
    const p = view.pages[e.target.dataset.n - 1];
    if (!p || p.el !== e.target) continue;
    p.near = e.isIntersecting;
    if (p.near) {
      renderPage(p);
      ensureBlocks(p);
      // Prepare pages the reader lingers near, not every page they scroll past.
      setTimeout(() => { if (p.near && view.pages[p.n - 1] === p) narration.request(p); }, 1200);
    } else {
      releasePage(p);
    }
  }
}, { rootMargin: '150% 0px 150% 0px' });

function makePage(n, w, h) {
  const el = document.createElement('div');
  el.className = 'page';
  el.dataset.n = n;
  el.style.aspectRatio = `${w} / ${h}`;
  const canvas = document.createElement('canvas');
  const hl = document.createElement('div');
  hl.className = 'layer hl-layer';
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('preserveAspectRatio', 'none');
  hl.append(svg);
  const blocksEl = document.createElement('div');
  blocksEl.className = 'layer';
  el.append(canvas, hl, blocksEl);
  return {
    n, el, canvas, svg, blocksEl, w, h, vt: null, proxyP: null, blocksP: null, blocks: null, lines: null,
    layout: 'none', layoutPending: null, // who grouped the lines into paragraphs: none | guess | claude
    near: false, scale: 0, target: 0, renderTask: null,
    ai: 'none', aiPromise: null, aiDone: null, // Claude's preparation of this page: none | pending | ready | error
  };
}

function getProxy(p) {
  return p.proxyP ??= view.doc.getPage(p.n).then((proxy) => {
    const v = proxy.getViewport({ scale: 1 });
    p.w = v.width;
    p.h = v.height;
    p.vt = v.transform;
    p.el.style.aspectRatio = `${p.w} / ${p.h}`;
    return proxy;
  });
}

async function renderPage(p) {
  let proxy;
  try { proxy = await getProxy(p); } catch { return; }
  const cssW = p.el.clientWidth;
  if (!p.near || !cssW) return;
  let scale = cssW * Math.min(window.devicePixelRatio || 1, 3) / p.w;
  const area = p.w * p.h * scale * scale;
  if (area > MAX_PIXELS) scale *= Math.sqrt(MAX_PIXELS / area);
  if (Math.abs(scale - p.target) < 0.005 * scale) return;
  p.renderTask?.cancel();
  p.target = scale;
  const viewport = proxy.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(viewport.width);
  canvas.height = Math.round(viewport.height);
  const task = p.renderTask = proxy.render({ canvas, viewport });
  try {
    await task.promise;
  } catch (e) {
    if (p.renderTask === task) { p.renderTask = null; p.target = p.scale; }
    if (e?.name !== 'RenderingCancelledException') console.warn('Page render failed', e);
    return;
  }
  if (p.renderTask !== task) return;
  p.renderTask = null;
  p.canvas.replaceWith(canvas);
  p.canvas = canvas;
  p.scale = scale;
  requestAnimationFrame(() => p.el.classList.add('ready'));
}

function releasePage(p) {
  p.renderTask?.cancel();
  p.renderTask = null;
  p.target = 0;
  if (p.scale) {
    p.canvas.width = p.canvas.height = 0;
    p.scale = 0;
    p.el.classList.remove('ready');
  }
}

/** Make a page's clickable paragraphs from groups of its lines: [{ lines, kind }] in reading order. */
function setBlocks(p, groups) {
  const blocks = [];
  for (const g of groups) {
    const b = buildBlock(g.lines);
    if (!b) continue;
    b.page = p;
    b.index = blocks.length;
    b.kind = g.kind || '';
    b.skip = g.kind === 'skip'; // a page number, running header, label inside a figure…: passed over when reading on
    const el = b.el = document.createElement('button');
    el.type = 'button';
    el.className = 'blk';
    el.setAttribute('aria-label', 'Read aloud: ' + b.text.slice(0, 90));
    const padX = Math.max(3, b.size * 0.5), padY = Math.max(1.5, b.size * 0.26);
    place(el, b.x0 - padX, b.top - padY, b.x1 + padX, b.bottom + padY, p);
    blockOf.set(el, b);
    blocks.push(b);
  }
  p.blocksEl.replaceChildren(...blocks.map((b) => b.el));
  p.blocks = blocks;
}

/** Replace a page's guessed paragraphs with Claude's: { blocks: [{ kind, lines: [line id] }] }. */
function applyLayout(p, layout) {
  const used = new Set(), groups = [];
  for (const { kind, lines } of layout.blocks) {
    const mine = lines.map((id) => p.lines[id]).filter((ln) => ln && !used.has(ln));
    mine.forEach((ln) => used.add(ln));
    if (mine.length) groups.push({ kind, lines: mine });
  }
  if (!groups.length) return;
  // Lines Claude left out keep the grouping the app guessed, slotted in after the line before them.
  const left = p.lines.filter((ln) => !used.has(ln));
  for (const lines of left.length ? guessGroups(left) : []) {
    const at = groups.findIndex((g) => g.lines.some((ln) => ln.id === lines[0].id - 1));
    groups.splice(at + 1, 0, { lines });
  }
  setBlocks(p, groups);
  p.layout = 'claude';
}

/** A page's paragraphs, read from the PDF on first use. They may be regrouped later: use `p.blocks` afresh after any wait. */
async function ensureBlocks(p) {
  await (p.blocksP ??= (async () => {
    try {
      const proxy = await getProxy(p);
      const content = await proxy.getTextContent();
      p.lines = extractLines(content.items, p.vt);
      setBlocks(p, guessGroups(p.lines).map((lines) => ({ lines })));
      p.layout = 'guess';
    } catch (e) {
      console.warn('Could not read text on page', p.n, e);
      p.lines = [];
      p.blocks = [];
    }
  })());
  return p.blocks;
}

/** Whether someone is listening to, or asking about, a paragraph on this page right now. */
function inUse(p) {
  const s = speaker.session;
  if (chat.block?.page === p) return true;
  return !!s && (speaker.active?.page === p || s.lastBlock.page === p || s.segs.some((x) => x.block.page === p));
}

async function adjacentBlock(block, dir) {
  let p = block.page, i = block.index + dir;
  while (p) {
    await ensureBlocks(p);
    // Claude may still be regrouping another page's paragraphs: let that finish before picking one of them.
    if (p !== block.page && usingClaude()) await narration.request(p);
    const blocks = p.blocks;
    if (i === -2) i = blocks.length - 1;
    for (; i >= 0 && i < blocks.length; i += dir) if (chunkBlock(blocks[i]).length) return blocks[i];
    p = view.pages[p.n - 1 + dir];
    i = dir > 0 ? 0 : -2;
  }
  return null;
}

/** The next block worth reading in a direction: skips what Claude marked as page furniture. */
async function nextReadable(block, dir, minLength = 0) {
  let b = block;
  for (;;) {
    b = await adjacentBlock(b, dir);
    if (!b) return null;
    if (b.text.length < minLength) continue;
    if (usingClaude()) {
      await narration.request(b.page);
      if (b.skip) continue;
    }
    return b;
  }
}

function firstVisibleBlock() {
  for (const p of view.pages) {
    if (!p.blocks || !p.near) continue;
    const pr = p.el.getBoundingClientRect();
    if (pr.bottom < BAR || pr.top > innerHeight) continue;
    for (const b of p.blocks) {
      if (b.el.getBoundingClientRect().top >= 52 && chunkBlock(b).length && !(b.skip && usingClaude())) return b;
    }
  }
  return null;
}

function reveal(block) {
  const r = block.el.getBoundingClientRect();
  if (r.top < 64 || r.bottom > innerHeight - 130) block.el.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

async function openPdf(source, name) {
  const token = ++view.token;
  speaker.stop();
  closeDoc();
  els.welcome.hidden = true;
  els.bar.hidden = els.pages.hidden = els.player.hidden = false;
  els.docTitle.textContent = name;
  els.pageInd.textContent = 'Opening…';
  document.title = `${name} — Reader`;
  view.name = name;

  let doc, first;
  try {
    const bytes = typeof source === 'string' ? new Uint8Array(await (await fetch(source)).arrayBuffer()) : source;
    if (token !== view.token) return;
    view.bytes = bytes; // kept so the same file can be handed to Claude
    const task = view.task = pdfjs.getDocument({
      data: bytes.slice(), // pdf.js takes ownership of what it is given
      cMapUrl: VENDOR + 'cmaps/', cMapPacked: true,
      standardFontDataUrl: VENDOR + 'standard_fonts/', wasmUrl: VENDOR + 'wasm/', iccUrl: VENDOR + 'iccs/',
    });
    task.onPassword = (update, reason) => {
      const pw = window.prompt(reason === 2 ? 'That password didn’t work. Try again:' : 'This PDF is protected. Enter its password:');
      if (pw === null) task.destroy(); else update(pw);
    };
    doc = await task.promise;
    first = await doc.getPage(1);
  } catch (e) {
    if (token !== view.token) return;
    console.warn(e);
    showWelcome();
    toast('That file couldn’t be opened as a PDF.');
    return;
  }
  if (token !== view.token) { doc.destroy(); return; }

  view.doc = doc;
  const v = first.getViewport({ scale: 1 });
  view.pages = Array.from({ length: doc.numPages }, (_, i) => makePage(i + 1, v.width, v.height));
  els.pages.replaceChildren(...view.pages.map((p) => p.el));
  window.scrollTo(0, 0);
  view.pages.forEach((p) => nearObserver.observe(p.el));
  updatePageInd();
  renderChip();

  // Settle every page's true size in the background, and warn early about scans.
  const pages = view.pages;
  (async () => {
    const lead = await Promise.all(pages.slice(0, 3).map(ensureBlocks));
    if (token !== view.token) return;
    if (lead.every((b) => !b.length)) {
      toast('No selectable text found — this looks like a scanned PDF, which can’t be read aloud.', 7000);
    } else if (settings.ai) {
      startClaude().then(() => pages.filter((p) => p.near).forEach((p) => narration.request(p)));
    }
    for (const p of pages) {
      if (token !== view.token) return;
      try { await getProxy(p); } catch { return; }
    }
  })();
}

function closeDoc() {
  nearObserver.disconnect();
  for (const p of view.pages) p.renderTask?.cancel();
  view.pages = [];
  view.doc = null;
  view.bytes = null;
  view.task?.destroy();
  view.task = null;
  narration.reset();
  chat.close();
  ai.close();
  els.pages.replaceChildren();
}

function showWelcome() {
  closeDoc();
  els.welcome.hidden = false;
  els.bar.hidden = els.pages.hidden = els.player.hidden = els.chat.hidden = true;
  document.title = 'Reader';
}

async function openFile(file) {
  if (!file) return;
  if (file.type !== 'application/pdf' && !/\.pdf$/i.test(file.name)) { toast('Please choose a PDF file.'); return; }
  openPdf(new Uint8Array(await file.arrayBuffer()), file.name.replace(/\.pdf$/i, ''));
}

const BAR = 56; // top bar height plus a little air
let pageIndQueued = false;
let anchor = null; // the page at the top of the window, and how far through it we are
function updatePageInd() {
  pageIndQueued = false;
  if (!view.pages.length) return;
  const mid = innerHeight / 2;
  let n = view.pages.length;
  anchor = null;
  for (const p of view.pages) {
    const r = p.el.getBoundingClientRect();
    if (!anchor && r.bottom > BAR) anchor = { p, frac: (BAR - r.top) / r.height };
    if (r.bottom > mid) { n = p.n; break; }
  }
  els.pageInd.textContent = `${n} / ${view.pages.length}`;
}

/** After the layout changes size, put the same spot of the same page back at the top. */
function restoreAnchor() {
  if (!anchor || !anchor.p.el.isConnected) return;
  const r = anchor.p.el.getBoundingClientRect();
  window.scrollBy(0, r.top + anchor.frac * r.height - BAR);
}

let rerenderTimer = 0;
function rerenderSoon() {
  clearTimeout(rerenderTimer);
  rerenderTimer = setTimeout(() => view.pages.forEach((p) => p.near && renderPage(p)), 140);
}

function setZoom(z) {
  settings.zoom = Math.min(3, Math.max(0.5, Math.round(z * 100) / 100));
  document.documentElement.style.setProperty('--zoom', settings.zoom);
  restoreAnchor();
  saveSettings();
  rerenderSoon();
}

let toastTimer = 0;
function toast(msg, ms = 4000) {
  els.toast.textContent = msg;
  els.toast.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.remove('on'), ms);
}

// ── Claude: preparing pages for reading aloud ───────────────────────────────

const PDF_PAGE_LIMIT = 100;        // beyond this, Claude gets the document as text rather than as pages
const PDF_BYTE_LIMIT = 30e6;
const TEXT_CHAR_LIMIT = 1.6e6;     // about 400,000 tokens

const usingClaude = () => settings.ai && ai.usable;

/** Send the open document to Claude, if that hasn't happened yet. Resolves when Claude can take requests. */
async function startClaude() {
  await aiReady;
  if (!view.doc || !ai.available) return false;
  if (ai.doc && ai.doc.state !== 'error') return ai.doc.ready.then(() => true, () => false);
  const token = view.token;
  let payload = view.bytes;
  if (view.pages.length > PDF_PAGE_LIMIT || payload.length > PDF_BYTE_LIMIT) {
    const parts = [];
    for (const p of view.pages) {
      const blocks = await ensureBlocks(p);
      if (token !== view.token) return false;
      parts.push(`=== Page ${p.n} ===\n` + blocks.map((b) => b.text).join('\n\n'));
    }
    payload = parts.join('\n\n');
    if (payload.length > TEXT_CHAR_LIMIT) {
      ai.doc = { state: 'error', error: new AiError('too_long'), ready: Promise.reject(new AiError('too_long')) };
      ai.doc.ready.catch(() => {});
      renderChip();
      return false;
    }
  }
  try {
    await ai.open(payload, view.name);
    return true;
  } catch (e) {
    if (token === view.token) toast(`${e.message} Reading the text as written for now.`, 6000);
    return false;
  }
}

/**
 * Claude's pass over each page: first which lines make up each paragraph, then which sentences
 * need different words when spoken and what to skip.
 */
const narration = {
  queue: [],
  running: 0,
  warned: false,

  reset() {
    this.queue = [];
    this.warned = false;
  },

  /** Ask for a page to be prepared. Resolves when it has been (or can't be); `urgent` jumps the queue. */
  request(p, urgent = false) {
    if (!usingClaude()) return Promise.resolve();
    if (!p.aiPromise) {
      p.ai = 'pending';
      p.aiPromise = new Promise((done) => { p.aiDone = done; });
      this.queue.push(p);
    }
    if (urgent) {
      const i = this.queue.indexOf(p);
      if (i > 0) this.queue.unshift(...this.queue.splice(i, 1));
    }
    this.drain();
    return p.aiPromise;
  },

  /**
   * Prepare one paragraph on its own, ahead of its page. A whole page takes several seconds;
   * a single paragraph comes back in about two, which is what a click is willing to wait.
   */
  rush(block) {
    if (!usingClaude() || block.page.ai === 'ready') return Promise.resolve();
    return block.rushed ??= (async () => {
      const token = view.token;
      const pieces = chunkBlock(block).map((c, i) => ({ id: `${block.index}.${i}`, text: markedText(block, c.start, c.end) }));
      try {
        const result = await ai.narrate(block.page.n, pieces);
        if (token !== view.token) return;
        for (const { id, say } of result.changes) {
          const chunk = block.chunks[Number(id.split('.')[1])];
          if (chunk) chunk.aiSay = say;
        }
        block.prepared = true;
      } catch (e) {
        block.rushed = null;
        console.warn('Claude could not prepare that paragraph', e);
      }
    })();
  },

  /** Whether Claude's wording for this block is in (or isn't coming). */
  settled(block) {
    return block.prepared || block.page.ai === 'ready' || block.page.ai === 'error';
  },

  drain() {
    while (this.running < 3 && this.queue.length) {
      const p = this.queue.shift();
      this.running++;
      this.prepare(p).finally(() => {
        this.running--;
        p.aiDone();
        this.drain();
        renderPlayer();
        this.relayout();
      });
    }
  },

  /**
   * Swap in paragraphs Claude worked out while their page was being listened to, now that it
   * isn't. Called whenever that may have changed: listening stopped or moved on, a page finished.
   */
  relayout() {
    for (const p of view.pages) {
      if (!p.layoutPending || p.ai === 'pending' || inUse(p)) continue;
      applyLayout(p, p.layoutPending);
      p.layoutPending = null;
      p.ai = 'none';
      p.aiPromise = null; // the new paragraphs need their own wording
      if (p.near) this.request(p);
    }
  },

  async prepare(p) {
    const token = view.token;
    try {
      await ensureBlocks(p);
      if (p.layout === 'guess' && p.lines.length) {
        const layout = await ai.layout(p.n, p.lines.map((ln) => ({
          id: ln.id, x: Math.round(ln.x0), y: Math.round(ln.base), size: Math.round(ln.size * 10) / 10, text: ln.text.slice(0, 200),
        }))).catch((e) => {
          if (e.code !== 'not_found') throw e; // a server from before this existed: carry on with the guess
          p.layout = 'unavailable';
          return null;
        });
        if (token !== view.token) return;
        // Paragraphs can't change under someone listening to them: keep Claude's for when they've moved on.
        if (layout && inUse(p)) p.layoutPending = layout; else if (layout) applyLayout(p, layout);
      }
      const blocks = p.blocks;
      const pieces = [];
      for (const b of blocks) {
        chunkBlock(b).forEach((c, i) => pieces.push({ id: `${b.index}.${i}`, text: markedText(b, c.start, c.end) }));
      }
      if (pieces.length) {
        const result = await ai.narrate(p.n, pieces);
        if (token !== view.token) return;
        for (const { id, say } of result.changes) {
          const [bi, ci] = id.split('.').map(Number);
          const chunk = blocks[bi]?.chunks?.[ci];
          if (chunk) chunk.aiSay = say;
        }
        for (const bi of result.skip) if (blocks[bi]) blocks[bi].skip = true;
      }
      p.ai = 'ready';
    } catch (e) {
      if (token !== view.token) return;
      p.ai = 'error';
      p.aiPromise = null; // allow another try later
      console.warn('Claude could not prepare page', p.n, e);
      if (e.code === 'auth' || e.code === 'no_key' || e.code === 'no_sdk') ai.fail(ai.doc, e);
      if (!this.warned) {
        this.warned = true;
        toast(`${e.message || 'Claude ran into a problem.'} Reading the text as written for now.`, 6000);
      }
    }
  },
};

// ── Voice ───────────────────────────────────────────────────────────────────

// The model takes a pacing value when it loads. Measured here: +0.3 speaks at about 0.88x,
// -0.3 at 1.24x, -0.5 at 1.33x, and past that it stops behaving. Speeds outside that range
// are finished off by stretching the audio in time without changing its pitch.
const PACING = [[0.88, 0.3], [1, 0], [1.24, -0.3], [1.33, -0.5]];
function pacing(speed) {
  const lo = PACING[0], hi = PACING[PACING.length - 1];
  if (speed <= lo[0]) return { delta: lo[1], stretch: speed / lo[0] };
  if (speed >= hi[0]) return { delta: hi[1], stretch: speed / hi[0] };
  for (let i = 1; i < PACING.length; i++) {
    const [s0, d0] = PACING[i - 1], [s1, d1] = PACING[i];
    if (speed <= s1) return { delta: +(d0 + (d1 - d0) * (speed - s0) / (s1 - s0)).toFixed(3), stretch: 1 };
  }
  return { delta: 0, stretch: 1 };
}

/** Speed speech up or slow it down without changing its pitch (overlap-add, aligning each frame to the last). */
function timeStretch(x, rate, sr) {
  if (Math.abs(rate - 1) < 0.04 || x.length < sr * 0.25) return x;
  const N = 2 * Math.round(sr * 0.016), Hs = N / 2, Ha = Hs * rate, reach = Math.round(sr * 0.01);
  const win = new Float32Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * (i + 0.5) / N);
  const frames = Math.max(1, Math.floor((x.length - N - reach) / Ha) + 1);
  const y = new Float32Array(frames * Hs + N);
  let prev = 0;
  for (let k = 0; k < frames; k++) {
    let pos = Math.round(k * Ha);
    if (k > 0) {
      const want = prev + Hs; // where the previous frame would naturally carry on
      let best = -Infinity, bestD = 0;
      for (let d = Math.max(-reach, -pos), end = Math.min(reach, x.length - N - pos); d <= end; d += 2) {
        let c = 0, e = 1e-9;
        for (let i = 0; i < Hs; i += 2) { const v = x[pos + d + i]; c += v * x[want + i]; e += v * v; }
        const score = c / Math.sqrt(e);
        if (score > best) { best = score; bestD = d; }
      }
      pos += bestD;
    }
    for (let i = 0; i < N; i++) y[k * Hs + i] += x[pos + i] * win[i];
    prev = pos;
  }
  return y;
}

const voiceFile = (name) => VOICES.find((v) => v.name === name)?.file;

const voice = {
  tts: null,
  state: 'idle', // idle | loading | ready | error
  pct: 0,
  everReady: false,
  delta: null,
  job: null,
  added: new Set(),

  /** Load the model, or reload it when the chosen speed needs a different pacing value. */
  load() {
    const { delta } = pacing(settings.speed);
    if (this.job && this.delta === delta && this.state !== 'error') return this.job;
    this.delta = delta;
    this.state = 'loading';
    renderPlayer();
    const job = this.job = (async () => {
      try {
        const tts = await PhononTTS.load({
          lang: 'en',
          device: 'auto', // the GPU when the browser offers one, otherwise CPU threads
          conditions: { duration_delta: delta },
          onProgress: ({ loaded, total }) => {
            if (total > 5e6 && !this.everReady) { this.pct = Math.min(99, Math.floor(100 * loaded / total)); renderPlayer(); }
          },
        });
        if (this.job !== job) { tts.dispose(); return; }
        this.tts?.dispose();
        this.tts = tts;
        this.added = new Set(tts.voices);
        // Warm up (compiles GPU pipelines, fetches the chosen voice) before announcing ready.
        await this.synth('Ready.', settings.voice).catch(() => {});
        if (this.job !== job) return;
        this.state = 'ready';
        this.everReady = true;
        this.pct = 100;
      } catch (e) {
        if (this.job !== job) return;
        console.error('Voice model failed to load:', e);
        this.state = 'error';
      }
      renderPlayer();
      speaker.pump();
    })();
    return job;
  },

  /** Speak one piece of text. → { pcm: Float32Array, rate } */
  async synth(text, name, signal) {
    const tts = this.tts;
    if (!this.added.has(name)) {
      try {
        await tts.addVoice(name, VOICE_BASE + voiceFile(name));
        this.added.add(name);
      } catch (e) {
        console.warn('Could not fetch voice', name, e);
        if (!this.voiceWarned) { this.voiceWarned = true; toast(`Couldn’t download the voice “${name}”. Using the built-in one for now.`); }
        name = 'default';
      }
    }
    const pcm = await tts.synth(text, { voice: name, signal });
    return { pcm: timeStretch(pcm, pacing(settings.speed).stretch, tts.sampleRate), rate: tts.sampleRate };
  },
};

// ── Speech ──────────────────────────────────────────────────────────────────

const segsFor = (block) => chunkBlock(block).map((chunk) => ({ block, chunk, gap: 0 }));
const spoken = (chunk) => (!chunk.explain && settings.ai && chunk.aiSay) || chunk.say;
const BUFFER_AHEAD = 25;   // seconds of audio to keep ready beyond the playhead

/** Where the first sentence in a growing piece of text ends, or 0 if it hasn't yet. */
function sentenceEnd(buf) {
  const re = /[.!?]["'”’)\]]*\s+/g;
  let m;
  while ((m = re.exec(buf))) if (m.index + m[0].length >= 40) return m.index + m[0].length;
  return 0;
}

const speaker = {
  ctx: null,
  session: null,
  seq: 0,
  active: null, // the block currently highlighted
  last: null,
  previewSrc: null,

  ensureCtx() {
    if (!this.ctx) this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (this.ctx.state !== 'running') this.ctx.resume();
  },

  /**
   * Begin a session on a block, either reading it ('read') or speaking Claude's reply to a turn
   * of the chat about it ('explain').
   */
  start(block, mode, turn = null) {
    this.halt();
    this.ensureCtx();
    const s = this.session = {
      id: ++this.seq, mode, turn, segs: [], next: 0, sched: [], nextTime: 0, cur: -1,
      // A reply is a one-off: it never carries on to the next paragraph.
      busy: false, paused: false, extending: false, exhausted: !!turn, streaming: false, streamBlock: null,
      lastBlock: block, waitPage: null,
      // A double-click starts as a single click; holding audio back briefly lets it change its mind unheard.
      notBefore: this.ctx.currentTime + 0.25,
      synthAbort: new AbortController(), aiAbort: new AbortController(),
    };
    setActive(block, null, false, mode);
    if (mode === 'explain') {
      this.streamReply(s, block);
    } else {
      s.segs = segsFor(block);
      narration.request(block.page, true);
    }
    if (voice.state === 'error') voice.load();
    renderPlayer();
    this.pump();
  },

  speak(block) {
    if (chunkBlock(block).length) this.start(block, 'read');
  },

  /** Whether Claude can be asked about a paragraph; if not, says why. */
  canExplain() {
    if (ai.available) return true;
    if (ai.reason === 'no_key') openKeyDialog(); else toast(ai.offMessage, 6000);
    return false;
  },


  /** A click on the paragraph being spoken pauses or resumes it; on any other one, reads it. */
  toggleBlock(block) {
    if (this.session && this.active === block) this.toggle();
    else this.speak(block);
  },


  toggle() {
    const s = this.session;
    if (!s) {
      const b = firstVisibleBlock();
      if (b) this.speak(b);
      return;
    }
    s.paused = !s.paused;
    if (s.paused) this.ctx.suspend(); else this.ctx.resume();
    renderPlayer();
  },

  async skip(dir) {
    const from = this.active;
    if (!from) return;
    const b = await nextReadable(from, dir);
    if (b && this.active === from) { this.start(b, 'read'); reveal(b); } // from a reply, this goes back to reading
  },

  /** Collect Claude's reply to a chat turn as it streams in, handing each finished sentence to the voice. */
  async streamReply(s, block) {
    s.streaming = true;
    s.streamBlock = block;
    const signal = s.aiAbort.signal, turn = s.turn;
    let buf = '';
    const emit = (text) => {
      const say = cleanForSpeech(text);
      if (!/[\p{L}\p{N}]/u.test(say)) return;
      const chunk = { say, raw: text.trim(), explain: true };
      turn.chunks.push(chunk);
      s.segs.push({ block, chunk, gap: 0 });
      chat.render();
      this.pump();
    };
    try {
      if (!(await startClaude())) throw ai.doc?.error || new AiError('api');
      const near = block.page.blocks || [];
      await ai.explain({
        page: block.page.n, text: block.text, question: turn.question, history: chat.before(turn), signal,
        before: near[block.index - 1]?.text.slice(-500) || '',
        after: near[block.index + 1]?.text.slice(0, 500) || '',
        onText: (delta) => {
          buf += delta;
          for (let cut; (cut = sentenceEnd(buf)) > 0; buf = buf.slice(cut)) emit(buf.slice(0, cut));
        },
      });
      if (!signal.aborted && buf.trim()) emit(buf);
    } catch (e) {
      if (!signal.aborted) turn.error = e.message || 'Claude could not answer that.';
    }
    turn.done = true; // even when cut short: what arrived stays in the conversation
    chat.render();
    if (this.session !== s || signal.aborted) return;
    s.streaming = false;
    renderPlayer();
    this.pump();
  },

  /** Voice the next sentence, unless enough audio is already queued or something it needs isn't ready. */
  pump() {
    const s = this.session;
    if (!s || s.busy || voice.state !== 'ready') return;
    const ahead = s.sched.length ? s.nextTime - this.ctx.currentTime : 0;
    if (s.next >= s.segs.length) {
      if (s.streaming || s.extending || s.exhausted || !settings.keepReading) return;
      if (ahead > BUFFER_AHEAD) return;
      this.extend(s);
      return;
    }
    if (ahead > BUFFER_AHEAD) return;
    const idx = s.next, id = s.id, seg = s.segs[idx];
    const block = seg.block;
    if (seg.chunk.notation && usingClaude() && !narration.settled(block)) {
      // Claude is still working out how this should be spoken: wait for it rather than read "E4".
      if (s.waitPage !== block) {
        s.waitPage = block;
        Promise.race([narration.rush(block), narration.request(block.page, true)]).then(() => {
          if (this.session !== s || s.waitPage !== block) return;
          s.waitPage = null;
          // Whichever answered first, don't ask again for this block even if it brought nothing.
          block.prepared = true;
          renderPlayer();
          this.pump();
        });
        renderPlayer();
      }
      return;
    }
    s.busy = true;
    const signal = s.synthAbort.signal;
    voice.synth(spoken(seg.chunk), settings.voice, signal).then(
      (audio) => {
        if (this.session !== s || s.id !== id) return;
        s.busy = false;
        this.onAudio(s, idx, audio);
      },
      (e) => {
        if (this.session !== s || s.id !== id) return;
        s.busy = false;
        if (signal.aborted || voice.state !== 'ready') return; // interrupted, not failed: it will be asked again
        console.warn('Could not voice a sentence:', e);
        s.next = idx + 1;
        this.pump();
      },
    );
  },

  async extend(s) {
    s.extending = true;
    const b = await nextReadable(s.lastBlock, 1).catch(() => null);
    if (this.session !== s) return;
    s.extending = false;
    if (!b) { s.exhausted = true; return; }
    s.lastBlock = b;
    const segs = segsFor(b);
    segs[0].gap = 0.35; // a breath between paragraphs
    s.segs.push(...segs);
    this.pump();
  },

  onAudio(s, idx, { pcm, rate }) {
    if (idx >= s.segs.length) return;
    const seg = s.segs[idx];
    s.next = idx + 1;
    if (pcm.length) {
      const ctx = this.ctx;
      const buf = ctx.createBuffer(1, pcm.length, rate);
      buf.getChannelData(0).set(pcm);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(ctx.destination);
      const start = Math.max(s.nextTime + seg.gap, ctx.currentTime + 0.05, s.notBefore);
      src.start(start);
      s.sched.push({ start, end: start + buf.duration, seg, src });
      s.nextTime = start + buf.duration;
      this.last = { seconds: buf.duration, text: spoken(seg.chunk) };
    }
    this.pump();
  },

  /** Runs a few times a second: moves the highlight, tops up the buffer, notices the end. */
  tick() {
    const s = this.session;
    if (!s || !this.ctx) return;
    const t = this.ctx.currentTime;
    let cur = -1;
    for (let i = s.sched.length - 1; i >= 0; i--) {
      const e = s.sched[i];
      if (cur < 0 && t >= e.start - 0.03) cur = i;
      if (e.src && e.end < t - 1) { e.src.disconnect(); e.src = null; }
    }
    if (cur !== s.cur) {
      s.cur = cur;
      if (cur >= 0) setActive(s.sched[cur].seg.block, s.sched[cur].seg.chunk, true, s.mode);
      renderPlayer();
    }
    const drained = s.next >= s.segs.length && !s.busy && !s.streaming && !s.extending && (!settings.keepReading || s.exhausted);
    if (drained && (!s.sched.length || t > s.sched[s.sched.length - 1].end + 0.12)) { this.stop(); return; }
    this.pump();
  },

  /** Voice, speed or Claude setting changed: voice again from the sentence being spoken. */
  restart() {
    const s = this.session;
    if (!s) return;
    const from = s.cur >= 0 ? Math.max(0, s.segs.indexOf(s.sched[s.cur].seg)) : 0;
    this.silence(s.sched);
    s.synthAbort.abort();
    Object.assign(s, {
      id: ++this.seq, segs: s.segs.slice(from), next: 0, sched: [], nextTime: 0, cur: -1,
      busy: false, notBefore: 0, waitPage: null, synthAbort: new AbortController(),
    });
    setActive(this.active, null, false, s.mode);
    renderPlayer();
    this.pump();
  },

  /** "Keep reading" switched off: finish the current paragraph, drop anything queued after it. */
  trimToActive() {
    const s = this.session;
    if (!s || !this.active) return;
    if (s.streaming && s.streamBlock !== this.active) {
      s.aiAbort.abort();
      s.aiAbort = new AbortController();
      s.streaming = false;
    }
    const end = s.segs.findLastIndex((x) => x.block === this.active) + 1;
    if (end <= 0) return;
    s.segs.length = end;
    s.next = Math.min(s.next, end);
    s.lastBlock = this.active;
    this.silence(s.sched.filter((e) => e.seg.block !== this.active));
    s.sched = s.sched.filter((e) => e.seg.block === this.active);
    s.nextTime = s.sched.length ? s.sched[s.sched.length - 1].end : 0;
  },

  /** Say a short line in a voice, so it can be judged before reading with it. */
  async preview(name) {
    if (this.session || voice.state !== 'ready') return;
    this.ensureCtx();
    this.stopPreview();
    const mine = this.previewToken = {};
    try {
      const { pcm, rate } = await voice.synth(`Hi, I'm ${name}. This is how I'll read to you.`, name);
      if (this.previewToken !== mine || this.session) return;
      const buf = this.ctx.createBuffer(1, pcm.length, rate);
      buf.getChannelData(0).set(pcm);
      const src = this.previewSrc = this.ctx.createBufferSource();
      src.buffer = buf;
      src.connect(this.ctx.destination);
      src.start();
    } catch {}
  },

  stopPreview() {
    this.previewToken = null;
    try { this.previewSrc?.stop(); } catch {}
    this.previewSrc = null;
  },

  silence(entries) {
    for (const e of entries) {
      if (!e.src) continue;
      try { e.src.stop(); } catch {}
      e.src.disconnect();
      e.src = null;
    }
  },

  halt() {
    this.stopPreview();
    const s = this.session;
    if (s) {
      this.silence(s.sched);
      s.synthAbort.abort();
      s.aiAbort.abort();
    }
    this.session = null;
  },

  stop() {
    this.halt();
    setActive(null, null);
    renderPlayer();
    narration.relayout();
  },
};

// ── Highlighting ────────────────────────────────────────────────────────────

let shownPath = null;
function setActive(block, chunk, auto = false, mode = 'read') {
  const prev = speaker.active;
  if (prev !== block) {
    prev?.el.classList.remove('active', 'pending', 'explain');
    speaker.active = block;
    if (block && auto) reveal(block);
    if (prev && block && prev.page !== block.page) narration.relayout();
  }
  if (block) {
    block.el.classList.add('active');
    block.el.classList.toggle('explain', mode === 'explain');
    block.el.classList.toggle('pending', !chunk);
  }
  // Fade the previous sentence out as the next fades in.
  if (shownPath) {
    const old = shownPath;
    old.classList.remove('on');
    setTimeout(() => old.remove(), 320);
    shownPath = null;
  }
  if (block && chunk && chunk.start != null) {
    const p = block.page;
    p.svg.setAttribute('viewBox', `0 0 ${p.w} ${p.h}`);
    const path = shownPath = document.createElementNS(SVG, 'path');
    path.setAttribute('d', sentencePath(chunkRects(block, chunk), block.size));
    p.svg.append(path);
    path.getBoundingClientRect(); // settle the starting state so the fade-in runs
    path.classList.add('on');
  }
}

// ── Rendering the controls ──────────────────────────────────────────────────

function renderPlayer() {
  const s = speaker.session;
  const loading = voice.state === 'loading' && !voice.everReady;
  const preparing = `Preparing voice… ${voice.pct}%`;
  const explaining = s?.mode === 'explain';
  let text, sub;
  if (voice.state === 'error') {
    text = 'The voice couldn’t load';
    sub = 'The first run needs a connection to download it.';
  } else if (s) {
    const seg = s.cur >= 0 ? s.sched[s.cur].seg : null;
    text = seg ? (seg.chunk.explain ? seg.chunk.raw : spoken(seg.chunk))
      : loading ? preparing
      : explaining ? 'Claude is thinking…'
      : s.waitPage ? 'Claude is preparing this passage…'
      : 'Starting…';
    const page = (seg ? seg.block : speaker.active ?? s.lastBlock).page.n;
    sub = `${explaining ? (s.turn.question ? 'Answering · ' : 'Explaining · ') : ''}Page ${page}${s.paused ? ' · Paused' : ''}`;
  } else {
    text = loading ? preparing : 'Click a paragraph to listen';
    sub = loading ? 'The first run downloads about 65 MB, once.' : 'Double-click one to ask Claude about it';
  }
  els.nowText.textContent = text;
  els.nowSub.textContent = sub;
  els.player.classList.toggle('playing', !!s && !s.paused);
  els.player.classList.toggle('waiting', !!s && !s.paused && s.cur < 0 && voice.state !== 'error');
  els.player.classList.toggle('explaining', explaining);
  els.playBtn.setAttribute('aria-label', s && !s.paused ? 'Pause' : 'Play');
  els.retryBtn.hidden = voice.state !== 'error';
  els.stopBtn.hidden = !s;
  els.prevBtn.disabled = els.nextBtn.disabled = !s;
  els.voiceBtn.textContent = settings.voice.split(' ').slice(0, 2).join(' ');
  els.progress.style.width = voice.pct + '%';
  els.progress.classList.toggle('done', !loading);
  if (location.protocol !== 'file:') {
    els.voiceNote.textContent = loading ? preparing
      : voice.state === 'ready' ? 'Voice ready'
      : voice.state === 'error' ? 'The voice couldn’t load yet — it will retry when you start reading.' : '';
  }
  chat.render();
}

function renderChip() {
  let state = 'on', text = 'Claude on', title = 'Claude prepares formulas and notation for reading aloud. Click to turn off.';
  if (!ai.available) {
    state = ai.reason === 'waking' ? 'busy' : 'off';
    text = ai.reason === 'no_key' ? 'Connect Claude' : ai.reason === 'waking' ? 'Waking Claude…' : 'Claude off';
    title = ai.reason === 'no_key' ? 'Add an Anthropic API key to turn on Claude.' : ai.offMessage;
  } else if (!settings.ai) {
    state = 'off'; text = 'Claude off'; title = 'Click to have Claude prepare formulas and notation for reading aloud.';
  } else if (ai.doc?.state === 'error') {
    state = 'problem'; text = 'Claude: retry'; title = ai.doc.error?.message || '';
  } else if (ai.doc?.state === 'sending') {
    state = 'busy'; text = 'Sending to Claude…';
  } else if (ai.doc?.state === 'reading') {
    state = 'busy'; text = 'Claude is reading…'; title = 'Claude is reading the whole document. You can start listening already.';
  }
  els.aiChip.dataset.state = state;
  els.aiChip.title = title;
  els.aiChipText.textContent = text;
}

function openKeyDialog() {
  els.keyErr.textContent = '';
  els.keyInput.value = '';
  els.keyDialog.showModal();
}

function buildVoiceMenu() {
  const nodes = [];
  for (const group of ['American', 'British', 'Characters']) {
    const head = document.createElement('div');
    head.className = 'voice-group';
    head.textContent = group;
    nodes.push(head);
    for (const v of VOICES.filter((x) => x.group === group)) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'voice-item';
      item.setAttribute('role', 'radio');
      item.dataset.voice = v.name;
      const name = document.createElement('b');
      name.textContent = v.name;
      const tags = document.createElement('small');
      tags.textContent = v.tags;
      const about = document.createElement('span');
      about.textContent = v.about;
      item.append(name, tags, about);
      nodes.push(item);
    }
  }
  els.voiceMenu.replaceChildren(...nodes);
  markVoice();
}

function markVoice() {
  for (const item of els.voiceMenu.querySelectorAll('.voice-item')) {
    item.setAttribute('aria-checked', item.dataset.voice === settings.voice);
  }
}

// ── Chatting with Claude about a paragraph ──────────────────────────────────

/**
 * The bar above the player that a double-click opens: a conversation with Claude about one
 * paragraph. Each turn is a question (empty for "explain this") and Claude's reply, which is
 * spoken as it arrives; earlier turns go back to Claude with every new question.
 */
const chat = {
  block: null,
  turns: [], // [{ question, chunks: [the reply's sentences], done, error }]
  shown: '',

  /** Open the bar on a paragraph, starting a new conversation unless it is already about that one. */
  open(block) {
    if (this.block !== block) {
      this.close();
      this.block = block;
      block.el.classList.add('chosen');
      els.chatInput.value = '';
    }
    els.chat.hidden = false;
    this.render();
    els.chatInput.focus({ preventScroll: true });
  },

  close() {
    if (!this.block) return;
    if (speaker.session?.mode === 'explain') speaker.stop();
    this.block.el.classList.remove('chosen');
    this.block = null;
    this.turns = [];
    els.chat.hidden = true;
    narration.relayout();
  },

  /** Put a question to Claude; an empty one asks it to explain the paragraph. */
  send(question) {
    question = question.trim().replace(/\s+/g, ' ');
    if (!this.block || (!question && this.turns.length) || !speaker.canExplain()) return;
    const turn = { question, chunks: [], done: false, error: '' };
    this.turns.push(turn);
    els.chatInput.value = '';
    speaker.start(this.block, 'explain', turn);
    this.render();
  },

  /** The conversation up to a turn, as Claude needs it. */
  before(turn) {
    return this.turns.slice(0, this.turns.indexOf(turn))
      .map((t) => ({ question: t.question, answer: t.chunks.map((c) => c.raw).join(' ') }))
      .filter((t) => t.answer);
  },

  render() {
    if (!this.block) return;
    const s = speaker.session;
    const now = s?.mode === 'explain' && s.cur >= 0 ? s.sched[s.cur].seg.chunk : null;
    const last = this.turns[this.turns.length - 1];
    const key = [this.turns.length, last?.chunks.length, last?.done, last?.error, last?.chunks.indexOf(now)].join('|');
    els.chatExplain.hidden = this.turns.length > 0;
    els.chatInput.placeholder = this.turns.length ? 'Ask a follow-up…' : 'Ask about this paragraph…';
    els.chatLog.hidden = !this.turns.length;
    if (this.shown === key) return;
    this.shown = key;
    let nowEl = null;
    els.chatLog.replaceChildren(...this.turns.flatMap((turn) => {
      const q = document.createElement('div');
      q.className = 'chat-q';
      q.textContent = turn.question || 'Explain this paragraph';
      const a = document.createElement('div');
      a.className = 'chat-a';
      const at = turn.chunks.indexOf(now);
      a.append(...turn.chunks.flatMap((chunk, i) => {
        const span = document.createElement('span');
        span.textContent = chunk.raw;
        // The reply being spoken dims what is still to come; finished replies are plain text.
        if (at >= 0) span.className = i < at ? 'said' : i === at ? 'now' : 'coming';
        if (i === at) nowEl = span;
        return [span, ' '];
      }));
      if (turn.error) {
        const err = document.createElement('span');
        err.className = 'err';
        err.textContent = turn.error;
        a.append(err);
      } else if (!turn.chunks.length) {
        const wait = document.createElement('span');
        wait.className = 'coming';
        wait.textContent = turn.done ? 'No reply came back.' : 'Thinking…';
        a.append(wait);
      }
      return [q, a];
    }));
    // Follow the sentence being spoken; otherwise stay with the newest words.
    if (nowEl) els.chatLog.scrollTop = Math.max(0, nowEl.offsetTop - els.chatLog.offsetTop - 40);
    else els.chatLog.scrollTop = els.chatLog.scrollHeight;
  },
};

els.chatForm.addEventListener('submit', (e) => { e.preventDefault(); chat.send(els.chatInput.value); });
els.chatExplain.addEventListener('click', () => { chat.send(''); els.chatInput.focus({ preventScroll: true }); });
els.chatClose.addEventListener('click', () => chat.close());
els.chatInput.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); chat.close(); } });

// ── Wiring ──────────────────────────────────────────────────────────────────

for (const sp of SPEEDS) els.speedSel.add(new Option(`${sp}×`, sp));
els.speedSel.value = settings.speed;
els.keepBtn.setAttribute('aria-pressed', settings.keepReading);
document.documentElement.style.setProperty('--zoom', settings.zoom);
buildVoiceMenu();

els.pages.addEventListener('click', (e) => {
  const b = blockOf.get(e.target);
  if (b && e.detail < 2) speaker.toggleBlock(b); // the second click of a double-click is handled below
});
els.pages.addEventListener('dblclick', (e) => {
  const b = blockOf.get(e.target);
  if (!b) return;
  speaker.stop(); // including the reading the first click of the pair began
  if (speaker.canExplain()) chat.open(b);
});
els.playBtn.addEventListener('click', () => speaker.toggle());
els.stopBtn.addEventListener('click', () => speaker.stop());
els.prevBtn.addEventListener('click', () => speaker.skip(-1));
els.nextBtn.addEventListener('click', () => speaker.skip(1));
els.retryBtn.addEventListener('click', () => voice.load());
els.keepBtn.addEventListener('click', () => {
  settings.keepReading = !settings.keepReading;
  els.keepBtn.setAttribute('aria-pressed', settings.keepReading);
  saveSettings();
  if (settings.keepReading) speaker.pump(); else speaker.trimToActive();
  toast(settings.keepReading ? 'Keep reading: on — continues to the next paragraph.' : 'Keep reading: off — stops after each paragraph.', 2200);
});
els.speedSel.addEventListener('change', () => {
  settings.speed = Number(els.speedSel.value);
  saveSettings();
  voice.load();
  speaker.restart();
});
els.voiceMenu.addEventListener('click', (e) => {
  const item = e.target.closest('.voice-item');
  if (!item) return;
  settings.voice = item.dataset.voice;
  saveSettings();
  markVoice();
  els.voiceMenu.hidePopover();
  renderPlayer();
  if (speaker.session) speaker.restart(); else speaker.preview(settings.voice);
});
els.voiceMenu.addEventListener('toggle', (e) => {
  if (e.newState === 'open') els.voiceMenu.querySelector('[aria-checked="true"]')?.scrollIntoView({ block: 'center' });
});

els.aiChip.addEventListener('click', () => {
  if (!ai.available) {
    if (ai.reason === 'no_key') openKeyDialog(); else toast(ai.offMessage, 8000);
    return;
  }
  if (settings.ai && ai.doc?.state === 'error') { startClaude(); return; }
  settings.ai = !settings.ai;
  saveSettings();
  if (settings.ai) startClaude().then(() => view.pages.filter((p) => p.near).forEach((p) => narration.request(p)));
  toast(settings.ai ? 'Claude on — formulas and notation are prepared for reading aloud.' : 'Claude off — reading the text exactly as written.', 3000);
  renderChip();
  speaker.restart();
});
els.keyForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const key = els.keyInput.value.trim();
  if (!key) return;
  els.keySave.disabled = true;
  els.keyErr.textContent = '';
  try {
    await ai.setKey(key);
    els.keyDialog.close();
    settings.ai = true;
    saveSettings();
    startClaude();
    toast('Claude is connected.');
  } catch (err) {
    els.keyErr.textContent = err.message;
  }
  els.keySave.disabled = false;
});
$('keyCancel').addEventListener('click', () => els.keyDialog.close());

$('zoomIn').addEventListener('click', () => setZoom(settings.zoom * 1.12));
$('zoomOut').addEventListener('click', () => setZoom(settings.zoom / 1.12));
$('openBtn').addEventListener('click', () => els.fileInput.click());
$('chooseBtn').addEventListener('click', () => els.fileInput.click());
els.fileInput.addEventListener('change', () => { openFile(els.fileInput.files[0]); els.fileInput.value = ''; });

addEventListener('keydown', (e) => {
  if (!view.doc || e.metaKey || e.ctrlKey || e.altKey || els.keyDialog.open) return;
  const t = e.target;
  if (t.tagName === 'SELECT' || t.tagName === 'INPUT') return;
  if (e.key === ' ') {
    if (t.tagName === 'BUTTON' && t.matches(':focus-visible')) return; // let keyboard users press the focused button
    e.preventDefault();
    speaker.toggle();
  } else if (e.key === 'Escape') { if (speaker.session) speaker.stop(); else chat.close(); }
  else if (e.key === 'ArrowRight') speaker.skip(1);
  else if (e.key === 'ArrowLeft') speaker.skip(-1);
});

let dragDepth = 0;
const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
addEventListener('dragenter', (e) => { if (hasFiles(e)) { e.preventDefault(); dragDepth++; els.veil.classList.add('on'); } });
addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
addEventListener('dragleave', (e) => { if (hasFiles(e) && --dragDepth <= 0) { dragDepth = 0; els.veil.classList.remove('on'); } });
addEventListener('drop', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  els.veil.classList.remove('on');
  openFile(e.dataTransfer.files[0]);
});

addEventListener('scroll', () => { if (!pageIndQueued) { pageIndQueued = true; requestAnimationFrame(updatePageInd); } }, { passive: true });
addEventListener('resize', () => { restoreAnchor(); updatePageInd(); rerenderSoon(); });
setInterval(() => speaker.tick(), 80);

ai.onChange = () => { renderChip(); renderPlayer(); };
renderPlayer();
renderChip();
voice.load();
const aiReady = ai.init();

const linked = new URLSearchParams(location.search).get('file');
if (linked) openPdf(new URL(linked, location.href).href, decodeURIComponent(linked.split('/').pop()).replace(/\.pdf$/i, ''));

window.reader = { speaker, view, settings, voice, ai, narration };
