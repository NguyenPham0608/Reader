// The worker behind neural.js's VieNeu voices (VieNeu-TTS v3 Nano, a Vietnamese flow-matching
// model). Text becomes phonemes, the model predicts how long they take to say, shapes noise of
// that length into sound features over a number of steps, and a decoder turns those into a waveform.

import * as ort from './vendor/piper/ort.wasm.bundle.min.mjs';
import createPhonemizer from './vendor/piper/piper_phonemize.mjs';

const RATE = 24000;
const MAX_CHARS = 140;   // the model was trained on clips of 15 s at most: longer text is said in parts
const MAX_SECONDS = 15;
const GUIDANCE = 3;      // how firmly each step is held to the text, as against an unconditioned guess

let cfg, sessions, phonemizer, nothing, steps;
const voices = new Map();
const printed = [];
const cancelled = new Set();
let queue = Promise.resolve();

const f32 = (data, dims) => new ort.Tensor('float32', data instanceof Float32Array ? data : Float32Array.from(data), dims);
const i64 = (ids) => new ort.Tensor('int64', BigInt64Array.from(ids, (id) => BigInt(id)), [1, ids.length]);
const ones = (n) => new ort.Tensor('bool', new Uint8Array(n).fill(1), [1, n]);
const first = (out) => Object.values(out)[0];

async function init(m) {
  cfg = m.cfg;
  ort.env.wasm.wasmBinary = m.ortWasm;
  // Threads need the page to be cross-origin isolated, which the reader's own server arranges.
  const threads = self.crossOriginIsolated ? Math.min(8, Math.max(1, (navigator.hardwareConcurrency || 2) >> 1)) : 1;
  ort.env.wasm.numThreads = threads;
  steps = threads > 1 ? 16 : 8; // on one thread, half the steps (with the schedule that suits so few) keeps up with the voice
  phonemizer = await createPhonemizer({
    wasmBinary: m.ppWasm,
    noInitialRun: true,
    getPreloadedPackage: () => (m.ppData.byteLength === m.ppData.buffer.byteLength ? m.ppData.buffer : m.ppData.slice().buffer),
    print: (line) => printed.push(line),
    printErr: () => {},
  });
  sessions = {};
  for (const name of ['text_encoder', 'duration_predictor', 'vector_estimator', 'codec_decoder']) {
    sessions[name] = await ort.InferenceSession.create(m.models[name], { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
    m.models[name] = null; // the session has its own copy
  }
  for (const [name, v] of Object.entries(m.voices.voices)) voices.set(name, { spk: f32(v.spk, [1, 192]), style: f32(v.style, [1, cfg.n_style, cfg.style_dim]) });
  // What the model makes of no text and no voice: each step is pushed away from it (see GUIDANCE).
  const style = f32(m.voices.null.style, [1, cfg.n_style, cfg.style_dim]);
  const ctx = first(await sessions.text_encoder.run({ ids: i64([cfg.bos_id, cfg.eos_id]), style }));
  nothing = { ctx, ctx_mask: ones(2), spk: f32(m.voices.null.spk, [1, 192]), style };
}

// ── Text → phonemes ─────────────────────────────────────────────────────────
// The model was trained on espeak-ng's Vietnamese phonemes, with English words in espeak's
// American English. Telling the two apart is done here.

function espeak(text, lang) {
  printed.length = 0;
  phonemizer.callMain(['-l', lang, '--input', JSON.stringify([{ text }]), '--espeak_data', '/espeak-ng-data']);
  return printed.map((line) => { try { return JSON.parse(line).phonemes.join(''); } catch { return ''; } }).join(' ').trim();
}

// A word that could be one Vietnamese syllable written without its marks ("do", "ban"). Other
// words in plain Latin letters (Google, Transformer) are English.
const SYLLABLE = /^(?:ngh|ng|gh|gi|kh|nh|ph|qu|th|tr|ch|[bcdghklmnprstvx])?[aeiouy]{1,3}(?:ch|ng|nh|[cmnpt])?$/;
// AI, GDP, mRNA, U.S.
const ACRONYM = /^(?:[a-z]?[A-Z][A-Z0-9]*[A-Z][A-Z0-9]*s?|(?:[A-Z]\.){2,})$/;
const isEnglish = (word) => /^[A-Za-z][A-Za-z.'-]*$/.test(word) && (ACRONYM.test(word) || !word.toLowerCase().split('-').every((part) => SYLLABLE.test(part)));

const bare = (said) => said.replace(/[.!?,;:]+$/, ''); // espeak closes whatever it is given like a sentence

/** An English word as an English speaker says it. Capitals that are short or have no vowel go letter by letter; others (NASA) as a word. */
function english(word) {
  const letters = word.replace(/[^A-Za-z0-9]/g, '').replace(/(?<=[A-Z])s$/, '');
  const spelled = ACRONYM.test(word) && (letters.length <= 3 || !/[AEIOUY]/.test(letters) || /[a-z]/.test(letters[0]));
  // Each letter on its own: side by side, espeak takes "A I" for the article and a pronoun.
  return spelled ? [...letters].map((letter) => bare(espeak(letter, 'en-us'))).join(' ') : bare(espeak(word, 'en-us'));
}

function phonemes(text) {
  const heading = !/\p{Ll}/u.test(text); // all capitals: Vietnamese shouting, not acronyms
  const out = [];
  let run = [], lang = null;
  const flush = () => {
    if (!run.length) return;
    let said = lang === 'vi' ? espeak(run.join(' '), lang) : run.join(' ');
    if (lang === 'vi') {
      // espeak gives "r" its northern sound, the same as "d"; the model was taught it as its own sound.
      const words = said.split(' ');
      if (words.length === run.length) said = words.map((w, i) => (/^[^\p{L}]*r/iu.test(run[i]) ? w.replace(/^z/, 'ɹ') : w)).join(' ');
    }
    out.push(said);
    run = [];
  };
  for (const token of text.split(/\s+/).filter(Boolean)) {
    const [, , word, after] = token.match(/^([^\p{L}\p{N}]*)(.*?)([^\p{L}\p{N}]*)$/u);
    const to = !heading && isEnglish(word) ? 'en-us' : 'vi';
    if (to !== lang) { flush(); lang = to; }
    run.push(to === 'vi' ? token : english(word));
    const mark = to === 'vi' ? null : after.match(/[,.;:!?]/);
    if (mark) { flush(); out[out.length - 1] += mark[0]; lang = null; }
  }
  flush();
  return out.join(' ').replace(/[;:]/g, ',').replace(/\s+([,.!?])/g, '$1').replace(/([,.!?])(?=[^\s,.!?])/g, '$1 ').replace(/\s+/g, ' ').trim();
}

/** Split what is too long for one pass at a clause boundary or, failing that, a space. */
function pieces(text) {
  const out = [];
  while (text.length > MAX_CHARS) {
    const head = text.slice(0, MAX_CHARS);
    const cut = Math.max(...[', ', '; ', ': ', '. '].map((mark) => head.lastIndexOf(mark) + 1)) || head.lastIndexOf(' ') || MAX_CHARS;
    out.push(text.slice(0, cut).trim());
    text = text.slice(cut).trim();
  }
  if (text) out.push(text);
  return out;
}

// ── Phonemes → sound ────────────────────────────────────────────────────────

async function synthOne(text, voice, speed) {
  const ids = [cfg.bos_id, ...Array.from(phonemes(text), (ch) => cfg.vocab[ch]).filter((id) => id != null), cfg.eos_id];
  if (ids.length < 3) return new Float32Array(0);
  const mask = ones(ids.length);
  const ctx = first(await sessions.text_encoder.run({ ids: i64(ids), style: voice.style }));
  const logSeconds = first(await sessions.duration_predictor.run({ ctx, ctx_mask: mask, spk: voice.spk })).data[0];
  const frames = Math.max(2, Math.round(Math.min(Math.exp(logSeconds) / speed, MAX_SECONDS) * cfg.flow_fps));
  const dim = cfg.latent_dim * cfg.group;
  let x = new Float32Array(dim * frames);
  for (let i = 0; i < x.length; i++) x[i] = Math.sqrt(-2 * Math.log(1 - Math.random())) * Math.cos(2 * Math.PI * Math.random());
  // Few steps spend more of them early, where the shape of the sentence is decided.
  const sway = steps < 16 ? -1 : 0;
  const at = (i) => { const u = i / steps; return u + sway * (Math.cos(Math.PI / 2 * u) - 1 + u); };
  for (let i = 0; i < steps; i++) {
    const X = f32(x, [1, dim, frames]), t = f32([at(i)], [1]);
    const v = first(await sessions.vector_estimator.run({ x: X, t, ctx, ctx_mask: mask, spk: voice.spk, style: voice.style })).data;
    const blank = first(await sessions.vector_estimator.run({ x: X, t, ...nothing })).data;
    const dt = at(i + 1) - at(i);
    const next = new Float32Array(x.length);
    for (let k = 0; k < x.length; k++) next[k] = x[k] + dt * (blank[k] + GUIDANCE * (v[k] - blank[k]));
    x = next;
  }
  return trim(first(await sessions.codec_decoder.run({ x: f32(x, [1, dim, frames]) })).data);
}

/** Cut the silence the model leaves at either end, keeping a breath of it, and fade the edges so joins don't click. */
function trim(wav) {
  const win = RATE / 100, quiet = 10 ** (-45 / 20), keep = RATE * 0.04, fade = Math.round(RATE * 0.015);
  const loud = (w) => { let sum = 0; for (let i = w * win; i < (w + 1) * win; i++) sum += Math.abs(wav[i]); return sum / win > quiet; };
  const wins = Math.floor(wav.length / win);
  let a = 0, b = wins;
  while (a < b && !loud(a)) a++;
  while (b > a && !loud(b - 1)) b--;
  const out = Float32Array.from(wav.subarray(Math.max(0, a * win - keep), Math.min(wav.length, b * win + keep)), (v) => Math.max(-1, Math.min(1, v)));
  for (let i = 0, n = Math.min(fade, out.length >> 1); i < n; i++) {
    const ramp = 0.5 - 0.5 * Math.cos(Math.PI * i / n);
    out[i] *= ramp;
    out[out.length - 1 - i] *= ramp;
  }
  return out;
}

async function synth({ text, voice, speed }) {
  const v = voices.get(voice) ?? voices.values().next().value;
  const gap = Math.round(RATE * 0.12 / speed); // between the parts of a long sentence, on top of the breath each keeps
  const parts = [];
  for (const piece of pieces(text.normalize('NFC'))) {
    const wav = await synthOne(piece, v, speed);
    if (wav.length) parts.push(wav);
  }
  const pcm = new Float32Array(parts.reduce((n, p) => n + p.length, 0) + gap * Math.max(0, parts.length - 1));
  let at = 0;
  for (const p of parts) { pcm.set(p, at); at += p.length + gap; }
  return pcm;
}

self.onmessage = ({ data: m }) => {
  if (m.type === 'cancel') { cancelled.add(m.id); return; }
  queue = queue.then(async () => {
    try {
      if (m.type === 'init') {
        await init(m);
        self.postMessage({ id: m.id });
      } else if (m.type === 'phonemes') {
        self.postMessage({ id: m.id, pcm: phonemes(m.text) }); // for checking the text front end
      } else if (cancelled.delete(m.id)) {
        self.postMessage({ id: m.id, error: 'cancelled' });
      } else {
        const pcm = await synth(m);
        cancelled.delete(m.id);
        self.postMessage({ id: m.id, pcm }, [pcm.buffer]);
      }
    } catch (e) {
      self.postMessage({ id: m.id, error: String(e?.message || e) });
    }
  });
};
