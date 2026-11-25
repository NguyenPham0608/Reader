// The worker behind neural.js's VieNeu-TTS v3 Turbo voices (github.com/pnnbao97/VieNeu-TTS,
// Apache-2.0). The text arrives as phonemes: the reader's server writes them with sea-g2p, the
// model's own front end. A 12-layer transformer reads them together with the voice's reference
// recording, then makes the speech 80 ms at a time: at each step a one-layer "acoustic"
// transformer picks 16 codes, one per codebook, and the MOSS audio codec turns codes into a
// 48 kHz waveform. The codec works frame by frame, so a long piece can be played while it is
// still being made (`stream`).
//
// A port of the vieneu package's torch-free ONNX engine (onnx_runtime_lite.py), with its
// sampling settings, its cap on how long a piece may run and its guard against short pieces
// that say more than they were given.

import * as ort from './vendor/piper/ort.wasm.bundle.min.mjs';
import { makeTokenizer, readNpz, syllableCount, maxFrames, gemmModel } from './vieneu-turbo-lib.js';

const RATE = 48000;               // the codec's: a frame is 3840 samples, 80 ms
const TEMPERATURE = 0.8;
const TOP_K = 25;
const TOP_P = 0.95;
const REP_PENALTY = 1.2;          // codes picked in the last REP_WINDOW frames are made less likely, which breaks loops
const REP_WINDOW = 64;
const BABBLE_RETRIES = 2;
const FIRST_FRAMES = 4;           // streaming: frames made before the first are decoded, then NEXT_FRAMES at a time
const NEXT_FRAMES = 8;
const STREAM_BELOW = 0.75;        // streaming only while this machine makes a second of speech in less than this
const QUIET = 0.015;              // below this, a sample is the silence around speech
const KEEP = Math.round(RATE * 0.06);   // of that silence, kept before and after speech
const HOLD = Math.round(RATE * 0.3);    // streaming: held back, since it may be the silence at the end

const voices = new Map();
let cfg, encode, sessions, heads, codecState, textEmb, audioEmb, audioRows, H, L, nVq, nHeadsLoc, headDimLoc, layersLoc;
let pace = 0;                     // seconds of work the last piece took per second of its speech
const cancelled = new Set();
let queue = Promise.resolve();

const f32 = (data, dims) => new ort.Tensor('float32', data, dims);
const i32 = (data, dims) => new ort.Tensor('int32', data, dims);
const i64 = (values, dims) => new ort.Tensor('int64', BigInt64Array.from(values, BigInt), dims);
const count = (shape) => shape.reduce((a, b) => a * b, 1);

// ── Loading ─────────────────────────────────────────────────────────────────

/** A voice's place in the model: its speaker embedding projected and normalised (xvec_proj), and its reference codes. */
function makeVoice(v, npz) {
  const w = npz.xvec_w.data, b = npz.xvec_b.data, dim = npz.xvec_w.shape[1];
  const anchor = new Float32Array(H);
  for (let h = 0; h < H; h++) {
    let s = b[h];
    for (let j = 0; j < dim; j++) s += v.speaker_emb[j] * w[h * dim + j];
    anchor[h] = s;
  }
  let mean = 0, varSum = 0;
  for (let h = 0; h < H; h++) mean += anchor[h];
  mean /= H;
  for (let h = 0; h < H; h++) varSum += (anchor[h] - mean) ** 2;
  const scale = 1 / Math.sqrt(varSum / H + npz.xvec_ln_eps.data[0]);
  for (let h = 0; h < H; h++) anchor[h] = (anchor[h] - mean) * scale * npz.xvec_ln_w.data[h] + npz.xvec_ln_b.data[h];
  return { anchor, codes: v.codes };
}

async function init(m) {
  cfg = m.cfg;
  H = cfg.hidden_size;
  L = cfg.num_hidden_layers;
  nVq = cfg.n_vq;
  nHeadsLoc = cfg.local_num_attention_heads ?? 8;
  headDimLoc = H / nHeadsLoc;
  layersLoc = cfg.local_num_hidden_layers ?? 1;
  ort.env.wasm.wasmBinary = m.ortWasm;
  // Threads need the page to be cross-origin isolated (the reader's server, or its service worker on other hosts, arranges that).
  ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(8, Math.max(1, navigator.hardwareConcurrency || 1)) : 1;
  encode = makeTokenizer(m.tokenizer);
  const npz = readNpz(m.heads);
  textEmb = npz.text_emb.data;
  audioEmb = npz.audio_emb.data;
  audioRows = npz.audio_emb.shape[1];
  for (const [name, v] of Object.entries(m.voices)) voices.set(name, makeVoice(v, npz));
  const opts = (path, bytes) => ({
    executionProviders: ['wasm'], graphOptimizationLevel: 'all',
    ...(path ? { externalData: [{ path, data: bytes }] } : {}),
  });
  sessions = {
    prefill: await ort.InferenceSession.create(m.models.prefill, opts('vieneu_backbone_shared.data', m.models.backbone)),
    step: await ort.InferenceSession.create(m.models.step, opts('vieneu_backbone_shared.data', m.models.backbone)),
    acoustic: await ort.InferenceSession.create(m.models.acoustic, opts()),
    codec: await ort.InferenceSession.create(m.models.codec, opts('moss_audio_tokenizer_decode_shared.data', m.models.codecData)),
  };
  // Each codebook's scores for its codes: the acoustic transformer's output against that codebook's embeddings.
  heads = [];
  for (let ch = 0; ch < nVq; ch++) {
    heads.push(await ort.InferenceSession.create(gemmModel(audioRows, H, audioEmb.subarray(ch * audioRows * H, (ch + 1) * audioRows * H)), opts()));
  }
  codecState = m.codecMeta.streaming_decode;
  m.models = null; // the sessions have their own copies
  // The first run of anything is slow: have it now, while the voice is loading, not on the first sentence.
  const warm = 'tʃˈaː2w.'; // "chào."
  await decoder()(await generate(warm, voices.values().next().value, maxFrames(warm), -1));
}

// ── Making the codes ────────────────────────────────────────────────────────

/** Add row `id` of `table` (rows of H) into `out` at `at`. */
function addRow(out, at, table, id) {
  const base = id * H;
  for (let h = 0; h < H; h++) out[at + h] += table[base + h];
}

/** The embedding of one prompt row: a text token, and the 16 codes of a frame if it carries one. */
function embedRow(out, at, textId, codes, anchor) {
  addRow(out, at, textEmb, textId);
  if (codes) for (let ch = 0; ch < nVq; ch++) addRow(out, at, audioEmb.subarray(ch * audioRows * H), codes[ch]);
  for (let h = 0; h < H; h++) out[at + h] += anchor[h];
}

/** The codes picked lately in each codebook, the last REP_WINDOW of them. */
class History {
  constructor() { this.counts = Array.from({ length: nVq }, () => new Map()); this.order = Array.from({ length: nVq }, () => []); }
  add(ch, code) {
    const counts = this.counts[ch], order = this.order[ch];
    counts.set(code, (counts.get(code) || 0) + 1);
    order.push(code);
    if (order.length > REP_WINDOW) {
      const old = order.shift(), n = counts.get(old);
      if (n <= 1) counts.delete(old); else counts.set(old, n - 1);
    }
  }
}

/** Pick codebook `ch`'s code from the acoustic transformer's output `vec`. */
async function sample(ch, vec, history) {
  const logits = (await heads[ch].run({ x: f32(vec, [1, H]) })).y.data;
  for (const code of history.counts[ch].keys()) {
    const l = logits[code];
    logits[code] = l < 0 ? l * REP_PENALTY : l / REP_PENALTY;
  }
  // The TOP_K likeliest, best first.
  const top = [];
  for (let v = 0; v < audioRows; v++) {
    const l = logits[v];
    if (top.length === TOP_K && l <= logits[top[TOP_K - 1]]) continue;
    let i = top.length < TOP_K ? top.length : TOP_K - 1;
    while (i > 0 && logits[top[i - 1]] < l) { if (i < TOP_K) top[i] = top[i - 1]; i--; }
    top[i] = v;
  }
  const max = logits[top[0]] / TEMPERATURE;
  const p = top.map((v) => Math.exp(logits[v] / TEMPERATURE - max));
  const total = p.reduce((a, b) => a + b, 0);
  // Nucleus: keep the best until they hold TOP_P of the chance between them.
  let kept = 0, sum = 0;
  for (; kept < p.length; kept++) { if (sum >= TOP_P * total) break; sum += p[kept]; }
  let r = Math.random() * sum, code = top[kept - 1];
  for (let i = 0; i < kept; i++) { r -= p[i]; if (r <= 0) { code = top[i]; break; } }
  history.add(ch, code);
  return code;
}

/** One 80 ms frame from the backbone's last hidden state `h`. → { codes, end } */
async function frame(h, history) {
  const empty = f32(new Float32Array(0), [1, nHeadsLoc, 0, headDimLoc]);
  const sgs = cfg.speech_generation_start_token_id;
  const first = new Float32Array(2 * H);
  first.set(h, 0);
  first.set(textEmb.subarray(sgs * H, (sgs + 1) * H), H);
  const feed = { token_emb: f32(first, [1, 2, H]), position_ids: i64([0, 1], [1, 2]) };
  for (let i = 0; i < layersLoc; i++) { feed[`past_k_${i}`] = empty; feed[`past_v_${i}`] = empty; }
  let out = await sessions.acoustic.run(feed);
  const slot0 = out.hidden.data.slice(0, H);
  const codes = new Int32Array(nVq);
  codes[0] = await sample(0, out.hidden.data.slice(H, 2 * H), history);
  for (let ch = 1; ch < nVq; ch++) {
    const row = ((ch - 1) * audioRows + codes[ch - 1]) * H;
    const next = { token_emb: f32(audioEmb.slice(row, row + H), [1, 1, H]), position_ids: i64([ch + 1], [1, 1]) };
    for (let i = 0; i < layersLoc; i++) { next[`past_k_${i}`] = out[`present_k_${i}`]; next[`past_v_${i}`] = out[`present_v_${i}`]; }
    out = await sessions.acoustic.run(next);
    codes[ch] = await sample(ch, out.hidden.data.slice(0, H), history);
  }
  // Whether the speech is over: the text head's choice for the first slot.
  let best = -Infinity, bestId = -1;
  for (let id = 0, rows = textEmb.length / H; id < rows; id++) {
    let s = 0;
    for (let k = 0, base = id * H; k < H; k++) s += slot0[k] * textEmb[base + k];
    if (s > best) { best = s; bestId = id; }
  }
  return { codes, end: bestId === cfg.speech_generation_end_token_id };
}

/**
 * The frames of speech for one piece's phonemes in one voice, at most `cap` of them, handed to
 * `onFrames` in groups as they are made (when given). → [Int32Array(16)]
 */
async function generate(phonemes, voice, cap, id, onFrames = null) {
  const ids = [cfg.default_style_token_id ?? 16, cfg.text_prompt_start_token_id, ...encode(phonemes), cfg.text_prompt_end_token_id];
  const T = ids.length + voice.codes.length;
  const prompt = new Float32Array(T * H);
  ids.forEach((tid, i) => embedRow(prompt, i * H, tid, null, voice.anchor));
  voice.codes.forEach((codes, i) => embedRow(prompt, (ids.length + i) * H, cfg.audio_ref_slot_token_id, codes, voice.anchor));
  let out = await sessions.prefill.run({ inputs_embeds: f32(prompt, [1, T, H]) });
  let h = out.hidden.data.slice((T - 1) * H, T * H);
  let past = Array.from({ length: L }, (_, i) => [out[`present_k_${i}`], out[`present_v_${i}`]]);
  const history = new History(), frames = [];
  let handed = 0;
  for (let t = 0; t < cap; t++) {
    if (cancelled.has(id)) return frames;
    const { codes, end } = await frame(h, history);
    frames.push(codes);
    if (end) break;
    if (onFrames && frames.length - handed >= (handed ? NEXT_FRAMES : FIRST_FRAMES)) {
      await onFrames(frames.slice(handed));
      handed = frames.length;
    }
    const row = new Float32Array(H);
    embedRow(row, 0, cfg.speech_generation_start_token_id, codes, voice.anchor);
    const feed = { inputs_embeds: f32(row, [1, 1, H]), position_ids: i64([T + t], [1, 1]) };
    past.forEach(([k, v], i) => { feed[`past_k_${i}`] = k; feed[`past_v_${i}`] = v; });
    out = await sessions.step.run(feed);
    h = out.hidden.data.slice(0, H);
    past = Array.from({ length: L }, (_, i) => [out[`present_k_${i}`], out[`present_v_${i}`]]);
  }
  if (onFrames && frames.length > handed && !cancelled.has(id)) await onFrames(frames.slice(handed));
  return frames;
}

/**
 * The codec, a group of frames at a time (it keeps what it needs of the ones before): each call
 * takes the next frames and gives their waveform, as one channel. Given all of a piece's frames
 * at once, it gives what the whole-piece decoder would.
 */
function decoder() {
  const state = {};
  for (const t of codecState.transformer_offsets) state[t.input_name] = i32(new Int32Array(count(t.shape)), t.shape);
  for (const a of codecState.attention_caches) {
    state[a.offset_input_name] = i32(new Int32Array(count(a.offset_shape)), a.offset_shape);
    state[a.cached_keys_input_name] = f32(new Float32Array(count(a.cache_shape)), a.cache_shape);
    state[a.cached_values_input_name] = f32(new Float32Array(count(a.cache_shape)), a.cache_shape);
    state[a.cached_positions_input_name] = i32(new Int32Array(count(a.positions_shape)).fill(-1), a.positions_shape); // -1: empty
  }
  return async (frames) => {
    const codes = new Int32Array(frames.length * nVq);
    frames.forEach((f, i) => codes.set(f, i * nVq));
    const out = await sessions.codec.run({ audio_codes: i32(codes, [1, frames.length, nVq]), audio_code_lengths: i32(Int32Array.from([frames.length]), [1]), ...state });
    for (const t of codecState.transformer_offsets) state[t.input_name] = out[t.output_name];
    for (const a of codecState.attention_caches) {
      state[a.offset_input_name] = out[a.offset_output_name];
      state[a.cached_keys_input_name] = out[a.cached_keys_output_name];
      state[a.cached_values_input_name] = out[a.cached_values_output_name];
      state[a.cached_positions_input_name] = out[a.cached_positions_output_name];
    }
    const audio = out.audio, channels = audio.dims[1], len = audio.dims[2], n = Math.min(len, Number(out.audio_lengths.data[0]));
    const wav = new Float32Array(n);
    for (let c = 0; c < channels; c++) for (let i = 0; i < n; i++) wav[i] += audio.data[c * len + i] / channels;
    return wav;
  };
}

// ── The package's guard against short pieces saying more (core_utils.py) ────

/** How many bursts of sound there are: about one a syllable. */
function bursts(wav) {
  const hop = Math.round(RATE * 0.01), n = Math.floor(wav.length / hop);
  const env = new Float32Array(n);
  let peak = 0;
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let j = i * hop; j < (i + 1) * hop; j++) s += wav[j] * wav[j];
    env[i] = Math.sqrt(s / hop);
    peak = Math.max(peak, env[i]);
  }
  if (peak <= 1e-6) return 0;
  const on = peak * 10 ** (-18 / 20);
  let n2 = 0, start = -1, last = -1;
  const close = () => { if (start >= 0 && last - start + 1 >= 3) n2++; };
  for (let i = 0; i < n; i++) {
    if (env[i] <= on) continue;
    if (start < 0) start = i;
    else if (i - last > 6) { close(); start = i; }
    last = i;
  }
  close();
  return n2;
}

/** Whether a short piece seems to have said more than it was given. → [suspect, bursts, frames] */
function suspect(wav, phonemes, cap, frames) {
  const syl = syllableCount(phonemes);
  if (syl === 0 || syl > 3 || phonemes.includes('<|emotion_')) return [false, 0, frames];
  const b = bursts(wav);
  return [b > syl || (syl <= 2 && frames >= cap - 1), b, frames];
}

const better = (a, b) => (a[0] !== b[0] ? !a[0] : a[1] < b[1] || (a[1] === b[1] && a[2] < b[2]));

// ── The silence around speech ───────────────────────────────────────────────

const firstLoud = (x) => x.findIndex((v) => Math.abs(v) > QUIET);
const lastLoud = (x) => { for (let i = x.length - 1; i >= 0; i--) if (Math.abs(x[i]) > QUIET) return i; return -1; };
const clip = (x) => { for (let i = 0; i < x.length; i++) x[i] = Math.max(-1, Math.min(1, x[i])); return x; };
function fade(x, atStart, atEnd) {
  const n = Math.min(Math.round(RATE * 0.005), x.length >> 1);
  for (let i = 0; i < n; i++) {
    const ramp = 0.5 - 0.5 * Math.cos(Math.PI * i / n);
    if (atStart) x[i] *= ramp;
    if (atEnd) x[x.length - 1 - i] *= ramp;
  }
  return x;
}

/** Cut the silence the codec leaves around speech, short of the breath on either side, and soften the ends. */
function trim(wav) {
  const a = firstLoud(wav);
  if (a < 0) return new Float32Array(0);
  return fade(clip(wav.slice(Math.max(0, a - KEEP), Math.min(wav.length, lastLoud(wav) + 1 + KEEP))), true, true);
}

/**
 * Speech passed on (`post`) as it is decoded, trimmed as `trim` trims a whole piece: nothing
 * until it starts, and the last moments held back until it is known whether they are the end.
 * The first part waits until it lasts long enough (`lead` seconds) to play while the next is made.
 */
function streamer(post, lead) {
  let held = new Float32Array(0), started = false, posted = false;
  return {
    push(wav) {
      let x = new Float32Array(held.length + wav.length);
      x.set(held);
      x.set(wav, held.length);
      if (!started) {
        const a = firstLoud(x);
        if (a < 0) { held = x.slice(Math.max(0, x.length - KEEP)); return; }
        x = fade(x.slice(Math.max(0, a - KEEP)), true, false);
        started = true;
      }
      const ready = x.length - HOLD;
      if (ready > 0 && (posted || ready >= lead * RATE)) {
        post(clip(x.slice(0, ready)));
        held = x.slice(ready);
        posted = true;
      } else held = x;
    },
    end() {
      if (started) post(fade(clip(held.slice(0, Math.min(held.length, lastLoud(held) + 1 + KEEP))), false, true));
    },
  };
}

/**
 * One piece's phonemes said by a voice. With `post`, a piece long enough not to need the guard
 * goes out as it is made, while this machine makes speech well ahead of playing it. → its audio,
 * or null if it went out
 */
async function synthOne(phonemes, voice, id, post = null) {
  const cap = maxFrames(phonemes), t0 = performance.now(), decode = decoder();
  const took = (frames) => { pace = (performance.now() - t0) / 1000 / Math.max(0.1, frames * 0.08); };
  if (post && syllableCount(phonemes) > 3 && pace < STREAM_BELOW) {
    // Enough to cover making the next group of frames, with room to spare (a first piece guesses this machine's pace).
    const out = streamer(post, Math.max(0.35, 1.3 * NEXT_FRAMES * 0.08 * (pace || 0.5) + 0.1));
    const frames = await generate(phonemes, voice, cap, id, async (some) => out.push(await decode(some)));
    out.end();
    took(frames.length);
    return null;
  }
  let frames = await generate(phonemes, voice, cap, id);
  if (!frames.length) return new Float32Array(0);
  let wav = await decode(frames), best = suspect(wav, phonemes, cap, frames.length);
  took(frames.length);
  for (let tries = 0; best[0] && tries < BABBLE_RETRIES && !cancelled.has(id); tries++) {
    const again = await generate(phonemes, voice, cap, id);
    if (!again.length) continue;
    const w = await decoder()(again), verdict = suspect(w, phonemes, cap, again.length);
    if (better(verdict, best)) { frames = again; wav = w; best = verdict; }
  }
  return trim(wav);
}

/**
 * A sentence, given as the phonemes of its pieces, said by a voice. → Float32Array at RATE.
 * With `stream`, the audio is posted in parts as it is made instead (`{ id, part }` messages),
 * and what is returned is empty.
 */
async function synth({ phonemes, voice, id, stream }) {
  const v = voices.get(voice) ?? voices.values().next().value;
  const parts = [];
  const post = stream ? (part) => { if (part.length && !cancelled.has(id)) self.postMessage({ id, part }, [part.buffer]); } : (part) => parts.push(part);
  let first = true;
  for (const ph of phonemes) {
    if (cancelled.has(id)) break;
    if (!ph.trim()) continue;
    if (!first) post(new Float32Array(Math.round(RATE * 0.12))); // between the pieces of a long sentence
    first = false;
    const wav = await synthOne(ph, v, id, stream ? post : null);
    if (wav) post(wav);
  }
  const pcm = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { pcm.set(p, at); at += p.length; }
  return pcm;
}

self.onmessage = ({ data: m }) => {
  if (m.type === 'cancel') { cancelled.add(m.id); return; }
  queue = queue.then(async () => {
    try {
      if (m.type === 'init') {
        await init(m);
        self.postMessage({ id: m.id });
      } else if (cancelled.delete(m.id)) {
        self.postMessage({ id: m.id, error: 'cancelled' });
      } else {
        const pcm = await synth(m);
        if (cancelled.delete(m.id)) { self.postMessage({ id: m.id, error: 'cancelled' }); return; }
        self.postMessage({ id: m.id, pcm }, [pcm.buffer]);
      }
    } catch (e) {
      self.postMessage({ id: m.id, error: String(e?.message || e) });
    }
  });
};
