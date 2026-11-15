import * as pdfjs from './vendor/pdfjs/pdf.min.mjs';

const VENDOR = new URL('./vendor/pdfjs/', import.meta.url).href;
pdfjs.GlobalWorkerOptions.workerSrc = VENDOR + 'pdf.worker.min.mjs';

const $ = (id) => document.getElementById(id);
const els = {
  bar: $('bar'), docTitle: $('docTitle'), pageInd: $('pageInd'), welcome: $('welcome'), pages: $('pages'),
  player: $('player'), playBtn: $('playBtn'), nowText: $('nowText'), nowSub: $('nowSub'), retryBtn: $('retryBtn'),
  prevBtn: $('prevBtn'), nextBtn: $('nextBtn'), keepBtn: $('keepBtn'), voiceSel: $('voiceSel'), speedSel: $('speedSel'),
  stopBtn: $('stopBtn'), progress: $('progress'), veil: $('veil'), toast: $('toast'), fileInput: $('fileInput'),
  voiceNote: $('voiceNote'),
};

// ── Settings ────────────────────────────────────────────────────────────────

const VOICES = [
  ['af_heart', 'Heart · US'], ['af_bella', 'Bella · US'], ['af_nicole', 'Nicole · US'],
  ['am_michael', 'Michael · US'], ['am_fenrir', 'Fenrir · US'], ['am_puck', 'Puck · US'],
  ['bf_emma', 'Emma · UK'], ['bm_george', 'George · UK'], ['bm_fable', 'Fable · UK'],
];
const SPEEDS = [0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];
const STORE = 'reader.settings.v1';

const settings = { voice: 'af_heart', speed: 1, keepReading: false, zoom: 1 };
try { Object.assign(settings, JSON.parse(localStorage.getItem(STORE) || '{}')); } catch {}
if (!VOICES.some(([id]) => id === settings.voice)) settings.voice = 'af_heart';
if (!SPEEDS.includes(settings.speed)) settings.speed = 1;
settings.zoom = Math.min(3, Math.max(0.5, Number(settings.zoom) || 1));
const saveSettings = () => { try { localStorage.setItem(STORE, JSON.stringify(settings)); } catch {} };

// ── Text analysis: PDF text items → lines → paragraphs → sentences ──────────

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
}

/** Group a page's text items into paragraph-like blocks. Coordinates are page units, y down. */
function detectBlocks(items, vt) {
  // 1. Items → lines, following the PDF's own reading order.
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
    const joins = line
      && Math.abs(g.base - line.base) < 0.5 * Math.max(line.size, size)
      && g.x0 > line.x1 - 0.6 * line.size
      && g.x0 - line.x1 < 1.2 * Math.max(line.size, size);
    if (!joins) {
      line = { glyphs: [], x0: g.x0, x1: g.x1, base: g.base, size };
      lines.push(line);
    }
    line.glyphs.push(g);
    line.x1 = Math.max(line.x1, g.x1);
    if (size > line.size * 1.05) { line.size = size; line.base = g.base; }
  }
  lines.forEach(finishLine);

  // 2. Typical line spacing per font size, so a paragraph gap can be told from a line gap.
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

  // 3. Lines → blocks.
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
  let cur = null;
  for (const ln of lines) {
    if (cur && fits(cur, ln)) {
      cur.lines.push(ln);
      cur.x0 = Math.min(cur.x0, ln.x0);
      cur.x1 = Math.max(cur.x1, ln.x1);
    } else {
      cur = { lines: [ln], x0: ln.x0, x1: ln.x1, size: ln.size };
      groups.push(cur);
    }
  }

  // 4. Assemble each block's text, remembering where every piece sits on the page.
  const blocks = [];
  for (const grp of groups) {
    let text = '';
    const spans = [];
    grp.lines.forEach((ln, li) => {
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
        spans.push({ start, end: text.length, x0: g.x0, x1: g.x1, line: ln });
        prev = g;
      }
    });
    if ((text.match(/\p{L}/gu) || []).length < 2) continue;
    blocks.push({
      text, spans, size: grp.size, x0: grp.x0, x1: grp.x1,
      top: Math.min(...grp.lines.map((l) => l.top)),
      bottom: Math.max(...grp.lines.map((l) => l.bottom)),
    });
  }
  return blocks;
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

const MAX_CHUNK = 280; // the voice model handles ~500 phonemes at a time
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

/** Split a block into sentence-sized pieces the voice can speak one after another. */
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
    .map(([start, end]) => ({ start, end, raw: t.slice(start, end).trim(), say: cleanForSpeech(t.slice(start, end)) }))
    .filter((c) => /[\p{L}\p{N}]/u.test(c.say));
  return block.chunks;
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

/** Page rectangles (one per line) covering a chunk of a block's text. */
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
  return [...byLine.values()];
}

// ── Document view ───────────────────────────────────────────────────────────

const view = { doc: null, task: null, pages: [], token: 0 };
const blockOf = new WeakMap();
const MAX_PIXELS = 16e6;

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
    if (p.near) { renderPage(p); ensureBlocks(p); } else releasePage(p);
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
  const blocksEl = document.createElement('div');
  blocksEl.className = 'layer';
  el.append(canvas, hl, blocksEl);
  return { n, el, canvas, hl, blocksEl, w, h, vt: null, proxyP: null, blocksP: null, blocks: null, near: false, scale: 0, target: 0, renderTask: null };
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

function ensureBlocks(p) {
  return p.blocksP ??= (async () => {
    try {
      const proxy = await getProxy(p);
      const content = await proxy.getTextContent();
      const blocks = detectBlocks(content.items, p.vt);
      blocks.forEach((b, i) => {
        b.page = p;
        b.index = i;
        const el = b.el = document.createElement('button');
        el.type = 'button';
        el.className = 'blk';
        el.setAttribute('aria-label', 'Read aloud: ' + b.text.slice(0, 90));
        const padX = Math.max(3, b.size * 0.45), padY = Math.max(1.5, b.size * 0.22);
        place(el, b.x0 - padX, b.top - padY, b.x1 + padX, b.bottom + padY, p);
        blockOf.set(el, b);
      });
      p.blocksEl.replaceChildren(...blocks.map((b) => b.el));
      return p.blocks = blocks;
    } catch (e) {
      console.warn('Could not read text on page', p.n, e);
      return p.blocks = [];
    }
  })();
}

async function adjacentBlock(block, dir) {
  let p = block.page, i = block.index + dir;
  while (p) {
    const blocks = await ensureBlocks(p);
    if (i === -2) i = blocks.length - 1;
    for (; i >= 0 && i < blocks.length; i += dir) if (chunkBlock(blocks[i]).length) return blocks[i];
    p = view.pages[p.n - 1 + dir];
    i = dir > 0 ? 0 : -2;
  }
  return null;
}

function firstVisibleBlock() {
  for (const p of view.pages) {
    if (!p.blocks || !p.near) continue;
    const pr = p.el.getBoundingClientRect();
    if (pr.bottom < BAR || pr.top > innerHeight) continue;
    for (const b of p.blocks) {
      if (b.el.getBoundingClientRect().top >= 52 && chunkBlock(b).length) return b;
    }
  }
  return null;
}

function reveal(block) {
  const r = block.el.getBoundingClientRect();
  if (r.top < 64 || r.bottom > innerHeight - 110) block.el.scrollIntoView({ block: 'center', behavior: 'smooth' });
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

  const task = pdfjs.getDocument({
    ...(typeof source === 'string' ? { url: source } : { data: source }),
    cMapUrl: VENDOR + 'cmaps/', cMapPacked: true,
    standardFontDataUrl: VENDOR + 'standard_fonts/', wasmUrl: VENDOR + 'wasm/', iccUrl: VENDOR + 'iccs/',
  });
  task.onPassword = (update, reason) => {
    const pw = window.prompt(reason === 2 ? 'That password didn’t work. Try again:' : 'This PDF is protected. Enter its password:');
    if (pw === null) task.destroy(); else update(pw);
  };
  view.task = task;
  let doc, first;
  try {
    doc = await task.promise;
    first = await doc.getPage(1);
  } catch (e) {
    if (token !== view.token) return;
    console.warn(e);
    showWelcome();
    toast('That file couldn’t be opened as a PDF.');
    return;
  }
  if (token !== view.token) { task.destroy(); return; }

  view.doc = doc;
  const v = first.getViewport({ scale: 1 });
  view.pages = Array.from({ length: doc.numPages }, (_, i) => makePage(i + 1, v.width, v.height));
  els.pages.replaceChildren(...view.pages.map((p) => p.el));
  window.scrollTo(0, 0);
  view.pages.forEach((p) => nearObserver.observe(p.el));
  updatePageInd();

  // Settle every page's true size in the background, and warn early about scans.
  const pages = view.pages;
  (async () => {
    const lead = await Promise.all(pages.slice(0, 3).map(ensureBlocks));
    if (token === view.token && lead.every((b) => !b.length)) {
      toast('No selectable text found — this looks like a scanned PDF, which can’t be read aloud.', 7000);
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
  view.task?.destroy();
  view.task = null;
  els.pages.replaceChildren();
}

function showWelcome() {
  closeDoc();
  els.welcome.hidden = false;
  els.bar.hidden = els.pages.hidden = els.player.hidden = true;
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

// ── Speech ──────────────────────────────────────────────────────────────────

const segsFor = (block) => chunkBlock(block).map((chunk) => ({ block, chunk, gap: 0 }));
const BUFFER_AHEAD = 25; // seconds of audio to keep ready beyond the playhead

const speaker = {
  worker: null,
  model: 'idle', // idle | loading | ready | error
  pct: 0,
  ctx: null,
  session: null,
  seq: 0,
  active: null, // the block currently highlighted
  device: null, // webgpu | wasm, once the voice is ready
  last: null,

  init() {
    this.worker?.terminate();
    this.model = 'loading';
    this.pct = 0;
    const w = this.worker = new Worker(new URL('./tts-worker.js', import.meta.url), { type: 'module' });
    w.onmessage = (e) => this.onMessage(e.data);
    w.onerror = (e) => {
      console.error('Voice worker error', e.message || e);
      if (this.model !== 'ready') { this.model = 'error'; renderPlayer(); }
    };
    w.postMessage({ type: 'load', voice: settings.voice });
    renderPlayer();
  },

  onMessage(m) {
    const s = this.session;
    switch (m.type) {
      case 'progress':
        if (m.total > 5e6) { this.pct = Math.min(99, Math.floor(100 * m.loaded / m.total)); renderPlayer(); }
        break;
      case 'ready':
        this.device = m.device;
        this.model = 'ready';
        this.pct = 100;
        renderPlayer();
        this.pump();
        break;
      case 'load-error':
        console.error('Voice model failed to load:', m.message);
        this.model = 'error';
        renderPlayer();
        break;
      case 'audio':
        this.onAudio(m);
        break;
      case 'gen-error':
        console.warn('Could not voice a sentence:', m.message);
        if (s && m.id === s.id) { s.inflight = false; s.next = Math.max(s.next, m.idx + 1); this.pump(); }
        break;
    }
  },

  ensureCtx() {
    if (!this.ctx) this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (this.ctx.state !== 'running') this.ctx.resume();
  },

  speak(block) {
    const segs = segsFor(block);
    if (!segs.length) return;
    this.halt();
    this.ensureCtx();
    this.session = {
      id: ++this.seq, segs, next: 0, sched: [], nextTime: 0, cur: -1,
      inflight: false, paused: false, extending: false, exhausted: false, lastBlock: block,
    };
    setActive(block, null);
    if (this.model === 'error') this.init();
    renderPlayer();
    this.pump();
  },

  /** Clicking the paragraph being read pauses or resumes it; any other one starts reading it. */
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
    const b = await adjacentBlock(from, dir);
    if (b && this.active === from) { this.speak(b); reveal(b); }
  },

  /** Ask the worker for the next sentence, unless enough audio is already queued. */
  pump() {
    const s = this.session;
    if (!s || s.inflight || this.model !== 'ready') return;
    if (s.next >= s.segs.length) {
      if (settings.keepReading && !s.extending && !s.exhausted) this.extend(s);
      return;
    }
    if (s.sched.length && s.nextTime - this.ctx.currentTime > BUFFER_AHEAD) return;
    s.inflight = true;
    this.worker.postMessage({
      type: 'generate', id: s.id, idx: s.next,
      text: s.segs[s.next].chunk.say, voice: settings.voice, speed: settings.speed,
    });
  },

  async extend(s) {
    s.extending = true;
    const b = await adjacentBlock(s.lastBlock, 1).catch(() => null);
    s.extending = false;
    if (this.session !== s) return;
    if (!b) { s.exhausted = true; return; }
    s.lastBlock = b;
    const segs = segsFor(b);
    segs[0].gap = 0.35; // a breath between paragraphs
    s.segs.push(...segs);
    this.pump();
  },

  onAudio(m) {
    const s = this.session;
    if (!s || m.id !== s.id) return; // from a paragraph we've already left
    s.inflight = false;
    if (m.idx >= s.segs.length) return;
    this.last = { ms: m.ms, seconds: m.audio.length / m.rate };
    const seg = s.segs[m.idx];
    s.next = m.idx + 1;
    if (m.audio.length) {
      const ctx = this.ctx;
      const buf = ctx.createBuffer(1, m.audio.length, m.rate);
      buf.getChannelData(0).set(m.audio);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(ctx.destination);
      const start = Math.max(s.nextTime + seg.gap, ctx.currentTime + 0.05);
      src.start(start);
      s.sched.push({ start, end: start + buf.duration, seg, src });
      s.nextTime = start + buf.duration;
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
      if (cur >= 0) setActive(s.sched[cur].seg.block, s.sched[cur].seg.chunk, true);
      renderPlayer();
    }
    const drained = s.next >= s.segs.length && !s.inflight && !s.extending && (!settings.keepReading || s.exhausted);
    if (drained && (!s.sched.length || t > s.sched[s.sched.length - 1].end + 0.12)) { this.stop(); return; }
    this.pump();
  },

  /** Voice or speed changed: re-voice from the sentence being read. */
  restart() {
    const s = this.session;
    if (!s) return;
    const from = s.cur >= 0 ? Math.max(0, s.segs.indexOf(s.sched[s.cur].seg)) : 0;
    this.silence(s.sched);
    Object.assign(s, { id: ++this.seq, segs: s.segs.slice(from), next: 0, sched: [], nextTime: 0, cur: -1, inflight: false });
    setActive(this.active, null);
    renderPlayer();
    this.pump();
  },

  /** "Keep reading" switched off: finish the current paragraph, drop anything queued after it. */
  trimToActive() {
    const s = this.session;
    if (!s || !this.active) return;
    const end = s.segs.findLastIndex((x) => x.block === this.active) + 1;
    if (end <= 0) return;
    s.segs.length = end;
    s.next = Math.min(s.next, end);
    s.lastBlock = this.active;
    this.silence(s.sched.filter((e) => e.seg.block !== this.active));
    s.sched = s.sched.filter((e) => e.seg.block === this.active);
    s.nextTime = s.sched.length ? s.sched[s.sched.length - 1].end : 0;
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
    if (this.session) this.silence(this.session.sched);
    this.session = null;
  },

  stop() {
    this.halt();
    setActive(null, null);
    renderPlayer();
  },
};

let hlPage = null;
function setActive(block, chunk, auto = false) {
  const prev = speaker.active;
  if (prev !== block) {
    prev?.el.classList.remove('active', 'pending');
    speaker.active = block;
    block?.el.classList.add('active');
    if (block && auto) reveal(block);
  }
  block?.el.classList.toggle('pending', !chunk);
  hlPage?.hl.replaceChildren();
  hlPage = null;
  if (block && chunk) {
    const p = hlPage = block.page;
    const padX = block.size * 0.12;
    p.hl.replaceChildren(...chunkRects(block, chunk).map((r) => {
      const d = document.createElement('div');
      d.className = 'hl';
      place(d, r.x0 - padX, r.top, r.x1 + padX, r.bottom, p);
      return d;
    }));
  }
}

function renderPlayer() {
  const s = speaker.session, model = speaker.model;
  const loading = model === 'loading';
  const preparing = `Preparing voice… ${speaker.pct}%`;
  let text, sub;
  if (model === 'error') {
    text = 'The voice couldn’t load';
    sub = 'The first run needs a connection to download it.';
  } else if (s) {
    const seg = s.cur >= 0 ? s.sched[s.cur].seg : null;
    text = seg ? seg.chunk.raw : loading ? preparing : 'Starting…';
    sub = `Page ${(seg ? seg.block : speaker.active ?? s.lastBlock).page.n}${s.paused ? ' · Paused' : ''}`;
  } else {
    text = loading ? preparing : 'Click any paragraph to listen';
    sub = loading ? 'The first run downloads about 330 MB, once.' : 'Space to play or pause · Esc to stop';
  }
  els.nowText.textContent = text;
  els.nowSub.textContent = sub;
  els.player.classList.toggle('playing', !!s && !s.paused);
  els.player.classList.toggle('waiting', !!s && !s.paused && s.cur < 0 && model !== 'error');
  els.playBtn.setAttribute('aria-label', s && !s.paused ? 'Pause' : 'Play');
  els.retryBtn.hidden = model !== 'error';
  els.stopBtn.hidden = !s;
  els.prevBtn.disabled = els.nextBtn.disabled = !s;
  els.progress.style.width = speaker.pct + '%';
  els.progress.classList.toggle('done', !loading);
  els.voiceNote.textContent = location.protocol === 'file:' ? els.voiceNote.textContent
    : loading ? preparing : model === 'ready' ? 'Voice ready' : model === 'error' ? 'The voice couldn’t load yet — it will retry when you start reading.' : '';
}

// ── Wiring ──────────────────────────────────────────────────────────────────

for (const [id, label] of VOICES) els.voiceSel.add(new Option(label, id));
for (const sp of SPEEDS) els.speedSel.add(new Option(`${sp}×`, sp));
els.voiceSel.value = settings.voice;
els.speedSel.value = settings.speed;
els.keepBtn.setAttribute('aria-pressed', settings.keepReading);
document.documentElement.style.setProperty('--zoom', settings.zoom);

els.pages.addEventListener('click', (e) => {
  const b = blockOf.get(e.target);
  if (b) speaker.toggleBlock(b);
});
els.playBtn.addEventListener('click', () => speaker.toggle());
els.stopBtn.addEventListener('click', () => speaker.stop());
els.prevBtn.addEventListener('click', () => speaker.skip(-1));
els.nextBtn.addEventListener('click', () => speaker.skip(1));
els.retryBtn.addEventListener('click', () => speaker.init());
els.keepBtn.addEventListener('click', () => {
  settings.keepReading = !settings.keepReading;
  els.keepBtn.setAttribute('aria-pressed', settings.keepReading);
  saveSettings();
  if (settings.keepReading) speaker.pump(); else speaker.trimToActive();
  toast(settings.keepReading ? 'Keep reading: on — continues to the next paragraph.' : 'Keep reading: off — stops after each paragraph.', 2200);
});
els.voiceSel.addEventListener('change', () => { settings.voice = els.voiceSel.value; saveSettings(); speaker.restart(); });
els.speedSel.addEventListener('change', () => { settings.speed = Number(els.speedSel.value); saveSettings(); speaker.restart(); });
$('zoomIn').addEventListener('click', () => setZoom(settings.zoom * 1.12));
$('zoomOut').addEventListener('click', () => setZoom(settings.zoom / 1.12));
$('openBtn').addEventListener('click', () => els.fileInput.click());
$('chooseBtn').addEventListener('click', () => els.fileInput.click());
els.fileInput.addEventListener('change', () => { openFile(els.fileInput.files[0]); els.fileInput.value = ''; });

addEventListener('keydown', (e) => {
  if (!view.doc || e.metaKey || e.ctrlKey || e.altKey) return;
  const t = e.target;
  if (t.tagName === 'SELECT' || t.tagName === 'INPUT') return;
  if (e.key === ' ') {
    if (t.tagName === 'BUTTON' && t.matches(':focus-visible')) return; // let keyboard users press the focused button
    e.preventDefault();
    speaker.toggle();
  } else if (e.key === 'Escape') speaker.stop();
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

renderPlayer();
speaker.init();

const linked = new URLSearchParams(location.search).get('file');
if (linked) openPdf(new URL(linked, location.href).href, decodeURIComponent(linked.split('/').pop()).replace(/\.pdf$/i, ''));

window.reader = { speaker, view, settings };
