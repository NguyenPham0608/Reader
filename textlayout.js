// Reading a PDF page as text: its text items → lines → paragraphs → sentences. Nothing here
// touches the page or the screen, so the same code runs in the reader and in tests.
//
// Lines come from the PDF. Which lines form a paragraph is Claude's call when Claude is on (see
// `narration` in app.js), with the guess made here standing in until its answer arrives.

// ── Lines and paragraphs ────────────────────────────────────────────────────

const mul = (a, b) => [
  a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1],
  a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3],
  a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5],
];
export const half = (n) => Math.round(n * 2) / 2;

/** Whether a glyph is a drop cap: one capital set much larger than the line it opens. */
const dropCap = (g, lineSize) => /^\p{Lu}$/u.test(g.str.trim()) && g.size > 1.6 * lineSize;

/** Whether a space goes between the text so far (ending with glyph `prev`) and glyph `g`, on a line of type size `size`. */
function spaceBefore(text, prev, g, size) {
  if (!prev || /\s$/.test(text) || /^\s/.test(g.str)) return false;
  if (/^\p{M}/u.test(g.str)) return false; // an accent that belongs on the letter before
  if (dropCap(prev, size) && /^\p{Ll}/u.test(g.str)) return false; // "D erivatives"
  return g.spaced || g.x0 - prev.x1 > 0.15 * size;
}

// Accents some PDFs set as a character of their own after the letter ("Schro¨dinger"): as combining marks.
const ACCENTS = { '¨': '\u0308', '´': '\u0301', 'ˆ': '\u0302', '˜': '\u0303', '¸': '\u0327', 'ˇ': '\u030C', '˘': '\u0306', '˚': '\u030A' };
const SPACING_ACCENT = /[¨´ˆ˜¸ˇ˘˚]/u;
const fixAccents = (str, after) => str
  .replace(/(\p{L})([¨´ˆ˜¸ˇ˘˚])/gu, (m, l, a) => l + ACCENTS[a])
  .replace(/^[¨´ˆ˜¸ˇ˘˚]/u, (a) => (after ? ACCENTS[a] : a));

/** Private-use characters are a font's own symbols, with no meaning as text: as wide as a dash, they are one. */
const PRIVATE = /^[\uE000-\uF8FF]+$/u;
function privateGlyph(width, size) {
  const em = width / size;
  return em >= 0.75 ? '—' : em >= 0.4 ? '–' : null;
}

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
  // A drop cap is the first letter of the word beside it, whatever space the PDF puts after it.
  const [cap, next] = line.glyphs;
  if (next && dropCap(cap, line.size) && /^\p{Ll}/u.test(next.str)) cap.str = cap.str.trim();
  // Small text sitting above or below the baseline is a superscript or subscript (y grows downward).
  for (const g of line.glyphs) {
    g.shift = g.size >= 0.86 * line.size ? 0
      : g.base < line.base - 0.1 * line.size ? 1
      : g.base > line.base + 0.06 * line.size ? -1 : 0;
  }
  // The line as text, with ^{...} and _{...} around super- and subscripts: what Claude is shown.
  let text = '', prev = null;
  for (const g of line.glyphs) {
    if (spaceBefore(text, prev, g, line.size)) text += ' ';
    text += g.shift > 0 ? `^{${g.str}}` : g.shift < 0 ? `_{${g.str}}` : g.str;
    prev = g;
  }
  line.text = text.replace(/\}\^\{|\}_\{/g, '').replace(/\s+/g, ' ').trim();
}

/** A page's text items → its lines of text, in the PDF's own order. Coordinates are page units, y down. */
export function extractLines(items, vt) {
  const lines = [];
  let line = null;
  let spaced = false;
  for (const it of items) {
    if (!it.str || !it.str.trim()) { spaced = spaced || !!it.str; continue; }
    const m = mul(vt, it.transform);
    if (Math.abs(Math.atan2(m[1], m[0])) > 0.2) continue; // sideways text (margin stamps)
    const size = Math.hypot(m[2], m[3]) || it.height || 10;
    let str = it.str;
    if (PRIVATE.test(str.trim())) {
      str = privateGlyph(it.width, size);
      if (!str) { spaced = true; continue; } // an unknown symbol: at least the words either side stay apart
    }
    const g = { str, x0: m[4], x1: m[4] + it.width, base: m[5], size, font: it.fontName, spaced };
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
    if (SPACING_ACCENT.test(g.str)) g.str = fixAccents(g.str, /\p{L}$/u.test(line.glyphs[line.glyphs.length - 1]?.str ?? ''));
    line.glyphs.push(g);
    line.x1 = Math.max(line.x1, g.x1);
    if (size > line.size * 1.05) { line.size = size; line.base = g.base; }
  }
  lines.forEach(finishLine);
  // The page's words, to tell a hyphen that splits a word at a line's end from one that belongs.
  const vocab = new Set(lines.flatMap((ln) => ln.text.toLowerCase().match(/\p{L}[\p{L}\p{N}]*(?:-\p{L}[\p{L}\p{N}]*)*/gu) ?? []));
  lines.forEach((ln, i) => { ln.id = i; ln.vocab = vocab; });
  return lines;
}

// Words that, before a hyphen at a line's end, are the first half of a compound ("two-electron",
// "self-consistent"), not the start of a broken word.
const COMPOUND = new Set(['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'first', 'second',
  'third', 'half', 'self', 'non', 'well', 'high', 'low', 'long', 'short', 'state', 'all', 'full', 'real', 'open', 'closed', 'time',
  'single', 'double', 'triple', 'multi', 'cross', 'far', 'near', 'left', 'right', 'top', 'bottom', 'end', 'user', 'case', 'large',
  'small', 'built', 'so', 'ill', 'best', 'least', 'most', 'like', 'free', 'based', 'data', 'zero', 'semi', 'quasi', 'pseudo']);

/**
 * Whether a hyphen at the end of a line belongs to the text ("two-|electron", "M-|series") rather
 * than splitting a word ("pro-|posed"). `left` and `right` are the word's parts either side;
 * `vocab`, if known, the words found elsewhere on the page.
 */
export function keepHyphen(left, right, vocab) {
  // Names and codes keep theirs ("M-series", "cc-pVnZ", "F12-based").
  if (/[\p{Lu}\p{N}]/u.test(left) || !/^\p{Ll}/u.test(right) || /[\p{Lu}\p{N}]/u.test(right)) return true;
  const l = left.toLowerCase(), r = right.toLowerCase();
  if (vocab?.has(`${l}-${r}`)) return true;
  if (vocab?.has(l + r)) return false;
  return COMPOUND.has(l);
}

/**
 * Guess which lines make up each paragraph from spacing, size and indentation. This is the
 * stand-in until Claude has looked at the page (and the only grouping when Claude is off).
 */
export function guessGroups(lines) {
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
    const lead = leading.get(half(b.size)) ?? (b.lines.length > 1 ? b.lines[1].base - b.lines[0].base : b.size * 1.5);
    const ratio = ln.size / b.size;
    if (ratio > 1.15 || ratio < 0.87) {
      // A full line of the paragraph whose type size came out wrong (a scan's text layer does this)
      // still belongs to it: same font, same margins, the usual spacing.
      const glitch = ratio < 0.87 && b.lines.length >= 2 && ln.font === last.font && Math.abs(ln.x0 - b.x0) < 0.5 * b.size
        && Math.abs(ln.x1 - b.x1) < 1.5 * b.size && Math.abs(dy - lead) < 0.15 * lead;
      if (!glitch) return false;
    }
    if (dy > lead * 1.25) return false;
    if (ln.x1 < b.x0 || ln.x0 > b.x1) return false;
    // A line in another font over the rest is a heading when it is larger, or shorter than the line
    // under it; a full-width one is the bold start of a paragraph or a list item ("Note. The …").
    if (b.lines.length === 1 && last.font !== ln.font) {
      const heading = b.size > 1.05 * ln.size || last.x1 - last.x0 < 0.7 * (ln.x1 - ln.x0) || !/\p{Ll}/u.test(last.text);
      if (heading) return false;
    }
    // A paragraph's last line: it ends a sentence and stops short of the margin. A slightly wider
    // gap after one starts the next paragraph, where paragraphs aren't indented.
    const ended = /[.!?:;)]["'”’\]]*$/u.test(last.text) && last.x1 < b.x1 - 3 * b.size;
    if (ended && dy > lead * 1.1) return false;
    if (b.lines.length > 1 || dropCap(b.lines[0].glyphs[0], b.lines[0].size)) {
      const centered = Math.abs((ln.x0 + ln.x1) / 2 - (last.x0 + last.x1) / 2) < 0.6 * b.size;
      // Next to a drop cap the lines start at its right; under it they come back out to its left.
      const cap = dropCap(b.lines[0].glyphs[0], b.lines[0].size) ? b.lines[0].glyphs[0] : null;
      const underCap = cap && (Math.abs(ln.x0 - cap.x0) < 0.8 * b.size || Math.abs(ln.x0 - cap.x1) < 0.8 * b.size);
      if (!centered && !underCap && Math.abs(ln.x0 - last.x0) > 0.8 * b.size) return false; // indent or outdent starts a new one
    }
    // A bullet, or a number after a finished line, starts a list item.
    if (BULLET.test(ln.text)) return false;
    if (MARKER.test(ln.text) && (ended || /[.!?:;]["'”’)\]]*$/u.test(last.text))) return false;
    return true;
  };
  const groups = [];
  let cur = null, held = null; // `held` is the paragraph a stray formula fragment interrupted
  let math = null; // the displayed equation whose scattered pieces are being gathered
  const letters = (ln) => ln.glyphs.reduce((n, g) => n + g.str.replace(/[^\p{L}\p{N}]/gu, '').length, 0);
  for (const ln of lines) {
    // The pieces of a displayed equation (its parts, sub- and superscripts, its number) come out as
    // lines of their own, a symbol or two each: gathered into one block.
    if (mathish(ln.text)) {
      if (math && nearEquation(math, ln)) {
        math.lines.push(ln);
        Object.assign(math, { x0: Math.min(math.x0, ln.x0), x1: Math.max(math.x1, ln.x1), top: Math.min(math.top, ln.top), bottom: Math.max(math.bottom, ln.bottom) });
        continue;
      }
      if (!cur || !fits(cur, ln)) {
        math = { lines: [ln], x0: ln.x0, x1: ln.x1, top: ln.top, bottom: ln.bottom, size: ln.size, math: true };
        held = cur && !cur.math ? cur : held;
        cur = math;
        groups.push(math);
        continue;
      }
    } else if (cur?.math) {
      if (held && fits(held, ln)) { cur = held; held = null; math = null; }
    }
    if (cur && !fits(cur, ln) && held && fits(held, ln)) { cur = held; held = null; }
    if (cur && !cur.math && fits(cur, ln)) {
      cur.lines.push(ln);
      cur.x0 = Math.min(cur.x0, ln.x0);
      cur.x1 = Math.max(cur.x1, ln.x1);
    } else {
      const fragment = letters(ln) <= 6 && ln.x1 - ln.x0 < 8 * ln.size;
      held = fragment && cur ? (held && cur.lines.length === 1 && letters(cur.lines[0]) <= 6 ? held : cur) : null;
      cur = { lines: [ln], x0: ln.x0, x1: ln.x1, size: ln.size };
      groups.push(cur);
      math = null;
    }
  }

  return groups.map((g) => g.lines);
}

const BULLET = /^[•◦▪▫●○■□►▶‣⁃∙*]\s*\S/u;
const MARKER = /^(?:\(?(?:\d{1,2}|[a-z]|[ivx]{1,4})[.)]|[–—-])\s+\S/u;

/**
 * Whether a line is a piece of a formula rather than words: symbols and short tokens only
 * (letters standing for variables, subscripts like "ij", an equation number like "(4)").
 */
export function mathish(text) {
  const t = text.trim();
  if (!t || t.length > 48) return false;
  return !/\p{Ll}{4,}|\p{Lu}{5,}|\p{Lu}\p{Ll}{3,}/u.test(t); // no word in it
}

/** Whether line `ln` is another piece of the displayed equation gathered so far, close by on the page. */
function nearEquation(eq, ln) {
  const s = Math.max(eq.size, ln.size);
  const level = ln.top < eq.bottom + 2 * s && ln.bottom > eq.top - 2 * s;
  const numbered = /^\(\d+[a-z]?\)$/.test(ln.text.trim()) && ln.top < eq.bottom + s && ln.bottom > eq.top - s;
  // An equation's operators and terms can sit several ems apart ("F X   −   X F   =   0").
  return level && (numbered || (ln.x0 < eq.x1 + 10 * s && ln.x1 > eq.x0 - 10 * s));
}

/** Join lines into one block: its text, and where every piece of that text sits on the page. */
export function buildBlock(lines) {
  let text = '';
  const spans = [];
  lines.forEach((ln, li) => {
    if (li > 0) {
      const first = ln.glyphs[0].str.trimStart();
      const broken = text.match(/([\p{L}\p{N}]+)([-\u00AD\u2010])$/u);
      const right = first.match(/^\p{L}+/u)?.[0];
      if (broken && right && /^\p{Ll}/u.test(right) && (broken[2] === '\u00AD' || !keepHyphen(broken[1], right, ln.vocab))) {
        text = text.slice(0, -1); // a word hyphenated across the line break
        const lastSpan = spans[spans.length - 1];
        lastSpan.end = Math.max(lastSpan.start, text.length);
      } else if ((broken || /[\p{L}\p{N}]\/$/u.test(text)) && /^[\p{L}\p{N}]/u.test(first)) {
        // A hyphen or a slash that belongs ("two-|electron", "VnZ-|F12", "and/|or"): no space after it.
      } else if (!/\s$/.test(text)) {
        text += ' ';
      }
    }
    let prev = null;
    for (const g of ln.glyphs) {
      if (spaceBefore(text, prev, g, ln.size)) text += ' ';
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

/**
 * Split a group of lines where the text jumps to another part of the page: the next column, the
 * far side of a figure, a header and a footer filed together. One box around such a group would
 * cover everything in between (at worst the whole page), so each stretch gets its own.
 */
export function regions(lines) {
  if (lines.length > 1 && lines.every((ln) => mathish(ln.text))) return [lines]; // one displayed equation, however spread out
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

// ── Paragraphs cut by a column or page break ────────────────────────────────

export const BODY = new Set(['', 'paragraph', 'list']);
export const SENTENCE_OVER = /[.!?:…]["'”’)\]]*\d{0,3}$/u; // allows a footnote mark after the full stop
export const HYPHEN_END = /\p{L}[-\u00AD\u2010]$/u;

/** Whether a stretch of text reads as running prose rather than a formula, a table row or a label. */
export function prose(text) {
  const tokens = text.trim().split(/\s+/);
  const words = tokens.filter((t) => /^[(“"‘']*\p{L}[\p{L}'’-]+[.,;:!?)”"’']*$/u.test(t));
  return tokens.length >= 3 && words.length >= tokens.length / 2;
}

/** Whether block `b` picks up the paragraph that block `a` leaves unfinished. */
export function continues(a, b) {
  if (!BODY.has(a.kind) || !BODY.has(b.kind) || a.skip || b.skip) return false;
  if (Math.abs(a.size - b.size) > 0.06 * a.size) return false;
  // Over a page break the font's name can change though the font doesn't (a scan's text layer):
  // then only a paragraph plainly cut off mid-sentence, in lower case, is followed.
  if (a.font !== b.font && (a.page === b.page || a.lines.length < 2 || !/\p{Ll}[,;]?$/u.test(a.text.trimEnd()))) return false;
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

// ── Sentences ───────────────────────────────────────────────────────────────

export function cleanForSpeech(s) {
  return s
    .normalize('NFKC')
    .replace(/­/g, '')
    .replace(/\s*\[\d+(?:\s*[,–—-]\s*\d+)*\]/g, '') // citation markers like [12] or [3, 4]
    .replace(/[•‣▪●◦⁃∙]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// A sentence is said whole, however long. Only text that runs on far past any sentence (a list or
// a table set as one line) is cut, at a clause.
export const MAX_CHUNK = 1000;
// A short capitalized word cut off with a full stop, as journal names are ("Chem.", "Phys.", "Lett.").
const JOURNAL = /(?:^|\s)\p{Lu}\p{Ll}{0,6}\.\s*$/u;
// A heading's or a caption's label, alone before the break: "Chapter 1. | Introduction", "Figure 3. | The …"
// (not a sentence that ends on one: "… shown in Table 1. | The …").
const NUMBERED = /^\s*(?:Chapter|Section|Part|Lesson|Unit|Step|Figure|Fig|Table|Example|Problem|Exercise|Theorem|Lemma|Definition|Corollary|Proposition|Appendix|Equation|Eq)\s+(?:\d+(?:\.\d+)*|[IVXLC]+|[A-Z])\.\s*$/iu;
// Sentence-ending words that also end abbreviations: followed by a word that starts sentences, the
// full stop ends one ("… by Smith et al. We found …", "… vitamin C. The …").
const ENDS_TOO = /(?:\bet al|\betc|\b\p{Lu})\.\s*$/u;
const STARTS = /^\s*["'“‘(\[]*(?:The|This|These|Those|That|We|Our|In|It|Its|Here|However|Thus|Hence|Therefore|Moreover|Furthermore|Finally|Also|Indeed|Overall|Instead|Similarly|Consequently|A|An|As|For|To|Such|They|There|On|At|By|From|With|When|While|Although|Since|Because|Each|All|Both|If|Then|Next|First|Second|Note|Table|Figure|Using|After|Before|Unlike|Despite|Most|Many|Some|Only|One|No)\b/u;
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
export function falseStop(before, after, ahead) {
  if (ENDS_TOO.test(before) && STARTS.test(after)) return false;
  return ABBREV.test(before)                                    // "see Fig. | 2", "Smith et al. | 2020"
    || (JOURNAL.test(before) && /^\s*(?:\p{Lu}\p{Ll}{0,6}\.|\d)/u.test(after)) // "J. Chem. | Phys. | 138, 134113"
    || NUMBERED.test(before)                                      // "Chapter 1. | Introduction"
    || (/\bNo\.\s*$/.test(before) && /^\s*\d/.test(after))        // "No. | 5", but "No. | Maybe so."
    || (unclosed(before) > 0 && /[)\]]/.test(ahead))               // a full stop inside brackets: "(p. | 5)"
    || !/\p{L}/u.test(before) || !/[\p{L}\p{N}]/u.test(after)   // nothing to say on one side: "1. | Introduction", "… | )."
    || /^[\s"'“‘(\[]*\p{Ll}+(?![\p{Lu}\p{N}\p{Ll}])/u.test(after); // carries on in lower case: "approx. | five" (but not "mRNA")
}

/**
 * Where each sentence of a paragraph's text starts and ends: [[start, end]], in order, together
 * covering the text. These are the pieces the voice speaks one after another. `raised` lists
 * the stretches of the text set as superscripts ([[start, end]]), where the PDF says so: a
 * citation number raised after a full stop ends the sentence even when it reads like a version
 * number ("MOLPRO 2015.1.^29 For …").
 */
export function sentenceRanges(t, raised = []) {
  const parts = [];
  if (segmenter) {
    for (const s of segmenter.segment(t)) {
      // Ends the segmenter misses: before a word like "mRNA" or "pH" (it takes a lower-case letter
      // to mean the sentence carries on), where the text lost the space after a full stop
      // ("end.The"), and after a reference number set against the full stop ("shown.12 The",
      // "constants).1,2 However").
      const cuts = new Set();
      for (const re of [/[.!?]["'”’)\]]*\s+(?=\p{Ll}{1,2}\p{Lu})/gu, /(?<=\p{Ll}{2}[.!?]["'”’)\]]*)(?=\p{Lu}\p{Ll})/gu, /(?<=(?:\p{Ll}{2}|[)\]"”’])[.!?]\d{1,3}(?:[,–-]\d{1,3})*)\s+(?=\p{Lu})/gu]) {
        for (const m of s.segment.matchAll(re)) cuts.add(m.index + m[0].length);
      }
      for (const [a, b] of raised) {
        const end = a + t.slice(a, b).trimEnd().length; // (the PDF's run can carry the space after it)
        if (a > s.index && end < s.index + s.segment.length && /[.!?]$/.test(t.slice(0, a)) && /^\d/.test(t.slice(a, end))) {
          const space = /^\s+(?=\p{Lu})/u.exec(t.slice(end));
          if (space) cuts.add(end - s.index + space[0].length);
        }
      }
      let from = 0;
      for (const at of [...cuts].sort((a, b) => a - b)) { if (at > from) parts.push([s.index + from, s.index + at]); from = at; }
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
    if (last && falseStop(t.slice(last[0], last[1]), t.slice(p[0], p[1]), t.slice(p[0], p[0] + 280))) last[1] = p[1];
    else merged.push([p[0], p[1]]);
  }
  const ranges = [];
  for (const [s, e] of merged) splitLong(t, s, e, ranges);
  return ranges;
}
