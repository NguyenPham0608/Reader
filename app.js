import * as pdfjs from './vendor/pdfjs/pdf.min.mjs';
import { PhononTTS } from './vendor/phonon/index.js';
import { NEURAL_VOICES, engineKey, loadNeural } from './neural.js';
import { VOICES, VOICE_BASE } from './voices.js';
import { ai, AiError } from './ai.js';
import { speakable } from './speakable.js';

const VENDOR = new URL('./vendor/pdfjs/', import.meta.url).href;
pdfjs.GlobalWorkerOptions.workerSrc = VENDOR + 'pdf.worker.min.mjs';

const $ = (id) => document.getElementById(id);
const els = {
  bar: $('bar'), docTitle: $('docTitle'), pageInd: $('pageInd'), welcome: $('welcome'), pages: $('pages'),
  player: $('player'), playBtn: $('playBtn'), retryBtn: $('retryBtn'),
  prevBtn: $('prevBtn'), nextBtn: $('nextBtn'), scopeBtn: $('scopeBtn'), scopeMenu: $('scopeMenu'), voiceBtn: $('voiceBtn'), voiceMenu: $('voiceMenu'), langBtn: $('langBtn'), langMenu: $('langMenu'),
  capBtn: $('capBtn'), caption: $('caption'), captionLang: $('captionLang'), captionText: $('captionText'),
  speedSel: $('speedSel'), stopBtn: $('stopBtn'), progress: $('progress'), veil: $('veil'), toast: $('toast'),
  fileInput: $('fileInput'), voiceNote: $('voiceNote'), aiChip: $('aiChip'), aiChipText: $('aiChipText'),
  chat: $('chat'), chatLog: $('chatLog'), chatForm: $('chatForm'), chatInput: $('chatInput'),
  chatExplain: $('chatExplain'), chatClose: $('chatClose'),
  keyDialog: $('keyDialog'), keyForm: $('keyForm'), keyInput: $('keyInput'), keyErr: $('keyErr'), keySave: $('keySave'),
};

// ── Settings ────────────────────────────────────────────────────────────────

const SPEEDS = [0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];
const STORE = 'reader.settings.v2';

// `lang`: '' reads the text as written; a language code ('fr') has Claude translate it into that
// language first. `sysVoices` is the system voice chosen for each language.
const settings = { voice: 'Miles', speed: 1, scope: 'paragraph', zoom: 1, ai: true, lang: '', sysVoices: {}, plain: {}, own: {}, captions: true, colors: {} };
try { Object.assign(settings, JSON.parse(localStorage.getItem(STORE) || '{}')); } catch {}
if (!VOICES.some((v) => v.name === settings.voice)) settings.voice = 'Miles';
if (!SPEEDS.includes(settings.speed)) settings.speed = 1;
settings.zoom = Math.min(3, Math.max(0.5, Number(settings.zoom) || 1));
if (typeof settings.lang !== 'string' || !/^[a-z]{2,3}$/.test(settings.lang)) settings.lang = '';
if (!settings.sysVoices || typeof settings.sysVoices !== 'object') settings.sysVoices = {};
if (!settings.plain || typeof settings.plain !== 'object') settings.plain = {};
if (!settings.own || typeof settings.own !== 'object') settings.own = {};
// How much is read at a time. It used to be a switch, "keep reading", between a paragraph and the whole document.
const SCOPES = [
  { id: 'sentence', name: 'Sentence', short: 'Sent.', unit: 'sentence', about: 'Reads one sentence and stops.' },
  { id: 'paragraph', name: 'Paragraph', short: 'Para.', unit: 'paragraph', about: 'Reads one paragraph and stops.' },
  { id: 'section', name: 'Section', short: 'Sect.', unit: 'section', about: 'Reads on until the next heading.' },
  { id: 'document', name: 'Whole document', short: 'Doc.', unit: 'paragraph', about: 'Reads on to the end.' },
];
if (!SCOPES.some((x) => x.id === settings.scope)) settings.scope = settings.keepReading ? 'document' : 'paragraph';
delete settings.keepReading;
/** Whether reading carries on past the end of a paragraph. */
const readsOn = () => settings.scope === 'section' || settings.scope === 'document';
if (!settings.colors || typeof settings.colors !== 'object') settings.colors = {};
const saveSettings = () => { try { localStorage.setItem(STORE, JSON.stringify(settings)); } catch {} };

// ── Reading in another language ─────────────────────────────────────────────
// Claude translates, sentence by sentence. English is spoken by the reader's own voices; they
// speak nothing else, so any other language is spoken by a voice the browser or system has.

const synth = window.speechSynthesis || null;
let sysVoices = [];
const tagOf = (v) => v.lang.replace(/_/g, '-');
const baseOf = (tag) => tag.split('-')[0].toLowerCase();
/** A language's name ('pt-BR' → "Brazilian Portuguese"), in the language `locale`. */
function languageName(tag, locale = 'en') {
  try { return new Intl.DisplayNames([locale], { type: 'language' }).of(tag) || tag; } catch { return tag; }
}
const voicesFor = (lang) => sysVoices.filter((v) => baseOf(tagOf(v)) === lang);
const NOVELTY = /^(?:Eddy|Flo|Grandma|Grandpa|Reed|Rocko|Sandy|Shelley)\b/; // macOS's character voices, in every language

/** The system voice for a language: the one chosen, or else the plainest one that works offline. */
function sysVoice(lang = settings.lang) {
  const all = voicesFor(lang);
  let home = ''; // the language's main country: France for French, Brazil for Portuguese
  try { home = new Intl.Locale(lang).maximize().region || ''; } catch {}
  const rank = (v) => (tagOf(v).split('-').includes(home) ? 4 : 0) + (v.localService ? 2 : 0) + (NOVELTY.test(v.name) ? 0 : 1);
  return all.find((v) => v.voiceURI === settings.sysVoices[lang]) ?? all.reduce((a, b) => (a && rank(a) >= rank(b) ? a : b), null);
}
/** Silence the system voice. Cancelling one that is paused leaves the next waiting, hence the resume. */
const hush = () => { synth?.cancel(); synth?.resume(); };
/**
 * The reader's neural voice for the language being read in, where it has any and a system voice
 * wasn't preferred (`settings.plain`): the one chosen (`settings.own`), or else the first.
 */
function neuralFor(lang = settings.lang) {
  const all = NEURAL_VOICES[lang];
  return all && !settings.plain[lang] ? all.find((v) => v.id === settings.own[lang]) ?? all[0] : null;
}
/** Whether speech comes from a system voice rather than one of the reader's own. */
const usesSysVoice = () => !!settings.lang && settings.lang !== 'en' && !neuralFor();
/** The language being translated into, as specific as the voice is ('pt-BR'), or '' when reading as written. */
const targetLang = () => neuralFor()?.tag ?? (usesSysVoice() ? (sysVoice() ? tagOf(sysVoice()) : settings.lang) : settings.lang);
/**
 * How much English the voice reading a translation into `lang` says the English way, so Claude
 * knows what it may leave in English: 'words' and acronyms (VieNeu, and the reader's English
 * voices), 'acronyms' only (Piper), or 'none' (Supertonic and the system's voices).
 */
function englishFor(lang) {
  if (baseOf(lang) === 'en') return 'words';
  const engine = usesSysVoice() ? null : neuralFor()?.engine;
  return engine === 'vieneu' ? 'words' : engine === 'piper' ? 'acronyms' : 'none';
}

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
    text, spans, lines, size: main.size, font: main.font,
    x0: Math.min(...lines.map((l) => l.x0)), x1: Math.max(...lines.map((l) => l.x1)),
    top: Math.min(...lines.map((l) => l.top)), bottom: Math.max(...lines.map((l) => l.bottom)),
  };
}

// ── Paragraphs that carry on in the next column or on the next page ─────────
// The page gives each column's and each page's share of a paragraph as its own block. Blocks
// that are really one paragraph are linked (`next` / `prev`) and then selected, highlighted and
// read as one, with the sentence that straddles the break spoken in a single breath.

const BODY = new Set(['', 'paragraph', 'list']);
const PASSABLE = new Set(['skip', 'caption', 'table', 'footnote', 'other']);
const SENTENCE_OVER = /[.!?:…]["'”’)\]]*\d{0,3}$/u; // allows a footnote mark after the full stop
const HYPHEN_END = /\p{L}[-\u00AD\u2010]$/u;

/** Whether a stretch of text reads as running prose rather than a formula, a table row or a label. */
function prose(text) {
  const tokens = text.trim().split(/\s+/);
  const words = tokens.filter((t) => /^[(“"‘']*\p{L}[\p{L}'’-]+[.,;:!?)”"’']*$/u.test(t));
  return tokens.length >= 3 && words.length >= tokens.length / 2;
}

/** Whether block `b` picks up the paragraph that block `a` leaves unfinished. */
function continues(a, b) {
  if (!BODY.has(a.kind) || !BODY.has(b.kind) || a.skip || b.skip) return false;
  if (Math.abs(a.size - b.size) > 0.06 * a.size || a.font !== b.font) return false;
  // On the same page the rest must start a new column: to the right, and higher up than where this ends.
  if (b.page === a.page && !(b.x0 > (a.x0 + a.x1) / 2 && b.top < a.bottom)) return false;
  const end = a.text.trimEnd(), start = b.text.trimStart();
  if (end.length < 25 || SENTENCE_OVER.test(end)) return false;
  if (!prose(end.slice(-80)) || !prose(start.slice(0, 80)) || /^(?:fig|table|scheme)\b/i.test(start)) return false;
  if (HYPHEN_END.test(end)) return /^\p{L}/u.test(start);
  if (/^\p{Ll}/u.test(start) || /[,;–—(]$/.test(end)) return true;
  // A capital can still carry a sentence on (a name, say): trust it when the last line ran to
  // the edge of its column and the next block doesn't open with an indent.
  const lastLine = a.lines[a.lines.length - 1];
  return /^\p{Lu}/u.test(start) && a.lines.length > 2 && b.lines.length > 1 && end.length > 200 && start.length > 80
    && lastLine.x1 > a.x1 - 1.5 * a.size && b.lines[0].x0 < b.x0 + 0.5 * b.size;
}

/** Whether `x` may sit between the two halves of `a`'s paragraph: a page number, a footnote, a caption… */
function passable(x, a) {
  if (x.skip || PASSABLE.has(x.kind)) return true;
  return x.kind === '' && (Math.abs(x.size - a.size) > 0.06 * a.size || x.font !== a.font || x.text.length < 60);
}

function linkFrom(a) {
  if (a.next) return;
  const ahead = a.page.blocks.slice(a.index + 1).concat(view.pages[a.page.n]?.blocks ?? []);
  for (const b of ahead) {
    if (continues(a, b)) {
      if (!b.prev) { a.next = b; b.prev = a; }
      return;
    }
    if (!passable(b, a)) return;
  }
}

/** Work out the links for a page whose blocks were just made, including those to its neighbours. */
function linkPage(p) {
  if (view.pages[p.n - 1] !== p) return;
  const before = view.pages[p.n - 2];
  for (const q of [before, view.pages[p.n]]) {
    for (const b of q?.blocks ?? []) {
      if (b.next?.page === p) b.next = null; // pointed at blocks this page no longer has
      if (b.prev?.page === p) b.prev = null;
    }
  }
  for (const b of p.blocks) linkFrom(b);
  for (const b of before?.blocks ?? []) if (!b.next) linkFrom(b);
}

const headOf = (b) => { while (b.prev) b = b.prev; return b; };
const tailOf = (b) => { while (b.next) b = b.next; return b; };
/** Every block of the paragraph a block belongs to, first to last. */
const partsOf = (b) => { const out = []; for (b = headOf(b); b; b = b.next) out.push(b); return out; };
const sameParagraph = (a, b) => !!a && !!b && headOf(a) === headOf(b);
/** Whether a block's paragraph goes on in its next block in the middle of a sentence, cut by a column or page break. */
const carriesOn = (b) => !!b?.next && !SENTENCE_OVER.test(b.text.trimEnd());
/** Put text back together across a break, mending a word the break hyphenated. */
const glue = (texts) => texts.reduce((a, b) => (HYPHEN_END.test(a) && /^\p{Ll}/u.test(b) ? a.slice(0, -1) + b : `${a} ${b}`));
const paragraphText = (b) => glue(partsOf(b).map((x) => x.text.trim()));

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
const ABBREV = /(?:\b(?:et al|e\.g|i\.e|vs|cf|Figs?|Eqs?|Secs?|Refs?|Dr|Mrs?|Ms|Prof|St|Jr|Sr|approx|ca|pp?|Vol|Ch)|\b\p{Lu})\.\s*$/u;
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

/** How many brackets a piece of text opens and leaves open. */
function unclosed(text) {
  let depth = 0;
  for (const ch of text) {
    if (ch === '(' || ch === '[') depth++;
    else if ((ch === ')' || ch === ']') && depth > 0) depth--;
  }
  return depth;
}

/** Whether the break between two pieces the segmenter cut apart is not the end of a sentence. `ahead` is the text from the break on. */
function falseStop(before, after, ahead) {
  return ABBREV.test(before)                                    // "see Fig. | 2", "Smith et al. | 2020"
    || (/\bNo\.\s*$/.test(before) && /^\s*\d/.test(after))        // "No. | 5", but "No. | Maybe so."
    || (unclosed(before) > 0 && /[)\]]/.test(ahead))               // a full stop inside brackets: "(p. | 5)"
    || !/\p{L}/u.test(before) || !/[\p{L}\p{N}]/u.test(after)   // nothing to say on one side: "1. | Introduction", "… | )."
    || /^[\s"'“‘(\[]*\p{Ll}+(?![\p{Lu}\p{N}\p{Ll}])/u.test(after); // carries on in lower case: "approx. | five" (but not "mRNA")
}

/** Split a block into its sentences, the pieces the voice speaks one after another; a very long one is cut at a clause. */
function chunkBlock(block) {
  if (block.chunks) return block.chunks;
  const t = block.text;
  const parts = [];
  if (segmenter) {
    for (const s of segmenter.segment(t)) {
      // It takes a lower-case letter to mean the sentence carries on, which "mRNA" and "pH" get past.
      let from = 0;
      for (const m of s.segment.matchAll(/[.!?]["'”’)\]]*\s+(?=\p{Ll}{1,2}\p{Lu})/gu)) {
        parts.push([s.index + from, s.index + m.index + m[0].length]);
        from = m.index + m[0].length;
      }
      parts.push([s.index + from, s.index + s.segment.length]);
    }
  } else {
    const re = /[^.!?]+(?:[.!?]+["'”’)\]]*\s*|$)/g;
    let m;
    while ((m = re.exec(t)) && m[0]) parts.push([m.index, m.index + m[0].length]);
  }
  // The segmenter stops at every full stop that could end a sentence. Undo the stops that don't.
  const merged = [];
  for (const p of parts) {
    const last = merged[merged.length - 1];
    if (last && falseStop(t.slice(last[0], last[1]), t.slice(p[0], p[1]), t.slice(p[0], p[0] + MAX_CHUNK))) last[1] = p[1];
    else merged.push([p[0], p[1]]);
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

// ── Document view ───────────────────────────────────────────────────────────

const view = { doc: null, task: null, pages: [], token: 0, bytes: null, name: '' };
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
  const blocksEl = document.createElement('div');
  blocksEl.className = 'layer';
  el.append(canvas, hl, blocksEl);
  return {
    n, el, canvas, hl, blocksEl, w, h, vt: null, proxyP: null, blocksP: null, blocks: null, lines: null,
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

/**
 * Split a group of lines where the text jumps to another part of the page: the next column, the
 * far side of a figure, a header and a footer filed together. One box around such a group would
 * cover everything in between (at worst the whole page), so each stretch gets its own.
 */
function regions(lines) {
  const out = [];
  for (const ln of lines) {
    const apart = (r) => ln.x0 > r.x1 + ln.size || ln.x1 < r.x0 - ln.size
      || ln.bottom < r.top - 2 * ln.size || ln.top > r.bottom + 5 * ln.size;
    // Usually the stretch being built; after a stray fragment (an equation number, say), the one before it.
    let r = out.findLast((x) => !apart(x));
    if (!r) out.push(r = { lines: [], x0: ln.x0, x1: ln.x1, top: ln.top, bottom: ln.bottom });
    r.lines.push(ln);
    r.x0 = Math.min(r.x0, ln.x0); r.x1 = Math.max(r.x1, ln.x1);
    r.top = Math.min(r.top, ln.top); r.bottom = Math.max(r.bottom, ln.bottom);
  }
  return out.map((r) => r.lines);
}

/** Make a page's clickable paragraphs from groups of its lines: [{ lines, kind }] in reading order. */
function setBlocks(p, groups) {
  const blocks = [];
  for (const g of groups) {
    let before = null; // the previous stretch of the same paragraph
    for (const lines of regions(g.lines)) {
      const b = buildBlock(lines);
      if (!b) continue;
      // Stretches of one paragraph stay one paragraph: selected and read together.
      if (before && g.kind !== 'skip') { before.next = b; b.prev = before; }
      before = b;
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
  }
  p.blocksEl.replaceChildren(...blocks.map((b) => b.el));
  p.blocks = blocks;
  linkPage(p);
}

/** Replace a page's guessed paragraphs with Claude's: { blocks: [{ kind, lines: [line id] }] }. */
function applyLayout(p, layout) {
  p.tr = null; // the new paragraphs have no translation yet
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
  if (chat.block && partsOf(chat.block).some((b) => b.page === p)) return true;
  if (speaker.recent && partsOf(speaker.recent).some((b) => b.page === p)) return true;
  return !!s && (speaker.active?.page === p || s.lastBlock.page === p
    || s.segs.some((x) => x.block.page === p || x.chunk.join?.some((j) => j.block.page === p)));
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

/**
 * Whether a block is a heading. Claude says so where it has laid the page out; otherwise it is
 * a guess: a short line that doesn't end like a sentence, and is larger than the page's body
 * text, numbered like a section, or in capitals.
 */
function isHeading(b) {
  if (b.kind) return b.kind === 'heading';
  const text = b.text.trim();
  if (text.length > 140 || text.length < 3 || /[.,;:]$/.test(text)) return false;
  const p = b.page;
  if (p.bodySizeFor !== p.blocks) {
    // The size most of the page's text is set in.
    const sizes = new Map();
    for (const x of p.blocks) sizes.set(half(x.size), (sizes.get(half(x.size)) || 0) + x.text.length);
    p.bodySize = [...sizes].reduce((a, c) => (c[1] > a[1] ? c : a), [b.size, 0])[0];
    p.bodySizeFor = p.blocks;
  }
  return b.size > p.bodySize * 1.12 || /^(?:\d+(?:\.\d+)*\.?|[IVXLC]+\.)\s+\p{Lu}/u.test(text) || (text.length > 5 && !/\p{Ll}/u.test(text) && /\p{Lu}/u.test(text));
}

/** The nearest heading in a direction, looking no further than a few hundred paragraphs. */
async function nextHeading(block, dir) {
  let b = block;
  for (let i = 0; i < 400; i++) {
    b = await nextReadable(b, dir);
    if (!b || isHeading(b)) return b;
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
    } else {
      if (settings.ai) startClaude().then(() => pages.filter((p) => p.near).forEach((p) => narration.request(p)));
      // Reading in another language: have the document translated before it is listened to.
      if (settings.lang) aiReady.then(() => { if (token === view.token) translation.all(); });
    }
    for (const p of pages) {
      if (token !== view.token) return;
      try { await getProxy(p); } catch { return; }
    }
  })();
}

function closeDoc() {
  speaker.recent = null;
  sentencePick.hide();
  nearObserver.disconnect();
  for (const p of view.pages) p.renderTask?.cancel();
  view.pages = [];
  view.doc = null;
  view.bytes = null;
  view.task?.destroy();
  view.task = null;
  narration.reset();
  translation.ahead = null;
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

/**
 * Send the open document to Claude, if that hasn't happened yet. Resolves when Claude can take
 * requests: after sending it the first time, at once after that, even while it is still on its
 * way (requests wait for it themselves, and answers kept in this browser don't need it).
 */
async function startClaude() {
  await aiReady;
  if (!view.doc || !ai.available) return false;
  if (ai.doc && ai.doc.state !== 'error') return true;
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
    translation.prepare();
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

// ── Claude: translating for reading aloud ───────────────────────────────────

/**
 * Translations live on the sentences themselves (`chunk.tr[lang]`); a sentence keeps the first one
 * it gets. A page is translated in one request, ahead of the voice; the paragraph about to be
 * spoken is also asked for on its own, since that request is small and need not wait for the
 * glossary that page requests use. Both stream, so speech starts with the first sentence in.
 * Meanwhile the whole document is translated in the background (`all`), and everything Claude
 * says is kept in this browser, so a document opened again is in that language at once.
 */
const AHEAD_PAGES = 60;   // pages translated in the background from the one being read: all of most papers
const AHEAD_AT_ONCE = 2;  // pages translated at a time, leaving Claude room for the paragraph being read
const STOP_AHEAD = new Set(['limit', 'auth', 'no_key', 'no_sdk', 'too_long', 'too_large']); // errors that more pages would only repeat

const translation = {
  /** The background translation under way: { lang, token, done, failed, total, started }, or null. */
  ahead: null,

  /**
   * Get ready to read in the language chosen: translate the document in the background, and have
   * its glossary worked out now, while nothing waits on it, so that even the first paragraph read
   * keeps to the same wording.
   */
  prepare() {
    this.all();
    const lang = targetLang();
    if (!lang || !usingClaude()) return;
    ai.glossary({ lang, language: languageName(lang), english: englishFor(lang) }).catch((e) => console.warn('Claude could not settle the wording', e));
  },

  /**
   * Translate the document into the language being read in, ahead of the voice: from the page
   * being read (or looked at) to the end, then the pages before it, a couple at a time. Pages done
   * already are passed straight over, so this can be called whenever reading starts. Choosing
   * "As written" or another language, or opening another document, stops it.
   */
  all() {
    const lang = targetLang(), token = view.token, run = this.ahead;
    if (run && run.lang === lang && run.token === token) return; // under way already
    this.ahead = null;
    // No system voice for the language yet (the browser may still be listing them): it isn't known which variety to translate into.
    if (!lang || (usesSysVoice() && !sysVoice()) || !ai.available || !view.pages.length) { renderChip(); return; }
    const from = (speaker.active?.page ?? anchor?.p ?? view.pages[0]).n - 1;
    const todo = [...view.pages.slice(from), ...view.pages.slice(0, from)].slice(0, AHEAD_PAGES);
    const mine = this.ahead = { lang, token, done: 0, failed: 0, total: todo.length, started: Date.now() };
    const live = () => this.ahead === mine && view.token === token;
    const work = async () => {
      while (live() && todo.length) {
        const p = todo.shift();
        let error = await this.page(p, lang);
        // Too many requests at once: give Claude a little while, then try the page again.
        for (let wait = 15e3; error?.code === 'rate_limit' && wait <= 60e3 && live(); wait *= 2) {
          await new Promise((r) => setTimeout(r, wait));
          if (live()) error = await this.page(p, lang);
        }
        if (!live()) return;
        if (error && (STOP_AHEAD.has(error.code) || ai.doc?.state === 'error')) { this.ahead = null; renderChip(); return; }
        mine.done++;
        if (error) mine.failed++; // left to be translated as it is read
        renderChip();
      }
    };
    renderChip();
    Promise.all(Array.from({ length: AHEAD_AT_ONCE }, work)).then(() => {
      if (!live()) return;
      this.ahead = null;
      renderChip();
      // Said only when it took a while: a document translated before is ready at once.
      if (Date.now() - mine.started < 5000) return;
      const what = mine.total === view.pages.length ? 'The whole document is' : `${mine.total} pages are`;
      toast(mine.failed ? `${mine.failed} of ${mine.total} pages couldn’t be translated ahead; they will be as they are read.`
        : `${what} translated into ${languageName(lang)}.`, 3500);
    });
  },

  /**
   * What to send for some blocks: their sentences not yet translated, as `pieces` ([{ id, text }]),
   * and `where`, the sentence of each id. A sentence cut in two by a column or page break is sent
   * whole, both halves in the request that has its first half, so the two fit together; a half
   * from another page has an id that names it ('13:0.0'). With `owned`, a block's first sentence
   * is left to the request for the block before it, when that one isn't here and still needs its
   * half. (A request for one block always sends all of it, so whatever is waited for gets asked.)
   */
  plan(blocks, lang, page, owned = false) {
    const pieces = [], where = new Map(), sent = new Set(), here = new Set(blocks);
    const has = (c) => c?.tr?.[lang] != null;
    const last = (b) => chunkBlock(b).at(-1);
    const add = (b, i) => {
      const c = chunkBlock(b)[i];
      // A sentence already asked for by someone waiting to hear it comes from that request.
      if (!c || has(c) || sent.has(c) || (!owned && c.asked?.[lang]?.urgent)) return;
      const id = `${b.page.n === page ? '' : `${b.page.n}:`}${b.index}.${i}`;
      where.set(id, c);
      sent.add(c);
      pieces.push({ id, text: markedText(b, c.start, c.end) });
    };
    for (const b of blocks) {
      const theirs = owned && carriesOn(b.prev) && !here.has(b.prev) && last(b.prev) && !has(last(b.prev));
      for (let i = theirs ? 1 : 0; i < chunkBlock(b).length; i++) add(b, i);
      if (carriesOn(b) && !here.has(b.next) && sent.has(last(b))) add(b.next, 0);
    }
    return { pieces, where };
  },

  /** Put one of Claude's lines on its sentence, unless that has a translation already, and let speech waiting for it go on. */
  apply(where, { id, say }, lang) {
    const c = where.get(id);
    if (!c || typeof say !== 'string' || c.tr?.[lang] != null) return;
    (c.tr ??= {})[lang] = say;
    speaker.translated(lang);
  },

  /** Ask Claude for what some blocks still need, putting each line in place as it comes. → the sentences it didn't bring */
  async fetch(page, blocks, lang, urgent) {
    const token = view.token;
    const { pieces, where } = this.plan(blocks, lang, page, !urgent);
    if (!pieces.length) return [];
    const mark = { urgent }; // on each sentence while this request is out for it (an urgent request's mark stays)
    for (const c of where.values()) if (!c.asked?.[lang]?.urgent) (c.asked ??= {})[lang] = mark;
    try {
      await ai.translate({
        page, pieces, lang, language: languageName(lang), english: englishFor(lang), urgent,
        onLine: (line) => { if (token === view.token) this.apply(where, line, lang); },
      });
    } finally {
      for (const c of where.values()) if (c.asked[lang] === mark) delete c.asked[lang];
      speaker.translated(lang); // speech waiting on a sentence this didn't bring can ask for it now
    }
    return [...where.values()].filter((c) => c.tr?.[lang] == null);
  },

  /**
   * Translate a whole page. Resolves when it has been tried: to nothing, or to why it failed.
   * Sentences it missed are left for `block`.
   */
  page(p, lang) {
    p.tr ??= {};
    return p.tr[lang] ??= (async () => {
      const token = view.token, mine = p.tr;
      try {
        if (!(await startClaude())) throw ai.doc?.error || new AiError(ai.available ? 'api' : ai.reason);
        await narration.request(p); // so the paragraphs are Claude's before they are translated
        const blocks = await ensureBlocks(p);
        if (token !== view.token) return null;
        // Claude regrouped the page's paragraphs meanwhile, which set this request aside: translate the new ones.
        if (p.tr !== mine) return this.page(p, lang);
        await this.fetch(p.n, blocks.filter((b) => !b.skip), lang, false);
        return null;
      } catch (e) {
        console.warn('Claude could not translate page', p.n, e);
        if (p.tr === mine) p.tr[lang] = null; // allow another try later
        return e;
      }
    })();
  },

  /** Translate one block for certain: resolves once every sentence of it has its translation, or rejects. */
  block(block, lang) {
    const done = () => chunkBlock(block).every((c) => c.tr?.[lang] != null);
    if (done()) return Promise.resolve();
    block.trWait ??= {};
    return block.trWait[lang] ??= (async () => {
      const token = view.token, whole = this.page(block.page, lang);
      const alone = (async () => {
        if (!(await startClaude())) throw ai.doc?.error || new AiError(ai.available ? 'api' : ai.reason);
        const missed = await this.fetch(block.page.n, [block], lang, true);
        // Claude was asked twice for these and left them out: say nothing for them rather than stall.
        if (token === view.token) for (const c of missed) { console.warn('Claude left a sentence untranslated:', c.raw); (c.tr ??= {})[lang] ??= ''; }
      })();
      // Whichever brings this block first; a failure counts only if neither does.
      const error = await Promise.race([
        whole.then(() => (done() ? null : alone.then(() => null, (e) => e))),
        alone.then(() => null, (e) => whole.then(() => (done() ? null : e))),
      ]);
      block.trWait[lang] = null;
      if (error) throw error;
    })();
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

/** The neural voice for another language (see piper.js): loaded when first needed, one language at a time. */
const neural = {
  tts: null,
  spec: null, // the voice last asked for; `key` is the engine it runs on, which other voices may share
  key: '',
  state: 'idle', // idle | loading | ready | error
  pct: 0,
  everReady: false,
  job: null,

  load(spec = neuralFor()) {
    if (!spec) return null;
    const key = engineKey(spec);
    this.spec = spec;
    if (this.job && this.key === key && this.state !== 'error') return this.job;
    Object.assign(this, { key, state: 'loading', pct: 0, everReady: false });
    renderPlayer();
    const job = this.job = (async () => {
      try {
        const tts = await loadNeural(spec, {
          onProgress: ({ loaded, total }) => { if (this.job === job && total) { this.pct = Math.min(99, Math.floor(100 * loaded / total)); renderPlayer(); } },
        });
        if (this.job !== job) { tts.dispose(); return; }
        this.tts?.dispose();
        this.tts = tts;
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

  /** Speak one piece of text in one of the loaded engine's voices, at the chosen speed. → { pcm, rate } */
  async synth(text, spec, signal) {
    const tts = this.tts;
    const pcm = await tts.synth(text, spec, { signal, speed: settings.speed });
    return { pcm: timeStretch(pcm, settings.speed / tts.pace(settings.speed), tts.sampleRate), rate: tts.sampleRate };
  },
};
/** Whichever of the reader's own engines speaks now, or would for a session. */
const engineFor = (s = null) => ((s ? s.neural : neuralFor()) ? neural : voice);

// ── Speech ──────────────────────────────────────────────────────────────────

const segsFor = (block) => chunkBlock(block).map((chunk) => ({ block, chunk, gap: 0 }));
const spoken = (chunk) => (chunk.explain ? chunk.say
  : settings.lang ? (chunk.join ?? [{ chunk }]).map((j) => j.chunk.tr?.[targetLang()] || '').filter(Boolean).join(' ')
  : chunk.join ? glue(chunk.join.map((j) => spoken(j.chunk)))
  : (settings.ai && chunk.aiSay) || chunk.say);
/** What a session's voice is given for a sentence: in another language, with the last touches figures and links need. */
const voiced = (s, chunk) => (s.lang ? speakable(spoken(chunk), s.lang) : spoken(chunk));

/**
 * What to voice for a paragraph, from one of its blocks to its last. Where it crosses to the
 * next column or page, the two halves of the sentence cut by the break become one piece
 * (`chunk.join` lists the halves), so the voice doesn't stop mid-sentence.
 */
function paragraphSegs(first) {
  const segs = [];
  for (let b = first; b; b = b.next) {
    const mine = segsFor(b);
    const last = segs[segs.length - 1];
    // The halves are one sentence only if the part before the break didn't finish its own.
    if (last && mine.length && carriesOn(b.prev)) {
      const join = [...(last.chunk.join ?? [{ block: last.block, chunk: last.chunk }]), { block: b, chunk: mine[0].chunk }];
      if (join.reduce((n, j) => n + j.chunk.end - j.chunk.start, 0) <= MAX_CHUNK * 1.2) {
        last.chunk = {
          join, start: join[0].chunk.start, end: join[0].chunk.end,
          raw: glue(join.map((j) => j.chunk.raw)), say: glue(join.map((j) => j.chunk.say)),
          notation: join.some((j) => j.chunk.notation),
        };
        mine.shift();
      }
    }
    segs.push(...mine);
  }
  return segs;
}
const BUFFER_AHEAD = 25;   // seconds of audio to keep ready beyond the playhead
const TRANSLATION_MARGIN = 8; // seconds of audio left before a sentence its page's request hasn't brought yet is asked for on its own

/** Where the first sentence in a growing piece of text ends, or 0 if it hasn't yet. */
function sentenceEnd(buf) {
  const re = /[.!?]["'”’)\]]*\s+|[。！？]+\s*/g;
  let m;
  while ((m = re.exec(buf))) if (m.index + m[0].length >= (/[。！？]/.test(m[0]) ? 12 : 40)) return m.index + m[0].length;
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
  start(block, mode, turn = null, from = null) {
    block = headOf(block); // a paragraph is read from its start, whichever part of it was picked
    this.halt();
    this.ensureCtx();
    if (usesSysVoice() && !sysVoice()) {
      const missing = languageName(settings.lang);
      setLang('');
      toast(`This browser has no ${missing} voice, so the text is read as written.`, 6000);
    }
    const s = this.session = {
      id: ++this.seq, mode, turn, segs: [], next: 0, sched: [], nextTime: 0, cur: -1,
      // `lang`: the language Claude translates into, if any. `sys`: a system voice speaks, one sentence at a time.
      // `neural`: the reader's neural voice for that language speaks.
      lang: targetLang(), sys: usesSysVoice(), neural: neuralFor(),
      // A reply is a one-off: it never carries on to the next paragraph.
      busy: false, paused: false, extending: false, exhausted: !!turn, streaming: false, streamBlock: null,
      lastBlock: mode === 'explain' ? block : tailOf(block), waitPage: null, trWait: null,
      // A double-click starts as a single click; holding audio back briefly lets it change its mind unheard.
      notBefore: this.ctx.currentTime + 0.25,
      synthAbort: new AbortController(), aiAbort: new AbortController(),
    };
    setActive(block, null, false, mode);
    if (mode === 'explain') {
      this.streamReply(s, block);
    } else {
      s.segs = paragraphSegs(block);
      // Asked to begin at one sentence (`from` is its piece of the text): drop the ones before it.
      if (from) s.segs = s.segs.slice(Math.max(0, s.segs.findIndex((seg) => holds(seg, from))));
      if (settings.scope === 'sentence') s.segs.length = Math.min(1, s.segs.length);
      for (const b of partsOf(block).reverse()) narration.request(b.page, true);
      if (s.lang) {
        for (const b of partsOf(block)) translation.page(b.page, s.lang);
        translation.all(); // from here on, if it isn't under way already
      }
    }
    if (s.neural) neural.load(s.neural); else if (voice.state === 'error' && !s.sys) voice.load();
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


  /**
   * A click on a sentence of the paragraph being read reads from that sentence again; elsewhere in
   * that paragraph it pauses or resumes; on any other paragraph, it reads that one.
   */
  toggleBlock(block) {
    const picked = sentencePick.seg;
    if (picked && holdsBlock(picked, block)) this.start(block, 'read', null, picked.chunk.join?.[0].chunk ?? picked.chunk);
    else if (this.session && sameParagraph(this.active, block)) this.toggle();
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
    if (s.sys) { if (s.paused) synth.pause(); else synth.resume(); }
    renderPlayer();
  },

  /**
   * Move on (or back) by whatever is being read at a time: a sentence, a paragraph, or to the next
   * heading. Works from the paragraph being read or the one left selected when reading stopped.
   */
  async skip(dir) {
    const here = () => this.active ?? this.recent;
    const from = here();
    if (!from) return;
    const scope = this.session?.mode === 'explain' ? 'paragraph' : settings.scope; // from a reply, this goes back to reading
    const firstOf = (seg) => seg.chunk.join?.[0].chunk ?? seg.chunk;
    const outward = () => nextReadable(dir > 0 ? tailOf(from) : headOf(from), dir);
    let to = null, sentence = null;
    if (scope === 'sentence') {
      const segs = paragraphSegs(headOf(from));
      const at = this.at && sameParagraph(this.at.block, from) ? segs.findIndex((seg) => holds(seg, firstOf(this.at))) : -1;
      const next = segs[at + dir];
      if (at >= 0 && next) { to = headOf(from); sentence = firstOf(next); }
      else {
        to = await outward();
        if (to && dir < 0) sentence = firstOf(paragraphSegs(headOf(to)).pop()); // back into a paragraph at its last sentence
      }
    } else if (scope === 'section') {
      to = await nextHeading(dir > 0 ? tailOf(from) : headOf(from), dir);
    } else {
      to = await outward();
    }
    if (here() !== from) return;
    if (!to) { toast(`No ${dir > 0 ? 'more' : 'earlier'} ${SCOPES.find((x) => x.id === scope).unit}s.`, 2200); return; }
    this.start(to, 'read', null, sentence);
    reveal(to);
  },

  /** The amount read at a time changed: let the session run on, or cut it back to what is now wanted. */
  rescope() {
    const s = this.session;
    if (!s || s.mode !== 'read') return;
    const last = s.segs[s.segs.length - 1];
    if (settings.scope !== 'sentence' && last && sameParagraph(last.block, s.lastBlock)) {
      // Reading one sentence left the rest of its paragraph out: put it back.
      const all = paragraphSegs(headOf(last.block));
      const at = all.findIndex((seg) => holds(seg, last.chunk.join?.[0].chunk ?? last.chunk));
      if (at >= 0) s.segs.push(...all.slice(at + 1));
    }
    if (readsOn()) { s.exhausted = false; this.pump(); return; }
    this.trimToActive();
    if (settings.scope !== 'sentence') return;
    // Just the sentence being spoken (or, before any is, the first).
    const now = Math.max(0, s.cur >= 0 ? s.segs.indexOf(s.sched[s.cur].seg) : 0);
    const later = (x) => s.segs.indexOf(x) > now;
    this.silence(s.sched.filter((e) => later(e.seg)));
    s.sched = s.sched.filter((e) => !later(e.seg));
    s.segs.length = Math.min(s.segs.length, now + 1);
    s.next = Math.min(s.next, s.segs.length);
    s.nextTime = s.sched.length ? s.sched[s.sched.length - 1].end : 0;
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
      const end = tailOf(block);
      await ai.explain({
        page: block.page.n, text: paragraphText(block), question: turn.question, history: chat.before(turn), signal,
        lang: s.lang, language: s.lang ? languageName(s.lang) : '',
        before: block.page.blocks?.[block.index - 1]?.text.slice(-500) || '',
        after: end.page.blocks?.[end.index + 1]?.text.slice(0, 500) || '',
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

  /** A sentence's translation came in: speech waiting for one can go on, without waiting for the rest. */
  translated(lang) {
    const s = this.session;
    if (s?.lang === lang && s.waitPage) this.pump();
  },

  /** Voice the next sentence, unless enough audio is already queued or something it needs isn't ready. */
  pump() {
    const s = this.session;
    if (!s || s.busy || (!s.sys && engineFor(s).state !== 'ready')) return;
    const ahead = s.sched.length ? s.nextTime - this.ctx.currentTime : 0;
    if (s.next >= s.segs.length) {
      if (s.streaming || s.extending || s.exhausted || !readsOn()) return;
      if (ahead > BUFFER_AHEAD) return;
      this.extend(s);
      return;
    }
    if (ahead > BUFFER_AHEAD) return;
    const idx = s.next, id = s.id, seg = s.segs[idx];
    if (s.lang && !seg.chunk.explain) {
      // Nothing is said until Claude's translation of it is in. `waitPage` shows that, and has
      // each translation as it arrives call this again; `trWait` is the block asked for.
      const missing = (seg.chunk.join ?? [seg]).find((j) => j.chunk.tr?.[s.lang] == null);
      if (missing) {
        const b = missing.block, asked = missing.chunk.asked?.[s.lang];
        if (s.waitPage !== b) { s.waitPage = b; renderPlayer(); }
        // A sentence already on its way is waited for rather than paid for twice: always when it
        // comes with the paragraph being read, and from its page's request while enough audio is
        // queued to cover asking for it on its own if that runs late.
        if (s.trWait !== b && !(asked && (asked.urgent || ahead > TRANSLATION_MARGIN))) {
          s.trWait = b;
          const mine = () => this.session === s && s.id === id && s.trWait === b;
          translation.block(b, s.lang).then(
            () => { if (mine()) { s.trWait = null; this.pump(); } },
            (e) => { if (mine()) { this.stop(); toast(`Couldn’t translate this passage. ${e.message || ''}`, 6000); } },
          );
        }
        return;
      }
      if (s.waitPage) { s.waitPage = null; renderPlayer(); }
      if (!spoken(seg.chunk)) { s.next = idx + 1; this.pump(); return; } // a page number, a stray label
    }
    const block = (seg.chunk.join?.map((j) => j.block) ?? [seg.block]).find((b) => !narration.settled(b));
    if (!s.lang && seg.chunk.notation && usingClaude() && block) {
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
    if (s.sys) { this.say(s, idx); return; }
    const signal = s.synthAbort.signal;
    const text = voiced(s, seg.chunk), engine = engineFor(s);
    (s.neural ? neural.synth(text, s.neural, signal) : voice.synth(text, settings.voice, signal)).then(
      (audio) => {
        if (this.session !== s || s.id !== id) return;
        s.busy = false;
        this.onAudio(s, idx, audio);
      },
      (e) => {
        if (this.session !== s || s.id !== id) return;
        s.busy = false;
        if (signal.aborted || engine.state !== 'ready') return; // interrupted, not failed: it will be asked again
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
    if (!b || (settings.scope === 'section' && isHeading(b))) { s.exhausted = true; return; } // the next heading ends a section
    s.lastBlock = tailOf(b);
    const segs = paragraphSegs(b);
    segs[0].gap = 0.35; // a breath between paragraphs
    s.segs.push(...segs);
    if (s.lang) for (const part of partsOf(b)) translation.page(part.page, s.lang);
    this.pump();
  },

  /**
   * Speak one sentence with a system voice. These play themselves and can't be queued against
   * the audio clock, so each gets a place in `sched` that is simply current until it has ended.
   */
  say(s, idx) {
    const seg = s.segs[idx], id = s.id, v = sysVoice();
    const u = s.utterance = new SpeechSynthesisUtterance(voiced(s, seg.chunk)); // held, or its events can be lost
    if (v) u.voice = v;
    u.lang = v ? v.lang : s.lang;
    u.rate = settings.speed;
    const entry = { start: 0, end: Infinity, seg, src: null, times: null };
    const live = () => this.session === s && s.id === id;
    u.onstart = () => { if (live() && !s.sched.includes(entry)) { s.sched.push(entry); this.tick(); } };
    u.onend = u.onerror = () => {
      if (!live() || entry.end === 0) return;
      if (!s.sched.includes(entry)) s.sched.push(entry);
      entry.end = 0;
      s.busy = false;
      s.next = idx + 1;
      this.pump();
    };
    synth.speak(u);
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
      const words = seg.chunk.start == null || s.lang ? [] : chunkWords(seg.block, seg.chunk); // translated words aren't the page's
      const times = words.length ? wordTimes(words.map((w) => w.part), pcm, rate) : null;
      s.sched.push({ start, end: start + buf.duration, seg, src, times });
      s.nextTime = start + buf.duration;
      this.last = { seconds: buf.duration, text: spoken(seg.chunk) };
    }
    this.pump();
  },

  /** Runs every frame (a few times a second in a hidden tab): moves the highlight, tops up the buffer, notices the end. */
  tick() {
    const s = this.session;
    if (!s || !this.ctx) return;
    // What is heard now left the context a little earlier: noticeably so over Bluetooth.
    const t = this.ctx.currentTime - (this.ctx.outputLatency || 0);
    let cur = -1;
    for (let i = s.sched.length - 1; i >= 0; i--) {
      const e = s.sched[i];
      if (cur < 0 && t >= e.start - 0.03) cur = i;
      if (e.src && e.end < t - 1) { e.src.disconnect(); e.src = null; }
    }
    if (cur !== s.cur) {
      s.cur = cur;
      if (cur >= 0) setActive(s.sched[cur].seg.block, s.sched[cur].seg.chunk, true, s.mode);
      if (cur >= 0) sentenceMark.show(s.sched[cur].seg);
      if (cur >= 0 && s.mode === 'read') this.at = s.sched[cur].seg; // where the arrow keys move on from
      renderPlayer();
    }
    if (cur >= 0) wordMark.follow(s.sched[cur], t);
    const drained = s.next >= s.segs.length && !s.busy && !s.streaming && !s.extending && (!readsOn() || s.exhausted);
    if (drained && (!s.sched.length || t > s.sched[s.sched.length - 1].end + 0.12)) { this.stop(s.mode === 'read' && settings.scope !== 'document'); return; } // with nothing coming next, the paragraph stays selected
    this.pump();
  },

  /** Voice, speed or Claude setting changed: voice again from the sentence being spoken. */
  restart() {
    const s = this.session;
    if (!s) return;
    const from = s.cur >= 0 ? Math.max(0, s.segs.indexOf(s.sched[s.cur].seg)) : 0;
    this.silence(s.sched);
    s.synthAbort.abort();
    const wasSys = s.sys;
    Object.assign(s, {
      id: ++this.seq, segs: s.segs.slice(from), next: 0, sched: [], nextTime: 0, cur: -1,
      busy: false, notBefore: 0, waitPage: null, synthAbort: new AbortController(),
      lang: targetLang(), sys: usesSysVoice(), neural: neuralFor(),
    });
    if (s.neural) neural.load(s.neural);
    hush();
    if (s.paused && (s.sys || wasSys)) { s.paused = false; this.ctx.resume(); } // a system voice, once cut off, can't stay paused
    setActive(this.active, null, false, s.mode);
    renderPlayer();
    this.pump();
  },

  /** No longer reading on: finish the current paragraph, drop anything queued after it. */
  trimToActive() {
    const s = this.session;
    if (!s || !this.active) return;
    if (s.streaming && s.streamBlock !== this.active) {
      s.aiAbort.abort();
      s.aiAbort = new AbortController();
      s.streaming = false;
    }
    const mine = (x) => sameParagraph(x.block, this.active);
    const end = s.segs.findLastIndex(mine) + 1;
    if (end <= 0) return;
    s.segs.length = end;
    s.next = Math.min(s.next, end);
    s.lastBlock = s.mode === 'explain' ? this.active : tailOf(this.active);
    this.silence(s.sched.filter((e) => !mine(e.seg)));
    s.sched = s.sched.filter((e) => mine(e.seg));
    s.nextTime = s.sched.length ? s.sched[s.sched.length - 1].end : 0;
  },

  /** Say a short line in a voice, so it can be judged before reading with it. */
  async preview(name) {
    if (usesSysVoice()) {
      // A system voice introduces itself with the name of its language, in that language.
      const v = sysVoice();
      if (this.session || !v) return;
      this.stopPreview();
      const u = this.previewUtterance = new SpeechSynthesisUtterance(languageName(tagOf(v), tagOf(v)));
      u.voice = v;
      u.lang = v.lang;
      synth.speak(u);
      return;
    }
    const spec = neuralFor();
    if (spec) neural.load(spec);
    if (this.session || engineFor().state !== 'ready') return;
    this.ensureCtx();
    this.stopPreview();
    const mine = this.previewToken = {};
    try {
      const { pcm, rate } = await (spec ? neural.synth(languageName(spec.tag, spec.tag), spec)
        : voice.synth(`Hi, I'm ${name}. This is how I'll read to you.`, name));
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
    hush();
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

  /** End the session. With `keep`, the paragraph it ended on stays selected, so a sentence of it can be heard again. */
  stop(keep = false) {
    const last = keep ? this.active : null;
    this.halt();
    setActive(null, null);
    select(last);
    renderPlayer();
    narration.relayout();
  },
};

// ── Highlighting ────────────────────────────────────────────────────────────

/** Keep a paragraph marked once it has been read to its end (`speaker.recent`), or let go of the one that was. */
function select(block) {
  if (speaker.recent) for (const b of partsOf(speaker.recent)) b.el.classList.remove('selected');
  speaker.recent = block || null;
  if (block) for (const b of partsOf(block)) b.el.classList.add('selected');
  else sentencePick.hide();
}

function setActive(block, chunk, auto = false, mode = 'read') {
  const prev = speaker.active;
  if (prev !== block) {
    if (prev) for (const b of partsOf(prev)) b.el.classList.remove('active', 'pending', 'explain');
    speaker.active = block;
    if (block) select(null);
    if (block && auto) reveal(block);
    if (prev && block && prev.page !== block.page) narration.relayout();
  }
  // Every part of the paragraph lights up, wherever on the page (or the next) it sits.
  if (block) for (const b of partsOf(block)) {
    b.el.classList.add('active');
    b.el.classList.toggle('explain', mode === 'explain');
    b.el.classList.toggle('pending', !chunk);
  }
  if (!block || !chunk || chunk.start == null) { wordMark.hide(); sentenceMark.hide(); }
  if (prev !== block && block) sentencePick.hide();
}

// ── The word being spoken ───────────────────────────────────────────────────

const WORD_LEAD = 0.12; // seconds the mark runs ahead: its glide takes 0.09 s, and it should land as the word starts

/** A sentence's words as ranges of their block's text. A sentence cut by a column or page break has words in two blocks. */
function chunkWords(block, chunk) {
  if (chunk.words) return chunk.words;
  const words = [];
  for (const { block: b, chunk: c } of chunk.join ?? [{ block, chunk }]) {
    for (const m of b.text.slice(c.start, c.end).matchAll(/\S+/g)) {
      const part = m[0], start = c.start + m.index;
      // The mark covers the word itself, not the punctuation that trails it.
      words.push({ block: b, part, start, end: start + (part.replace(/[.,;:!?)\]"'”’]+$/, '').length || part.length) });
    }
  }
  return chunk.words = words;
}

/** Stretches of speech in a clip, as [start, end] in seconds, split wherever the voice pauses. */
function spokenPhrases(pcm, rate) {
  const FRAME = 0.01, MIN_PAUSE = 12; // frames
  const n = Math.round(rate * FRAME), frames = Math.floor(pcm.length / n), rms = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let e = 0;
    for (let i = f * n, end = i + n; i < end; i++) e += pcm[i] * pcm[i];
    rms[f] = Math.sqrt(e / n);
  }
  // Quiet is judged against the clip's own loudness, so a soft voice isn't mistaken for silence.
  const quiet = Float32Array.from(rms).sort()[Math.floor(frames * 0.9)] * 0.08;
  const out = [];
  let a = -1, gap = 0;
  for (let f = 0; f <= frames; f++) {
    if (f < frames && rms[f] > quiet) { if (a < 0) a = f; gap = 0; }
    else if (a >= 0 && (++gap >= MIN_PAUSE || f === frames)) { out.push([a * FRAME, (f - gap + 1) * FRAME]); a = -1; gap = 0; }
  }
  return out.length ? out : [[0, pcm.length / rate]];
}

const ONES = 'zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen'.split(' ');
const TENS = 'twenty thirty forty fifty sixty seventy eighty ninety'.split(' ');

/** A whole number roughly as it is said aloud: "1984" as a year, "20000" as twenty thousand. */
function sayNumber(d) {
  const n = Number(d);
  if (d.length > 15 || (d.length > 1 && d[0] === '0')) return [...d].map((c) => ONES[c]).join(' ');
  const upTo99 = (x) => (x < 20 ? ONES[x] : TENS[(x / 10 | 0) - 2] + (x % 10 ? ' ' + ONES[x % 10] : ''));
  const upTo999 = (x) => (x >= 100 ? ONES[x / 100 | 0] + ' hundred' + (x % 100 ? ' ' + upTo99(x % 100) : '') : upTo99(x));
  if (d.length === 4 && n >= 1100 && n < 2100 && n % 1000 >= 100) {
    return upTo99(n / 100 | 0) + ' ' + (n % 100 < 10 ? (n % 100 ? 'oh ' + ONES[n % 100] : 'hundred') : upTo99(n % 100));
  }
  const out = [];
  for (let rest = n, i = 0; rest > 0 || !out.length; rest = Math.floor(rest / 1000), i++) {
    const g = rest % 1000;
    if (g || !rest) out.unshift(upTo999(g) + ['', ' thousand', ' million', ' billion', ' trillion'][i]);
  }
  return out.join(' ');
}

/** How long a word takes to say, in rough units of a letter: figures and symbols count as spelt out, initials letter by letter. */
function wordWeight(part) {
  const said = part
    .replace(/(\d),(?=\d{3}\b)/g, '$1')
    .replace(/(\d+)\.(\d+)/g, (_, a, b) => `${sayNumber(a)} point ${[...b].map((c) => ONES[c]).join(' ')}`)
    .replace(/\d+/g, (d) => ` ${sayNumber(d)} `)
    .replace(/%/g, ' percent').replace(/\$/g, ' dollars').replace(/&/g, ' and ')
    .replace(/\b\p{Lu}{2,5}\b/gu, (m) => (/[AEIOU]/.test(m) && m.length > 3 ? m : [...m].join('ay ')))
    .match(/[\p{L}\p{N}]+/gu) || [];
  return said.reduce((sum, x) => sum + x.length + 0.5, 0) || 0.5;
}

/**
 * When each word of a spoken sentence starts, in seconds into its clip. The voice gives no word
 * timings, so they are worked out from the audio: its pauses are found and matched to gaps
 * between words, at punctuation where that fits how long each phrase took, and within a phrase
 * each word takes a share of the time by its spoken length, the last one drawn out a little.
 * (Measured against a speech recogniser's timings, this is off by about 0.09 s on average.)
 */
function wordTimes(parts, pcm, rate) {
  const FINAL = 4;   // extra weight on the word before a pause: voices draw it out
  const BARE = 1.2;  // cost of a 0.2 s pause where the text has no punctuation, in seconds of misfit
  const SKIP = 0.6;  // cost of taking a 0.2 s pause as falling inside a word
  const N = parts.length, ph = spokenPhrases(pcm, rate), K = ph.length;
  const cum = [0];
  for (const part of parts) cum.push(cum[cum.length - 1] + wordWeight(part));
  const per = ph.reduce((sum, [a, b]) => sum + b - a, 0) / (cum[N] + K * FINAL); // seconds per unit of weight
  // best[k][i]: the least cost of having said words 0..i-1 by the end of phrase k, with a pause there.
  const best = ph.map(() => new Float64Array(N + 1).fill(Infinity));
  const from = ph.map(() => new Array(N + 1).fill(null));
  for (let k = 0; k < K; k++) {
    const last = k === K - 1, pause = last ? 0 : ph[k + 1][0] - ph[k][1];
    for (let k0 = k - 1, dur = 0, skipped = 0; k0 >= -1; k0--) { // phrases k0+1..k said as one run of words
      dur += ph[k0 + 1][1] - ph[k0 + 1][0];
      if (k0 + 1 < k) skipped += SKIP * (ph[k0 + 2][0] - ph[k0 + 1][1]) / 0.2;
      for (let i = last ? N : 1; i <= (last ? N : N - 1); i++) {
        const edge = last ? 0
          : /[.!?:;]\W*$/.test(parts[i - 1]) ? -0.05
          : /[,)—–-]\W*$/.test(parts[i - 1]) || /^[(—–]/.test(parts[i]) ? 0.05
          : BARE * pause / 0.2;
        for (let i0 = k0 < 0 ? 0 : 1; i0 < (k0 < 0 ? 1 : i); i0++) {
          const prev = k0 < 0 ? 0 : best[k0][i0];
          const cost = prev + Math.abs(dur - (cum[i] - cum[i0] + FINAL) * per) + skipped + edge;
          if (cost < best[k][i]) { best[k][i] = cost; from[k][i] = [k0, i0]; }
        }
      }
    }
  }
  const times = new Array(N).fill(ph[0][0]);
  for (let k = K - 1, i = N; k >= 0 && from[k][i];) {
    const [k0, i0] = from[k][i];
    const span = ph.slice(k0 + 1, k + 1), dur = span.reduce((sum, [a, b]) => sum + b - a, 0);
    for (let j = i0; j < i; j++) {
      let at = (cum[j] - cum[i0]) / (cum[i] - cum[i0] + FINAL) * dur;
      for (const [a, b] of span) { if (at <= b - a + 1e-9) { times[j] = a + at; break; } at -= b - a; }
    }
    k = k0; i = i0;
  }
  return times;
}

/** The stronger highlight: a small box on the word being spoken, moving through the paragraph. */
const wordMark = {
  el: Object.assign(document.createElement('div'), { className: 'word' }),
  word: null,

  follow(entry, t) {
    const { block, chunk } = entry.seg;
    if (!entry.times) return;
    const words = chunkWords(block, chunk);
    const at = t + WORD_LEAD - entry.start;
    let i = words.length - 1;
    while (i > 0 && entry.times[i] > at) i--;
    const w = words[i];
    const p = w.block.page;
    if (w === this.word && this.el.parentNode === p.hl) return;
    const r = chunkRects(w.block, w)[0];
    if (!r) return;
    this.word = w;
    // The sentence has crossed into the paragraph's next part: bring that into view.
    if (w.block !== speaker.active && speaker.session) setActive(w.block, chunk, true, speaker.session.mode);
    const fresh = this.el.parentNode !== p.hl || !this.el.classList.contains('on');
    if (fresh) { this.el.classList.add('jump'); p.hl.append(this.el); }
    const padX = w.block.size * 0.14, padY = w.block.size * 0.08;
    place(this.el, r.x0 - padX, r.top - padY, r.x1 + padX, r.bottom + padY, p);
    if (fresh) { this.el.getBoundingClientRect(); this.el.classList.remove('jump'); } // appear in place, then glide
    this.el.classList.add('on');
  },

  hide() {
    this.word = null;
    this.el.classList.remove('on');
  },
};

/**
 * In another language the words heard aren't the words on the page, so the mark covers the
 * whole sentence being spoken instead: one box for each line it runs over.
 */
/**
 * The outline of some lines of text as one shape: each line's box, joined to the next where they
 * meet so that no edge is drawn twice, with the corners rounded. → an SVG path
 */
function outlinePath(rects, radius) {
  // Down the right-hand side, then back up the left: the boundary between two lines is one shared height.
  const right = [], left = [];
  rects.forEach((r, i) => {
    const top = i ? (rects[i - 1].bottom + r.top) / 2 : r.top;
    const bottom = i < rects.length - 1 ? (r.bottom + rects[i + 1].top) / 2 : r.bottom;
    right.push([r.x1, top], [r.x1, bottom]);
    left.unshift([r.x0, bottom], [r.x0, top]);
  });
  const pts = [...right, ...left]
    .filter((p, i, all) => { const q = all[(i + all.length - 1) % all.length]; return Math.abs(p[0] - q[0]) > 0.01 || Math.abs(p[1] - q[1]) > 0.01; });
  let d = '';
  pts.forEach((p, i) => {
    const a = pts[(i + pts.length - 1) % pts.length], b = pts[(i + 1) % pts.length];
    const la = Math.hypot(p[0] - a[0], p[1] - a[1]), lb = Math.hypot(b[0] - p[0], b[1] - p[1]);
    const r = Math.min(radius, la / 2, lb / 2);
    const from = [p[0] + (a[0] - p[0]) * r / la, p[1] + (a[1] - p[1]) * r / la], to = [p[0] + (b[0] - p[0]) * r / lb, p[1] + (b[1] - p[1]) * r / lb];
    d += `${i ? 'L' : 'M'}${from.map((v) => v.toFixed(2))} Q${p.map((v) => v.toFixed(2))} ${to.map((v) => v.toFixed(2))} `;
  });
  return d + 'Z';
}

/** Draw a box round a sentence being voiced, on each page it touches. `kind` is its class. → the elements, to remove later */
function sentenceBoxes(seg, kind) {
  const byPage = new Map();
  for (const { block, chunk } of seg.chunk.join ?? [seg]) {
    // The words only: the space after a sentence is left outside, so two neighbouring boxes don't overlap.
    const text = block.text.slice(chunk.start, chunk.end);
    const range = { start: chunk.start + text.length - text.trimStart().length, end: chunk.start + text.trimEnd().length };
    const padX = block.size * 0.09, padY = block.size * 0.06;
    let group = null; // lines that follow on from one another; a new column starts a new shape
    for (const r of chunkRects(block, range)) {
      const box = { x0: r.x0 - padX, x1: r.x1 + padX, top: r.top - padY, bottom: r.bottom + padY };
      const prev = group?.[group.length - 1];
      if (prev && box.top >= prev.top && box.top - prev.bottom < block.size && box.x0 < prev.x1 && box.x1 > prev.x0) group.push(box);
      else {
        group = [box];
        if (!byPage.has(block.page)) byPage.set(block.page, []);
        byPage.get(block.page).push({ group, radius: block.size * 0.28 });
      }
    }
  }
  const NS = 'http://www.w3.org/2000/svg';
  return [...byPage].map(([page, shapes]) => {
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('class', `sbox ${kind}`);
    svg.setAttribute('viewBox', `0 0 ${page.w} ${page.h}`);
    svg.setAttribute('preserveAspectRatio', 'none');
    for (const { group, radius } of shapes) {
      const path = document.createElementNS(NS, 'path');
      path.setAttribute('d', outlinePath(group, radius));
      svg.append(path);
    }
    page.hl.append(svg);
    return svg;
  });
}

const holdsBlock = (seg, block) => (seg.chunk.join?.map((j) => j.block) ?? [seg.block]).some((b) => sameParagraph(b, block));
/** Whether a piece being voiced is, or includes, one sentence piece of a block. */
const holds = (seg, chunk) => seg.chunk === chunk || !!seg.chunk.join?.some((j) => j.chunk === chunk);

/**
 * The sentence under the pointer, outlined, while it is over the paragraph being read: a preview
 * of what a click would read again. A sentence cut by a column or page break is outlined whole.
 */
const sentencePick = {
  els: [],
  seg: null,

  /** Follow the pointer: `block` is what it is over, if anything. */
  follow(block, e) {
    // In the paragraph being read or, once it has been read to its end, the one still selected.
    // Reading a sentence at a time, any paragraph will do: the sentence is what gets picked.
    const s = speaker.session;
    const anywhere = settings.scope === 'sentence' && (!s || s.mode === 'read');
    if (!block || (!anywhere && ((s ? s.mode !== 'read' : !speaker.recent) || !sameParagraph(s ? speaker.active : speaker.recent, block)))) return this.hide();
    const box = block.page.hl.getBoundingClientRect();
    const x = (e.clientX - box.left) / box.width * block.page.w, y = (e.clientY - box.top) / box.height * block.page.h;
    // The sentence whose lines come nearest the pointer: between two lines, the gap belongs to the closer.
    let best = null, bestD = Infinity;
    for (const chunk of chunkBlock(block)) {
      for (const r of chunkRects(block, chunk)) {
        const d = Math.hypot(Math.max(r.x0 - x, 0, x - r.x1), Math.max(r.top - y, 0, y - r.bottom));
        if (d < bestD) { bestD = d; best = chunk; }
      }
    }
    if (!best || bestD > block.size) return this.hide();
    if (this.seg && holds(this.seg, best)) return;
    this.hide();
    this.seg = paragraphSegs(headOf(block)).find((seg) => holds(seg, best)) ?? null;
    if (!this.seg) return;
    this.els = sentenceBoxes(this.seg, 'pick');
  },

  hide() {
    for (const el of this.els) el.remove();
    this.els = [];
    this.seg = null;
  },
};

const sentenceMark = {
  els: [],
  seg: null,

  show(seg) {
    if (seg === this.seg) return;
    this.hide();
    if (seg.chunk.start == null) return;
    this.seg = seg;
    this.els = sentenceBoxes(seg, 'sentence');
  },

  hide() {
    for (const el of this.els) el.remove();
    this.els = [];
    this.seg = null;
  },
};

// ── Rendering the controls ──────────────────────────────────────────────────

function renderPlayer() {
  const s = speaker.session;
  const sys = s ? s.sys : usesSysVoice(); // a system voice needs none of the reader's own to be loaded
  const engine = engineFor(s);
  const loading = !sys && engine.state === 'loading' && !engine.everReady;
  const preparing = `Preparing voice… ${engine.pct}%`;
  const explaining = s?.mode === 'explain';
  let text, sub;
  if (engine.state === 'error' && !sys) {
    text = 'The voice couldn’t load';
    sub = 'The first run needs a connection to download it.';
  } else if (s) {
    const seg = s.cur >= 0 ? s.sched[s.cur].seg : null;
    text = seg ? (seg.chunk.explain ? seg.chunk.raw : spoken(seg.chunk))
      : loading ? preparing
      : explaining ? 'Claude is thinking…'
      : s.waitPage ? (s.lang ? `Claude is translating into ${languageName(s.lang)}…` : 'Claude is preparing this passage…')
      : 'Starting…';
    const page = (seg ? seg.block : speaker.active ?? s.lastBlock).page.n;
    sub = `${explaining ? (s.turn.question ? 'Answering · ' : 'Explaining · ') : ''}Page ${page}${s.paused ? ' · Paused' : ''}`;
  } else {
    text = loading ? preparing : 'Click a paragraph to listen';
    sub = loading ? `The first run downloads about ${engine === neural ? neural.spec.megabytes : 65} MB, once.` : 'Double-click one to ask Claude about it';
  }
  els.playBtn.title = s && s.cur >= 0 ? sub : `${text} — ${sub}`; // the bar has no room for words
  els.player.classList.toggle('playing', !!s && !s.paused);
  els.player.classList.toggle('waiting', !!s && !s.paused && s.cur < 0 && (sys || engine.state !== 'error'));
  els.player.classList.toggle('explaining', explaining);
  els.playBtn.setAttribute('aria-label', s && !s.paused ? 'Pause' : 'Play');
  els.retryBtn.hidden = engine.state !== 'error' || sys;
  els.stopBtn.hidden = !s;
  els.prevBtn.disabled = els.nextBtn.disabled = !s && !speaker.recent;
  const scope = SCOPES.find((x) => x.id === settings.scope);
  els.scopeBtn.textContent = scope.short;
  els.prevBtn.title = `Previous ${scope.unit} (←)`;
  els.nextBtn.title = `Next ${scope.unit} (→)`;
  els.prevBtn.setAttribute('aria-label', `Previous ${scope.unit}`);
  els.nextBtn.setAttribute('aria-label', `Next ${scope.unit}`);
  els.voiceBtn.textContent = neuralFor() ? neuralFor().name : usesSysVoice() ? (sysVoice()?.name.split(/[ (]/)[0] || 'Voice') : settings.voice.split(' ').slice(0, 2).join(' ');
  els.langBtn.setAttribute('aria-pressed', !!settings.lang);
  els.langBtn.title = settings.lang ? `Reading in ${languageName(settings.lang)}, translated by Claude` : 'Read aloud in another language';
  // The sentence box: what is being said, in the language it is said in, while reading in translation.
  const said = settings.captions && s?.mode === 'read' && s.lang && s.cur >= 0 ? s.sched[s.cur].seg : null;
  els.caption.hidden = !said;
  if (said) {
    const words = spoken(said.chunk);
    if (els.captionText.textContent !== words) els.captionText.textContent = words;
    els.captionText.lang = s.lang;
    els.captionLang.textContent = languageName(s.lang);
  }
  els.capBtn.hidden = !settings.lang;
  els.capBtn.setAttribute('aria-pressed', !!settings.captions);
  els.progress.style.height = (sys ? 100 : engine.pct) + '%';
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
  } else if (translation.ahead) {
    const { lang, done, total } = translation.ahead;
    state = 'busy'; text = `Translating ${done}/${total}`;
    title = `Claude is translating the document into ${languageName(lang)}: ${done} of ${total} pages done. You can start listening already.`;
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

function menuItem(data, title, tags, about) {
  const item = document.createElement('button');
  item.type = 'button';
  item.className = 'voice-item';
  item.setAttribute('role', 'radio');
  Object.assign(item.dataset, data);
  const name = document.createElement('b');
  name.textContent = title;
  const small = document.createElement('small');
  small.textContent = tags;
  const span = document.createElement('span');
  span.textContent = about;
  item.append(name, small, span);
  return item;
}
const menuHead = (text) => Object.assign(document.createElement('div'), { className: 'voice-group', textContent: text });

/** The voices to choose from: the reader's own or, for another language, the system's voices for it. */
function buildVoiceMenu() {
  const nodes = [];
  const own = NEURAL_VOICES[settings.lang];
  if (own) nodes.push(menuHead('The reader’s own'), ...own.map((v) => menuItem({ neural: v.id }, v.name, v.tags, `${v.about} The first use downloads about ${v.megabytes} MB.`)));
  if (own || usesSysVoice()) {
    const all = voicesFor(settings.lang);
    for (const tag of [...new Set(all.map(tagOf))].sort()) {
      nodes.push(menuHead(languageName(tag)));
      for (const v of all.filter((x) => tagOf(x) === tag)) {
        nodes.push(menuItem({ uri: v.voiceURI }, v.name.replace(/\s*\(.*\)$/, ''), v.localService ? 'On this device' : 'Online',
          v.localService ? '' : 'The text is sent to the voice’s provider to be spoken.'));
      }
    }
  } else {
    for (const group of ['American', 'British', 'Characters']) {
      nodes.push(menuHead(group));
      for (const v of VOICES.filter((x) => x.group === group)) nodes.push(menuItem({ voice: v.name }, v.name, v.tags, v.about));
    }
  }
  els.voiceMenu.replaceChildren(...nodes);
  markVoice();
}

function markVoice() {
  const uri = sysVoice()?.voiceURI, own = neuralFor();
  for (const item of els.voiceMenu.querySelectorAll('.voice-item')) {
    item.setAttribute('aria-checked', item.dataset.neural ? item.dataset.neural === own?.id : item.dataset.uri ? !own && item.dataset.uri === uri : item.dataset.voice === settings.voice);
  }
}

/** The languages to read in: as written, English, and each language the reader or the system has a voice for. */
function buildLangMenu() {
  const langs = [...new Set([...Object.keys(NEURAL_VOICES), ...sysVoices.map((v) => baseOf(tagOf(v)))])].filter((l) => l !== 'en' && /^[a-z]{2,3}$/.test(l))
    .sort((a, b) => languageName(a).localeCompare(languageName(b)));
  const nodes = [
    menuItem({ lang: '' }, 'As written', '', 'Read the text as it is on the page.'),
    menuHead('Translated by Claude'),
    menuItem({ lang: 'en' }, 'English', '', 'For a document in another language. Spoken by the reader’s own voices.'),
    ...langs.map((l) => menuItem({ lang: l }, languageName(l), languageName(l, l), '')),
  ];
  if (!langs.length) nodes.push(Object.assign(menuHead(synth ? 'This browser has no voices for other languages' : 'This browser can’t speak other languages'), { style: 'text-transform: none; letter-spacing: 0' }));
  els.langMenu.replaceChildren(...nodes);
  markLang();
}

function buildScopeMenu() {
  els.scopeMenu.replaceChildren(menuHead('Read at a time'), ...SCOPES.map((x) => menuItem({ scope: x.id }, x.name, '', `${x.about} The arrow keys move by ${x.unit}.`)));
  for (const item of els.scopeMenu.querySelectorAll('.voice-item')) item.setAttribute('aria-checked', item.dataset.scope === settings.scope);
}

function setScope(scope) {
  if (scope === settings.scope) return;
  settings.scope = scope;
  saveSettings();
  buildScopeMenu();
  speaker.rescope();
  renderPlayer();
  toast(scope === 'document' ? 'Reading on to the end of the document.' : `Reading a ${scope} at a time.`, 2200);
}

function markLang() {
  for (const item of els.langMenu.querySelectorAll('.voice-item')) item.setAttribute('aria-checked', item.dataset.lang === settings.lang);
}

/** Choose the language to read in ('' for as written). Translation is Claude's work, so it needs Claude. */
function setLang(lang) {
  if (lang && !ai.available) {
    if (ai.reason === 'no_key') openKeyDialog(); else toast(ai.offMessage, 6000);
    return;
  }
  if (lang === settings.lang) return;
  settings.lang = lang;
  saveSettings();
  buildVoiceMenu();
  markLang();
  neural.load(); // starts the download, if this language is spoken by a voice not fetched yet
  translation.prepare();
  const s = speaker.session;
  if (s?.mode === 'read') speaker.restart(); else if (s) speaker.stop(); // a reply already given stays in its language
  renderPlayer();
  toast(lang ? `Reading aloud in ${languageName(lang)}, translated by Claude.` : 'Reading the text as written.', 3000);
}

function refreshSysVoices() {
  sysVoices = synth ? synth.getVoices().filter((v) => v.lang) : [];
  buildLangMenu();
  buildVoiceMenu();
  renderPlayer();
  translation.all(); // the language's system voice may have just turned up
}

// ── Preferences: the highlight colours ──────────────────────────────────────
// Each is a CSS variable. The stylesheet's value is the default; a chosen one (`settings.colors`)
// is laid over it. A colour here is a hue and how strongly it shows, since highlights sit over text.

const COLORS = [
  { key: 'para', css: '--para', name: 'Paragraph', about: 'The paragraph being read' },
  { key: 'word', css: '--sentence', name: 'Word', about: 'The word being spoken' },
  { key: 'boxFill', css: '--box-fill', name: 'Sentence', about: 'Inside the box round the sentence' },
  { key: 'boxLine', css: '--box-line', name: 'Sentence outline', about: 'The line of that box' },
  { key: 'hover', css: '--hover', name: 'Pointer', about: 'The paragraph under the pointer' },
  { key: 'pulse', css: '--pulse', name: 'Waiting', about: 'The pulse while a paragraph is prepared' },
  { key: 'explain', css: '--explain', name: 'Claude', about: 'A paragraph Claude is explaining' },
];
const rootStyle = document.documentElement.style;
for (const c of COLORS) c.initial = getComputedStyle(document.documentElement).getPropertyValue(c.css).trim();

/** 'rgba(251, 255, 179, .17)' or '#fbffb3' → { hex: '#fbffb3', alpha: 0.17 } */
function parseColor(text) {
  const hex = text.match(/^#([0-9a-f]{6})([0-9a-f]{2})?$/i);
  if (hex) return { hex: `#${hex[1].toLowerCase()}`, alpha: hex[2] ? parseInt(hex[2], 16) / 255 : 1 };
  const n = (text.match(/[\d.]+/g) || []).map(Number);
  if (n.length < 3) return { hex: '#ffff00', alpha: 0.3 };
  return { hex: '#' + n.slice(0, 3).map((v) => Math.round(Math.min(255, v)).toString(16).padStart(2, '0')).join(''), alpha: n.length > 3 ? Math.min(1, n[3]) : 1 };
}
const formatColor = ({ hex, alpha }) => `rgba(${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(', ')}, ${+alpha.toFixed(3)})`;

function applyColors() {
  for (const c of COLORS) {
    const chosen = settings.colors[c.key];
    if (chosen) rootStyle.setProperty(c.css, chosen); else rootStyle.removeProperty(c.css);
  }
  // The pulse of a paragraph Claude is working on is its own colour, stronger.
  const explain = settings.colors.explain && parseColor(settings.colors.explain);
  if (explain) rootStyle.setProperty('--explain-deep', formatColor({ hex: explain.hex, alpha: Math.min(1, explain.alpha * 1.67) }));
  else rootStyle.removeProperty('--explain-deep');
}

function buildPrefs() {
  $('prefsRows').replaceChildren(...COLORS.map((c) => {
    const row = Object.assign(document.createElement('div'), { className: 'prefs-row' });
    const label = document.createElement('label');
    label.append(Object.assign(document.createElement('b'), { textContent: c.name }), Object.assign(document.createElement('small'), { textContent: c.about }));
    const hue = Object.assign(document.createElement('input'), { type: 'color', title: `${c.name}: colour` });
    const strength = Object.assign(document.createElement('input'), { type: 'range', min: 0, max: 100, step: 1, title: `${c.name}: strength` });
    const reset = Object.assign(document.createElement('button'), { type: 'button', textContent: '↺', title: 'Back to the usual colour' });
    hue.setAttribute('aria-label', `${c.name} colour`);
    strength.setAttribute('aria-label', `${c.name} strength`);
    reset.setAttribute('aria-label', `Reset ${c.name}`);
    const show = () => {
      const now = parseColor(settings.colors[c.key] || c.initial);
      hue.value = now.hex;
      strength.value = Math.round(now.alpha * 100);
      reset.disabled = !settings.colors[c.key];
    };
    const choose = () => {
      settings.colors[c.key] = formatColor({ hex: hue.value, alpha: strength.value / 100 });
      saveSettings();
      applyColors();
      reset.disabled = false;
    };
    hue.addEventListener('input', choose);
    strength.addEventListener('input', choose);
    reset.addEventListener('click', () => { delete settings.colors[c.key]; saveSettings(); applyColors(); show(); });
    show();
    row.append(label, hue, strength, reset);
    return row;
  }));
}
$('prefsReset').addEventListener('click', () => { settings.colors = {}; saveSettings(); applyColors(); buildPrefs(); });
applyColors();
buildPrefs();

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
    block = headOf(block);
    if (this.block !== block) {
      this.close();
      this.block = block;
      for (const b of partsOf(block)) b.el.classList.add('chosen');
      els.chatInput.value = '';
    }
    els.chat.hidden = false;
    this.render();
    els.chatInput.focus({ preventScroll: true });
  },

  close() {
    if (!this.block) return;
    if (speaker.session?.mode === 'explain') speaker.stop();
    for (const b of partsOf(this.block)) b.el.classList.remove('chosen');
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
buildScopeMenu();
document.documentElement.style.setProperty('--zoom', settings.zoom);
refreshSysVoices();
synth?.addEventListener?.('voiceschanged', refreshSysVoices); // they arrive late in most browsers

els.pages.addEventListener('click', (e) => {
  const b = blockOf.get(e.target);
  if (b && e.detail < 2) speaker.toggleBlock(b); // the second click of a double-click is handled below
});
// Pointing at any part of a paragraph shows all of it.
let hovered = [];
const setHover = (block) => {
  if (block ? hovered.includes(block) : !hovered.length) return;
  hovered.forEach((b) => b.el.classList.remove('hover'));
  hovered = block ? partsOf(block) : [];
  hovered.forEach((b) => b.el.classList.add('hover'));
};
els.pages.addEventListener('mouseover', (e) => setHover(blockOf.get(e.target)));
els.pages.addEventListener('mouseleave', () => { setHover(null); sentencePick.hide(); });
els.pages.addEventListener('mousemove', (e) => sentencePick.follow(blockOf.get(e.target), e));
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
els.retryBtn.addEventListener('click', () => engineFor(speaker.session).load());
els.capBtn.addEventListener('click', () => {
  settings.captions = !settings.captions;
  saveSettings();
  renderPlayer();
  toast(settings.captions ? 'Sentence box: on — shows each sentence in the language it is read in.' : 'Sentence box: off.', 2200);
});
els.scopeMenu.addEventListener('click', (e) => {
  const item = e.target.closest('.voice-item');
  if (!item) return;
  els.scopeMenu.hidePopover();
  setScope(item.dataset.scope);
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
  if (item.dataset.neural) { delete settings.plain[settings.lang]; settings.own[settings.lang] = item.dataset.neural; }
  else if (item.dataset.uri) { settings.sysVoices[settings.lang] = item.dataset.uri; if (NEURAL_VOICES[settings.lang]) settings.plain[settings.lang] = true; }
  else settings.voice = item.dataset.voice;
  saveSettings();
  markVoice();
  translation.prepare(); // a voice that says more or less English the English way keeps to its own glossary
  els.voiceMenu.hidePopover();
  renderPlayer();
  if (speaker.session) speaker.restart(); else speaker.preview(settings.voice);
});
els.langMenu.addEventListener('click', (e) => {
  const item = e.target.closest('.voice-item');
  if (!item) return;
  els.langMenu.hidePopover();
  setLang(item.dataset.lang);
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
  } else if (e.key === 'Escape') { if (speaker.session) speaker.stop(); else if (speaker.recent) { select(null); renderPlayer(); } else chat.close(); }
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
// The word mark is timed to the frame; the interval above keeps reading going where frames stop.
(function frame() { if (speaker.session && !speaker.session.paused) speaker.tick(); requestAnimationFrame(frame); })();

ai.onChange = () => { renderChip(); renderPlayer(); };
renderPlayer();
renderChip();
voice.load();
neural.load();
const aiReady = ai.init();

const linked = new URLSearchParams(location.search).get('file');
if (linked) openPdf(new URL(linked, location.href).href, decodeURIComponent(linked.split('/').pop()).replace(/\.pdf$/i, ''));

window.reader = { speaker, view, settings, voice, neural, ai, narration, sentencePick };
