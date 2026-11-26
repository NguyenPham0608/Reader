// The parts of the VieNeu-TTS v3 Turbo voice (vieneu-turbo-worker.js) that are plain logic, kept
// apart so they can be tested without a browser: the model's tokenizer, a reader for the arrays it
// ships in a NumPy .npz, and the vieneu package's sense of how long a piece of speech may run.

/** The float arrays in a NumPy .npz saved without compression (its bytes): { name: { data, shape } } */
export function readNpz(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), text = new TextDecoder();
  const out = {};
  let p = 0;
  while (p + 30 <= bytes.length && view.getUint32(p, true) === 0x04034b50) {
    if (view.getUint16(p + 8, true) !== 0) throw new Error('The voice tables are compressed, which this reader does not expect.');
    const nameLen = view.getUint16(p + 26, true), extraLen = view.getUint16(p + 28, true);
    const name = text.decode(bytes.subarray(p + 30, p + 30 + nameLen)).replace(/\.npy$/, '');
    // .npy: a magic string, a version, the header's length, then the header (a Python dict literal).
    const q = p + 30 + nameLen + extraLen, v1 = bytes[q + 6] === 1;
    const headerLen = v1 ? view.getUint16(q + 8, true) : view.getUint32(q + 8, true);
    const start = q + (v1 ? 10 : 12) + headerLen;
    const header = text.decode(bytes.subarray(q + (v1 ? 10 : 12), start));
    const descr = /'descr':\s*'([^']+)'/.exec(header)[1];
    const shape = /'shape':\s*\(([^)]*)\)/.exec(header)[1].split(',').map((s) => s.trim()).filter(Boolean).map(Number);
    if (/'fortran_order':\s*True/.test(header)) throw new Error(`${name}: column-major arrays are not expected.`);
    const n = shape.reduce((a, b) => a * b, 1), size = { '<f4': 4, '<f8': 8 }[descr];
    if (!size) throw new Error(`${name}: unexpected type ${descr}.`);
    const raw = bytes.slice(start, start + n * size).buffer; // copied, so that it is aligned
    out[name] = { data: size === 4 ? new Float32Array(raw) : Float32Array.from(new Float64Array(raw)), shape };
    p = start + n * size;
    // A data descriptor may follow the data: step to the next entry (or the directory at the end).
    while (p + 4 <= bytes.length && ![0x04034b50, 0x02014b50].includes(view.getUint32(p, true))) p++;
  }
  return out;
}

/** GPT-2's map from bytes to printable characters, which byte-level BPE works on. */
function byteChars() {
  const bs = [];
  for (let i = 33; i <= 126; i++) bs.push(i);
  for (let i = 161; i <= 172; i++) bs.push(i);
  for (let i = 174; i <= 255; i++) bs.push(i);
  const cs = [...bs];
  for (let b = 0, n = 0; b < 256; b++) if (!bs.includes(b)) { bs.push(b); cs.push(256 + n++); }
  const map = new Array(256);
  bs.forEach((b, i) => { map[b] = String.fromCharCode(cs[i]); });
  return map;
}

// The tokenizer's pre-tokenizer pattern, with its case-insensitive group spelt out for JavaScript.
const SPLIT = /'[sS]|'[tT]|'[rR][eE]|'[vV][eE]|'[mM]|'[lL][lL]|'[dD]|[^\r\n\p{L}\p{N}]?\p{L}+|\p{N}| ?[^\s\p{L}\p{N}]+[\r\n]*|\s*[\r\n]+|\s+(?!\S)|\s+/gu;

/**
 * The model's tokenizer (a Hugging Face tokenizer.json: NFC, added tokens, the split above,
 * byte-level BPE). → a function from phonemes to token ids
 */
export function makeTokenizer(json) {
  const vocab = json.model.vocab;
  const unk = vocab[json.model.unk_token];
  const ranks = new Map(json.model.merges.map((m, i) => [Array.isArray(m) ? m.join(' ') : m, i]));
  const added = new Map(json.added_tokens.map((t) => [t.content, t.id]));
  const special = new RegExp(`(${[...added.keys()].map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`);
  const chars = byteChars(), utf8 = new TextEncoder(), seen = new Map();
  const bpe = (word) => {
    let parts = seen.get(word);
    if (parts) return parts;
    parts = [...word];
    for (;;) {
      let best = -1, rank = Infinity;
      for (let i = 0; i + 1 < parts.length; i++) {
        const r = ranks.get(`${parts[i]} ${parts[i + 1]}`);
        if (r !== undefined && r < rank) { rank = r; best = i; }
      }
      if (best < 0) break;
      const a = parts[best], b = parts[best + 1], merged = [];
      for (let i = 0; i < parts.length; i++) {
        if (i + 1 < parts.length && parts[i] === a && parts[i + 1] === b) { merged.push(a + b); i++; } else merged.push(parts[i]);
      }
      parts = merged;
    }
    seen.set(word, parts);
    return parts;
  };
  return (text) => {
    const ids = [];
    for (const piece of text.split(special)) {
      if (!piece) continue;
      if (added.has(piece)) { ids.push(added.get(piece)); continue; }
      for (const [word] of piece.normalize('NFC').matchAll(SPLIT)) {
        for (const token of bpe([...utf8.encode(word)].map((b) => chars[b]).join(''))) ids.push(vocab[token] ?? unk);
      }
    }
    return ids;
  };
}

// ── A one-node ONNX model ───────────────────────────────────────────────────
// The scores for each codebook's 1024 codes are one matrix product per code picked, sixteen
// codes a frame: run by ONNX Runtime (vector instructions, every core) it is several times faster
// than in JavaScript. The model files have no such graph, so one is written here.

const utf8 = new TextEncoder();
const varint = (n) => { const out = []; while (n > 127) { out.push((n % 128) | 128); n = Math.floor(n / 128); } out.push(n); return out; };
const cat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
};
const pbInt = (field, v) => Uint8Array.from([...varint(field * 8), ...varint(v)]);
const pbBytes = (field, b) => cat(Uint8Array.from([...varint(field * 8 + 2), ...varint(b.length)]), b);
const pbStr = (field, s) => pbBytes(field, utf8.encode(s));

const FLOAT = 1, INT64 = 7; // ONNX element types
const bytesOf = (a) => new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
const valueInfo = (name, dims, type = FLOAT) => cat(pbStr(1, name), pbBytes(2, pbBytes(1, cat(pbInt(1, type),
  pbBytes(2, cat(...dims.map((d) => pbBytes(1, pbInt(1, d)))))))));
const tensor = (name, dims, type, data) => cat(...dims.map((d) => pbInt(1, d)), pbInt(2, type), pbStr(8, name), pbBytes(9, bytesOf(data)));
const node = (op, inputs, outputs, attrs = {}) => cat(...inputs.map((x) => pbStr(1, x)), ...outputs.map((x) => pbStr(2, x)), pbStr(4, op),
  ...Object.entries(attrs).map(([k, v]) => pbBytes(5, cat(pbStr(1, k), pbInt(3, v), pbInt(20, 2))))); // int attributes

/** The top-level fields of a protobuf message: [{ num, start, end }] over `buf`, `end` where the field's bytes end. */
export function protoFields(buf) {
  const out = [];
  let p = 0;
  const varint = () => { let r = 0, m = 1, x; do { x = buf[p++]; r += (x & 127) * m; m *= 128; } while (x & 128); return r; };
  while (p < buf.length) {
    const start = p, key = varint(), num = Math.floor(key / 8), wire = key % 8;
    if (wire === 0) varint();
    else if (wire === 2) { const len = varint(); out.push({ num, start, body: p, end: p + len }); p += len; continue; }
    else if (wire === 5) p += 4;
    else if (wire === 1) p += 8;
    else throw new Error(`Unexpected protobuf wire type ${wire}.`);
    out.push({ num, start, end: p });
  }
  return out;
}

/** An ONNX model computing y[1, rows] = x[1, cols] · Wᵀ, for `weights` W (rows × cols, row by row). → its bytes */
export function gemmModel(rows, cols, weights) {
  const graph = cat(pbBytes(1, node('Gemm', ['x', 'w'], ['y'], { transB: 1 })), pbStr(2, 'head'),
    pbBytes(5, tensor('w', [rows, cols], FLOAT, weights)), pbBytes(11, valueInfo('x', [1, cols])), pbBytes(12, valueInfo('y', [1, rows])));
  return cat(pbInt(1, 8), pbBytes(8, cat(pbStr(1, ''), pbInt(2, 17))), pbBytes(7, graph)); // IR version 8, opset 17
}

/**
 * The acoustic transformer's ONNX model with the scores for a codebook's codes added on, so a
 * code is one call rather than two: an input `codebook` (an int64 scalar) and an output
 * `logits`[1, rows], the last position of `hidden` against `weights` (books × rows × cols)
 * for that codebook. → the new model's bytes
 */
export function withHead(model, books, rows, cols, weights) {
  const parts = protoFields(model), graph = parts.find((f) => f.num === 7);
  const added = cat(
    pbBytes(1, node('Gather', ['hidden', 'head_last_index'], ['head_last'], { axis: 1 })),
    pbBytes(1, node('Gather', ['head_weights', 'codebook'], ['head_book'], { axis: 0 })),
    pbBytes(1, node('Gemm', ['head_last', 'head_book'], ['logits'], { transB: 1 })),
    pbBytes(5, tensor('head_last_index', [], INT64, BigInt64Array.from([-1n]))),
    pbBytes(5, tensor('head_weights', [books, rows, cols], FLOAT, weights)),
    pbBytes(11, valueInfo('codebook', [], INT64)),
    pbBytes(12, valueInfo('logits', [1, rows])),
  );
  const rest = parts.filter((f) => f !== graph).map((f) => model.subarray(f.start, f.end));
  return cat(...rest, pbBytes(7, cat(model.subarray(graph.body, graph.end), added)));
}

// ── How long a piece may run ────────────────────────────────────────────────

export const MAX_FRAMES = 300; // 24 s, the most any piece may take
const MARKUP = /<\|emotion_\d+\|>|<\/?en>/g;
const IPA_VOWELS = new Set('aeiouyæɐɑɒɔəɘɛɜɤɯɵøœʉʊʌɪɨɚɝᵻᵿ');

/** How many syllables the phonemes hold: one per Vietnamese word, by vowel groups in English ones. */
export function syllableCount(phonemes) {
  let total = 0;
  for (const tok of phonemes.replace(MARKUP, '').split(/\s+/)) {
    let groups = 0, inVowel = false, consonant = true;
    for (const ch of tok) {
      if (IPA_VOWELS.has(ch)) {
        if (!inVowel && consonant) groups++;
        inVowel = true; consonant = false;
      } else if ('ːˈˌ'.includes(ch) || /\d/.test(ch)) {
        if ('ˈˌ'.includes(ch) && groups > 0) { inVowel = false; consonant = true; } else inVowel = false;
      } else { inVowel = false; consonant = true; }
    }
    if (/\p{L}/u.test(tok)) total += Math.max(1, groups);
  }
  return total;
}

/** The most frames a piece with these phonemes should take: past this it is making things up. */
export function maxFrames(phonemes) {
  const len = [...phonemes.replace(MARKUP, '')].length;
  let cap = 24 + Math.ceil(2 * len);
  if (!phonemes.includes('<|emotion_')) {
    const syl = Math.max(1, syllableCount(phonemes));
    if (syl <= 4 && len <= 24 * syl) cap = Math.min(cap, 13 + 5 * (syl - 1));
  }
  return Math.min(MAX_FRAMES, cap);
}

/** A long sentence in pieces the model can say in one go (it was trained on pieces of up to 256 characters), cut where a reader would pause. */
export function turboPieces(text, max = 240) {
  const out = [];
  let rest = text.trim();
  while (rest.length > max) {
    const head = rest.slice(0, max);
    let cut = Math.max(head.lastIndexOf(', '), head.lastIndexOf('; '), head.lastIndexOf(': '), head.lastIndexOf(' – '), head.lastIndexOf(' — '));
    if (cut < max * 0.4) cut = head.lastIndexOf(' ');
    if (cut <= 0) cut = max - 1;
    out.push(rest.slice(0, cut + 1).trim());
    rest = rest.slice(cut + 1).trim();
  }
  if (rest) out.push(rest);
  return out;
}

// Abbreviations in capitals are said the English way: sea-g2p reads text marked <en>…</en> as
// English, so they are marked, spelt as letters ("DMRG" → "<en>d m r g</en>", "dee em ar gee"),
// or for the few said as words, as the word ("<en>nasa</en>").
const SAID_AS_WORDS = new Set(['NASA', 'NATO', 'UNESCO', 'UNICEF', 'COVID', 'AIDS', 'SARS', 'LASER', 'RADAR', 'SONAR', 'LIDAR',
  'ASEAN', 'OPEC', 'FIFA', 'RAM', 'ROM', 'LAN', 'WAN', 'SIM', 'PIN', 'GIF', 'JPEG', 'ASCII', 'BASIC', 'COBOL', 'FORTRAN', 'SCUBA']);
const ROMAN = /^(?:I{2,3}|IV|VI{0,3}|IX|XI{0,3}|X{2,3}|XI?V|XIX)$/; // a numeral (II, IV, XII), not an abbreviation

/** A sentence with its abbreviations marked to be said in English (see above). */
export function englishAbbreviations(text) {
  // A heading set in capitals has Vietnamese words in capitals too, with their marks (PHẦN, KẾT), which no abbreviation has.
  if ((text.match(/[\p{L}]+/gu) || []).some((w) => w.length > 1 && w === w.toUpperCase() && /[^\x00-\x7F]/.test(w))) return text;
  return text.replace(/(?<![\p{L}\p{N}])[a-z]?[A-Z]{2,8}(?![\p{L}\p{N}])/gu, (m) => {
    if (ROMAN.test(m)) return m;
    if (SAID_AS_WORDS.has(m)) return `<en>${m.toLowerCase()}</en>`;
    return `<en>${[...m.toLowerCase()].join(' ')}</en>`;
  });
}
