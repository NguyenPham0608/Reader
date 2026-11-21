// The worker behind neural.js's Supertonic voices. Supertonic reads the text's characters
// directly (no phonemes): it predicts how long the sentence lasts, shapes noise of that length
// into sound features over a few steps, and turns those into a waveform.

import * as ort from './vendor/piper/ort.wasm.bundle.min.mjs';

const STEPS = 8;       // more is slower and barely better; fewer starts to slur
const MAX_CHARS = 300; // beyond this the model starts skipping words

let cfg, indexer, sessions;
const styles = new Map();
const cancelled = new Set();
let queue = Promise.resolve();

async function init(m) {
  ({ cfg, indexer } = m);
  ort.env.wasm.wasmBinary = m.ortWasm;
  // Threads need the page to be cross-origin isolated, which the reader's own server arranges.
  ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(8, navigator.hardwareConcurrency || 1) : 1;
  sessions = {};
  for (const name of ['duration_predictor', 'text_encoder', 'vector_estimator', 'vocoder']) {
    sessions[name] = await ort.InferenceSession.create(m.models[name], { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
    m.models[name] = null; // the session has its own copy
  }
}

const tensor = (data, dims) => new ort.Tensor('float32', data, dims);

/** Text as the model wants it: plain characters, closed by punctuation, wrapped in its language. */
function prepare(text, lang) {
  text = text.normalize('NFKD')
    .replace(/[–‑—]/g, '-').replace(/[“”]/g, '"').replace(/[‘’´`]/g, "'")
    .replace(/[_[\]|/#→←]/g, ' ').replace(/\s+([,.!?;:])/g, '$1').replace(/\s+/g, ' ').trim();
  if (!/[.!?;:,'")\]}…]$/.test(text)) text += '.';
  return `<${lang}>${text}</${lang}>`;
}

/** Split what is too long for one pass at a comma or, failing that, a space. */
function pieces(text) {
  const out = [];
  while (text.length > MAX_CHARS) {
    const head = text.slice(0, MAX_CHARS);
    const cut = Math.max(head.lastIndexOf(', ') + 1, head.lastIndexOf('; ') + 1) || head.lastIndexOf(' ') || MAX_CHARS;
    out.push(text.slice(0, cut).trim());
    text = text.slice(cut).trim();
  }
  if (text) out.push(text);
  return out;
}

async function synthOne(text, lang, style, speed) {
  const ids = Array.from(prepare(text, lang), (c) => indexer[c.codePointAt(0)] ?? -1).filter((id) => id >= 0);
  const n = ids.length;
  const textIds = new ort.Tensor('int64', BigInt64Array.from(ids, (id) => BigInt(id)), [1, n]);
  const textMask = tensor(new Float32Array(n).fill(1), [1, 1, n]);
  const { duration } = await sessions.duration_predictor.run({ text_ids: textIds, style_dp: style.dp, text_mask: textMask });
  const seconds = duration.data[0] / speed;
  const { text_emb: textEmb } = await sessions.text_encoder.run({ text_ids: textIds, style_ttl: style.ttl, text_mask: textMask });

  const rate = cfg.ae.sample_rate;
  const chunk = cfg.ae.base_chunk_size * cfg.ttl.chunk_compress_factor, dim = cfg.ttl.latent_dim * cfg.ttl.chunk_compress_factor;
  const length = Math.max(1, Math.ceil(Math.floor(seconds * rate) / chunk));
  let latent = new Float32Array(dim * length);
  for (let i = 0; i < latent.length; i++) latent[i] = Math.sqrt(-2 * Math.log(Math.max(1e-4, Math.random()))) * Math.cos(2 * Math.PI * Math.random());
  const latentMask = tensor(new Float32Array(length).fill(1), [1, 1, length]);
  const totalStep = tensor(Float32Array.from([STEPS]), [1]);
  for (let step = 0; step < STEPS; step++) {
    const out = await sessions.vector_estimator.run({
      noisy_latent: tensor(latent, [1, dim, length]), text_emb: textEmb, style_ttl: style.ttl,
      latent_mask: latentMask, text_mask: textMask, current_step: tensor(Float32Array.from([step]), [1]), total_step: totalStep,
    });
    latent = out.denoised_latent.data;
  }
  const { wav_tts: wav } = await sessions.vocoder.run({ latent: tensor(latent, [1, dim, length]) });
  return trim(wav.data.subarray(0, Math.floor(seconds * rate)), rate);
}

/** The model pads each sentence with about half a second of near-silence at either end; keep a breath of it. */
function trim(pcm, rate) {
  const quiet = 0.012, win = Math.round(rate * 0.01);
  const loud = (at) => { let peak = 0; for (let i = at; i < Math.min(pcm.length, at + win); i++) peak = Math.max(peak, Math.abs(pcm[i])); return peak > quiet; };
  let a = 0, b = pcm.length;
  while (a < b && !loud(a)) a += win;
  while (b > a && !loud(b - win)) b -= win;
  return pcm.subarray(Math.max(0, a - Math.round(rate * 0.04)), Math.min(pcm.length, b + Math.round(rate * 0.14)));
}

async function synth({ text, voice, lang, speed }) {
  const style = styles.get(voice);
  const parts = [];
  for (const piece of pieces(text)) parts.push(await synthOne(piece, lang, style, speed));
  const pcm = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { pcm.set(p, at); at += p.length; }
  return pcm;
}

self.onmessage = ({ data: m }) => {
  if (m.type === 'cancel') { cancelled.add(m.id); return; }
  if (m.type === 'style') { styles.set(m.voice, { ttl: tensor(m.ttl, m.ttlDims), dp: tensor(m.dp, m.dpDims) }); return; }
  queue = queue.then(async () => {
    try {
      if (m.type === 'init') {
        await init(m);
        self.postMessage({ id: m.id });
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
