// Neural voices for languages the reader's own speech model doesn't cover. Each is a Piper model
// (github.com/rhasspy/piper) run in a worker by ONNX Runtime; like the English voices, nothing
// that is read leaves the page. The model and the two engines it needs are downloaded the first
// time a voice is used and kept by the browser after that.

import { fetchBytes } from './vendor/phonon/fetch.js';

const MODELS = 'https://huggingface.co/rhasspy/piper-voices/resolve/main/';
const ORT_WASM = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.31.1/dist/ort-wasm-simd-threaded.wasm'; // must match vendor/piper/ort.wasm.bundle.min.mjs
const PHONEMIZER = 'https://cdn.jsdelivr.net/npm/@diffusionstudio/piper-wasm@1.0.0/build/piper_phonemize'; // espeak-ng, and its language data

/** The voices, by language. `tag` is what Claude translates into; `megabytes` is the first download. */
export const PIPER_VOICES = {
  vi: {
    tag: 'vi-VN',
    name: 'Neural',
    file: 'vi/vi_VN/vais1000/medium/vi_VN-vais1000-medium.onnx',
    megabytes: 75,
    about: 'A neural voice that runs in this page. Trained on the VAIS-1000 corpus (CC BY 4.0).',
  },
};

export class PiperVoice {
  /** Download a voice and get it ready to speak. `onProgress` follows the model, which is nearly all of the download. */
  static async load(spec, { onProgress } = {}) {
    const url = MODELS + spec.file;
    const [config, model, ortWasm, ppWasm, ppData] = await Promise.all([
      fetchBytes(`${url}.json`).then((b) => JSON.parse(new TextDecoder().decode(b))),
      fetchBytes(url, { onProgress }),
      fetchBytes(ORT_WASM),
      fetchBytes(`${PHONEMIZER}.wasm`),
      fetchBytes(`${PHONEMIZER}.data`),
    ]);
    const self = new PiperVoice();
    self.sampleRate = config.audio.sample_rate;
    self.worker = new Worker(new URL('./piper-worker.js', import.meta.url), { type: 'module' });
    self.worker.onmessage = ({ data }) => {
      const job = self.jobs.get(data.id);
      self.jobs.delete(data.id);
      if (data.error) job?.reject(new Error(data.error)); else job?.resolve(data.pcm);
    };
    self.worker.onerror = (e) => {
      for (const job of self.jobs.values()) job.reject(new Error(e.message || 'The voice stopped working.'));
      self.jobs.clear();
    };
    try {
      await self.ask({ type: 'init', config, model, ortWasm, ppWasm, ppData }, [model.buffer, ortWasm.buffer, ppWasm.buffer, ppData.buffer]);
    } catch (e) {
      self.dispose();
      throw e;
    }
    return self;
  }

  jobs = new Map();
  seq = 0;

  ask(message, transfer = []) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.jobs.set(id, { resolve, reject });
      this.worker.postMessage({ ...message, id }, transfer);
    });
  }

  /** Speak one piece of text. → Float32Array of samples at `sampleRate` */
  synth(text, signal) {
    if (signal?.aborted) return Promise.reject(signal.reason);
    const done = this.ask({ type: 'synth', text });
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
