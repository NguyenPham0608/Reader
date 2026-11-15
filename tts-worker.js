// Runs the Kokoro neural voice off the main thread so the page never stutters.
import { KokoroTTS, env } from './vendor/kokoro/kokoro.web.js';

env.wasmPaths = new URL('./vendor/ort/', import.meta.url).href;

const MODEL = 'onnx-community/Kokoro-82M-v1.0-ONNX';
let tts = null;
let chain = Promise.resolve();

async function hasWebGPU() {
  try { return !!(self.navigator?.gpu && await navigator.gpu.requestAdapter()); } catch { return false; }
}

// Measured on Apple silicon: full precision on the GPU voices ~7x faster than real time and on
// the CPU ~2.5x; the smaller 8-bit model only manages ~1.1x, which leaves gaps between sentences.
async function start(device, voice, progress_callback) {
  const model = await KokoroTTS.from_pretrained(MODEL, { dtype: 'fp32', device, progress_callback });
  // Warm up (compiles GPU shaders, fetches the voice) and check the output is real audio.
  const out = await model.generate('Ready.', { voice });
  let peak = 0;
  for (const v of out.audio) { if (Number.isNaN(v)) throw new Error('Voice produced invalid audio'); peak = Math.max(peak, Math.abs(v)); }
  if (peak < 0.01) throw new Error('Voice produced silence');
  return model;
}

async function load(voice) {
  const files = new Map();
  let lastPost = 0;
  const progress = (p) => {
    if (p.status !== 'progress' || !p.total) return;
    files.set(p.file, [p.loaded, p.total]);
    const now = performance.now();
    if (now - lastPost < 80 && p.loaded < p.total) return;
    lastPost = now;
    let loaded = 0, total = 0;
    for (const [l, t] of files.values()) { loaded += l; total += t; }
    postMessage({ type: 'progress', loaded, total });
  };
  let device = (await hasWebGPU()) ? 'webgpu' : 'wasm';
  try {
    tts = await start(device, voice, progress);
  } catch (e) {
    if (device !== 'webgpu') throw e;
    console.warn('GPU voice unavailable, using the CPU instead:', e);
    device = 'wasm';
    tts = await start(device, voice, progress);
  }
  postMessage({ type: 'ready', device });
}

async function handle(d) {
  if (d.type === 'load') {
    try { await load(d.voice); }
    catch (e) { tts = null; postMessage({ type: 'load-error', message: String(e?.message ?? e) }); }
    return;
  }
  if (d.type === 'generate') {
    try {
      if (!tts) throw new Error('Voice model is not loaded');
      const t0 = performance.now();
      const out = await tts.generate(d.text, { voice: d.voice, speed: d.speed });
      const audio = out.audio;
      postMessage(
        { type: 'audio', id: d.id, idx: d.idx, audio, rate: out.sampling_rate, ms: performance.now() - t0 },
        [audio.buffer],
      );
    } catch (e) {
      postMessage({ type: 'gen-error', id: d.id, idx: d.idx, message: String(e?.message ?? e) });
    }
  }
}

self.onmessage = ({ data }) => {
  chain = chain.then(() => handle(data));
};
