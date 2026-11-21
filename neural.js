// Neural voices for languages the reader's own speech model doesn't cover. Each runs in a worker
// on ONNX Runtime; like the English voices, nothing that is read leaves the page. A voice's model
// is downloaded the first time it is used and kept by the browser after that.
//
// Three kinds: Supertonic (github.com/supertone-inc/supertonic), the largest and the default;
// VieNeu (github.com/pnnbao97/VieNeu-TTS), made for Vietnamese; and Piper
// (github.com/rhasspy/piper), far smaller and plainer.

import { fetchBytes } from './vendor/phonon/fetch.js';

const ORT_WASM = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.31.1/dist/ort-wasm-simd-threaded.wasm'; // must match vendor/piper/ort.wasm.bundle.min.mjs
const SUPERTONIC = 'https://huggingface.co/Supertone/supertonic-3/resolve/main/';
// Pinned to the revision vendor/vieneu/voices.json was taken from: the voices only fit the model they came with.
const VIENEU = 'https://huggingface.co/pnnbao-ump/VieNeu-TTS-v3-Nano/resolve/aba295eb96a6fa6003ebe417cc1f2802a7adc1dc/';
const PIPER_MODELS = 'https://huggingface.co/rhasspy/piper-voices/resolve/main/';
const PHONEMIZER = 'https://cdn.jsdelivr.net/npm/@diffusionstudio/piper-wasm@1.0.0/build/piper_phonemize'; // espeak-ng, and its language data

const supertonic = (style, name) => ({
  id: `supertonic-${style}`, engine: 'supertonic', style, name, tags: 'Natural', megabytes: 400,
  about: 'The fullest-sounding, and at ease with English names. Supertonic 3 (OpenRAIL-M).',
});
const vieneu = (name, tags) => ({
  id: `vieneu-${name}`, engine: 'vieneu', voice: name, name, tags, megabytes: 290,
  about: 'A lighter model made for Vietnamese; steadier on long sentences. VieNeu-TTS v3 Nano (Apache-2.0).',
});

/**
 * The voices, by language, the default first. `tag` is what Claude translates into; `megabytes`
 * is the first download, which voices of the same engine share.
 */
export const NEURAL_VOICES = {
  vi: [
    ...[['F1', 'Female 1'], ['F2', 'Female 2'], ['F3', 'Female 3'], ['F4', 'Female 4'], ['F5', 'Female 5'],
      ['M1', 'Male 1'], ['M2', 'Male 2'], ['M3', 'Male 3'], ['M4', 'Male 4'], ['M5', 'Male 5']].map(([style, name]) => supertonic(style, name)),
    vieneu('Minh Quân', 'Male · Northern · Natural'),
    vieneu('Trúc Ly', 'Female · Northern · Natural'),
    vieneu('Mạnh Dũng', 'Male · Northern · Natural'),
    vieneu('Mai Anh', 'Female · Northern · News'),
    vieneu('Xuân Tiên', 'Female · Northern · News'),
    vieneu('Hữu Quân', 'Male · Northern · News'),
    vieneu('Mỹ Duyên', 'Female · Northern · Storytelling'),
    vieneu('Đức Trí', 'Male · Northern · Storytelling'),
    vieneu('Anh Khôi', 'Male · Northern · Storytelling'),
    vieneu('Ái Hân', 'Female · Southern · News'),
    vieneu('Adam', 'Male · Southern · Natural'),
    {
      id: 'piper-vais1000', engine: 'piper', name: 'Compact', tags: 'Plainer · Small download', megabytes: 75,
      file: 'vi/vi_VN/vais1000/medium/vi_VN-vais1000-medium.onnx',
      about: 'Clear but flatter. Piper, trained on the VAIS-1000 corpus (CC BY 4.0).',
    },
  ].map((v) => ({ ...v, lang: 'vi', tag: 'vi-VN' })),
};

/** What has to be loaded for a voice: voices with the same key share it. */
export const engineKey = (spec) => `${spec.engine}:${spec.file || ''}`;

/** Download what a voice runs on and get it ready to speak. `onProgress` follows the download. */
export const loadNeural = (spec, options) => ({ supertonic: SupertonicVoice, vieneu: VieneuVoice }[spec.engine] ?? PiperVoice).load(spec, options);

const json = (bytes) => JSON.parse(new TextDecoder().decode(bytes));

/** Fetch several files, reporting progress across all of them. `sizes` are rough, in megabytes, for the files not yet started. */
async function fetchAll(urls, sizes, onProgress) {
  const loaded = urls.map(() => 0), total = sizes.map((mb) => mb * 1e6);
  return Promise.all(urls.map((url, i) => fetchBytes(url, {
    onProgress: (p) => {
      loaded[i] = p.loaded;
      if (p.total) total[i] = Math.max(p.total, p.loaded);
      onProgress?.({ loaded: loaded.reduce((a, b) => a + b), total: total.reduce((a, b) => a + b) });
    },
  })));
}

class WorkerVoice {
  jobs = new Map();
  seq = 0;

  start(script) {
    this.worker = new Worker(new URL(script, import.meta.url), { type: 'module' });
    this.worker.onmessage = ({ data }) => {
      const job = this.jobs.get(data.id);
      this.jobs.delete(data.id);
      if (data.error) job?.reject(new Error(data.error)); else job?.resolve(data.pcm);
    };
    this.worker.onerror = (e) => {
      for (const job of this.jobs.values()) job.reject(new Error(e.message || 'The voice stopped working.'));
      this.jobs.clear();
    };
  }

  ask(message, transfer = []) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.jobs.set(id, { resolve, reject });
      this.worker.postMessage({ ...message, id }, transfer);
    });
  }

  /** Ask the worker for a sentence, letting go of it if `signal` fires first. */
  request(message, signal) {
    if (signal?.aborted) return Promise.reject(signal.reason);
    const done = this.ask(message);
    const id = this.seq;
    return new Promise((resolve, reject) => {
      // Sentences queue up in the worker; one nobody is waiting for any more is dropped unspoken.
      const stop = () => { this.worker.postMessage({ type: 'cancel', id }); reject(signal.reason); };
      signal?.addEventListener('abort', stop, { once: true });
      done.then(resolve, reject).finally(() => signal?.removeEventListener('abort', stop));
    });
  }

  dispose() {
    this.worker?.terminate();
    this.worker = null;
  }
}

class SupertonicVoice extends WorkerVoice {
  styles = new Map();

  /** The pace it will speak at when asked for `speed`: outside this range it loses words, so the caller stretches the rest. */
  pace(speed) { return Math.min(1.15, Math.max(1, speed)); }

  static async load(spec, { onProgress } = {}) {
    const names = ['duration_predictor', 'text_encoder', 'vector_estimator', 'vocoder'];
    const [cfg, indexer, ortWasm, ...files] = await fetchAll(
      [`${SUPERTONIC}onnx/tts.json`, `${SUPERTONIC}onnx/unicode_indexer.json`, ORT_WASM, ...names.map((n) => `${SUPERTONIC}onnx/${n}.onnx`)],
      [0, 0.3, 12, 4, 36, 257, 101], onProgress);
    const voice = new SupertonicVoice();
    voice.sampleRate = json(cfg).ae.sample_rate;
    voice.start('./supertonic-worker.js');
    try {
      const models = Object.fromEntries(names.map((n, i) => [n, files[i]]));
      await voice.ask({ type: 'init', cfg: json(cfg), indexer: json(indexer), ortWasm, models }, [ortWasm.buffer, ...files.map((f) => f.buffer)]);
    } catch (e) {
      voice.dispose();
      throw e;
    }
    return voice;
  }

  /** Speak one piece of text in a voice of this engine. → Float32Array of samples at `sampleRate` */
  async synth(text, spec, { signal, speed = 1 } = {}) {
    if (!this.styles.has(spec.style)) {
      this.styles.set(spec.style, fetchBytes(`${SUPERTONIC}voice_styles/${spec.style}.json`).then((bytes) => {
        const { style_ttl: ttl, style_dp: dp } = json(bytes);
        this.worker.postMessage({ type: 'style', voice: spec.style, ttl: Float32Array.from(ttl.data.flat(Infinity)), ttlDims: ttl.dims, dp: Float32Array.from(dp.data.flat(Infinity)), dpDims: dp.dims });
      }));
      this.styles.get(spec.style).catch(() => this.styles.delete(spec.style));
    }
    await this.styles.get(spec.style);
    return this.request({ type: 'synth', text, voice: spec.style, lang: spec.lang, speed: this.pace(speed) }, signal);
  }
}

class VieneuVoice extends WorkerVoice {
  sampleRate = 24000;

  /** The pace it will speak at when asked for `speed`: pushed further, it starts dropping words, so the caller stretches the rest. */
  pace(speed) { return Math.min(1.15, Math.max(0.85, speed)); }

  static async load(spec, { onProgress } = {}) {
    const names = ['text_encoder', 'duration_predictor', 'vector_estimator', 'codec_decoder'];
    const [cfg, ortWasm, ppWasm, ppData, ...files] = await fetchAll(
      [`${VIENEU}config.json`, ORT_WASM, `${PHONEMIZER}.wasm`, `${PHONEMIZER}.data`, ...names.map((n) => `${VIENEU}${n}.onnx`)],
      [0, 12, 0.6, 18, 27, 1, 155, 99], onProgress);
    const voices = await (await fetch(new URL('./vendor/vieneu/voices.json', import.meta.url))).json();
    const voice = new VieneuVoice();
    voice.start('./vieneu-worker.js');
    try {
      const models = Object.fromEntries(names.map((n, i) => [n, files[i]]));
      await voice.ask({ type: 'init', cfg: json(cfg), voices, ortWasm, ppWasm, ppData, models }, [ortWasm.buffer, ppWasm.buffer, ppData.buffer, ...files.map((f) => f.buffer)]);
    } catch (e) {
      voice.dispose();
      throw e;
    }
    return voice;
  }

  /** Speak one piece of text in a voice of this engine. → Float32Array of samples at `sampleRate` */
  synth(text, spec, { signal, speed = 1 } = {}) {
    return this.request({ type: 'synth', text, voice: spec.voice, speed: this.pace(speed) }, signal);
  }
}

class PiperVoice extends WorkerVoice {
  /** One pace only: the caller stretches the audio for other speeds. */
  pace() { return 1; }

  static async load(spec, { onProgress } = {}) {
    const url = PIPER_MODELS + spec.file;
    const [config, model, ortWasm, ppWasm, ppData] = await fetchAll(
      [`${url}.json`, url, ORT_WASM, `${PHONEMIZER}.wasm`, `${PHONEMIZER}.data`], [0, 63, 12, 0.6, 18], onProgress);
    const voice = new PiperVoice();
    voice.sampleRate = json(config).audio.sample_rate;
    voice.start('./piper-worker.js');
    try {
      await voice.ask({ type: 'init', config: json(config), model, ortWasm, ppWasm, ppData }, [model.buffer, ortWasm.buffer, ppWasm.buffer, ppData.buffer]);
    } catch (e) {
      voice.dispose();
      throw e;
    }
    return voice;
  }

  synth(text, spec, { signal } = {}) {
    return this.request({ type: 'synth', text }, signal);
  }
}
