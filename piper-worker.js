// The worker behind neural.js: turns text into phonemes with espeak-ng (as Piper's own tools do),
// then phonemes into sound with the voice's model.

import * as ort from './vendor/piper/ort.wasm.bundle.min.mjs';
import createPhonemizer from './vendor/piper/piper_phonemize.mjs';

let config, session, phonemizer;
const printed = [];
const cancelled = new Set();
let queue = Promise.resolve();

async function init({ config: c, model, ortWasm, ppWasm, ppData }) {
  config = c;
  ort.env.wasm.wasmBinary = ortWasm;
  // Threads need the page to be cross-origin isolated, which the reader's own server arranges.
  ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;
  phonemizer = await createPhonemizer({
    wasmBinary: ppWasm,
    noInitialRun: true,
    getPreloadedPackage: () => (ppData.byteLength === ppData.buffer.byteLength ? ppData.buffer : ppData.slice().buffer),
    print: (line) => printed.push(line),
    printErr: () => {},
  });
  session = await ort.InferenceSession.create(model, { executionProviders: ['wasm'] });
}

/** Text → the ids of its phonemes in one language, as the model was trained on them: ^ (1), then each phoneme followed by a pad (0), then $ (2). */
function phonemesIn(text, lang) {
  printed.length = 0;
  phonemizer.callMain(['-l', lang, '--input', JSON.stringify([{ text }]), '--espeak_data', '/espeak-ng-data']);
  return printed.flatMap((line) => { try { return JSON.parse(line).phoneme_ids || []; } catch { return []; } });
}

// AI, GDP, mRNA, U.S.: capitals that a voice in another language would spell out in its own
// letters, or read as a word of its own. These are said the English way instead.
const ABBREVIATION = /(?<![\p{L}\p{N}])(?:[a-z]?[A-Z][A-Z0-9]*[A-Z][A-Z0-9]*s?|(?:[A-Z]\.){2,})(?![\p{L}\p{N}])/gu;
const SPACE = 3;

function phonemeIds(text) {
  const own = config.espeak.voice;
  const found = own.startsWith('en') ? [] : [...text.matchAll(ABBREVIATION)];
  // With no lower case left around them, the capitals are a heading rather than abbreviations.
  if (!found.length || !/\p{Ll}/u.test(text.replace(ABBREVIATION, ''))) return phonemesIn(text, own);
  const out = [];
  const add = (part, lang) => {
    if (!/[\p{L}\p{N}]/u.test(part)) return;
    const ids = phonemesIn(part, lang).filter((id, i, all) => id > 2 || (id === 0 && all[i - 1] > 2)); // its phonemes and their pads
    if (ids.length) out.push(...(out.length ? [SPACE, 0] : []), ...ids);
  };
  let at = 0;
  for (const m of found) {
    add(text.slice(at, m.index), own);
    add(m[0], 'en-us');
    at = m.index + m[0].length;
  }
  add(text.slice(at), own);
  return [1, 0, ...out, 2];
}

async function synth(text) {
  const ids = phonemeIds(text);
  if (!ids.length) return new Float32Array(0);
  const { noise_scale, length_scale, noise_w } = config.inference;
  const out = await session.run({
    input: new ort.Tensor('int64', BigInt64Array.from(ids, (id) => BigInt(id)), [1, ids.length]),
    input_lengths: new ort.Tensor('int64', BigInt64Array.from([BigInt(ids.length)]), [1]),
    scales: new ort.Tensor('float32', Float32Array.from([noise_scale, length_scale, noise_w]), [3]),
  });
  const pcm = new Float32Array(out.output.data);
  // Every sentence at the same level, as Piper itself does.
  let peak = 0.01;
  for (let i = 0; i < pcm.length; i++) peak = Math.max(peak, Math.abs(pcm[i]));
  for (let i = 0; i < pcm.length; i++) pcm[i] *= 0.9 / peak;
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
        const pcm = await synth(m.text);
        cancelled.delete(m.id);
        self.postMessage({ id: m.id, pcm }, [pcm.buffer]);
      }
    } catch (e) {
      self.postMessage({ id: m.id, error: String(e?.message || e) });
    }
  });
};
