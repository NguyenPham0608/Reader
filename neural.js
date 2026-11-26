// The Vietnamese voices: two of VieNeu-TTS v3 Turbo's (github.com/pnnbao97/VieNeu-TTS,
// Apache-2.0), made for Vietnamese and at ease with English words. The model runs in a worker
// on ONNX Runtime, so nothing that is read leaves the page, except to the reader's own server,
// which writes the phonemes the model reads (with sea-g2p, its own front end). The model is
// downloaded the first time and kept by the browser after that.
//
// Where it can't run (a phone, which hasn't the memory; a server that can't write phonemes),
// the system's own voice for the language speaks instead.

import { fetchBytes } from './vendor/phonon/fetch.js';
import { ai } from './ai.js';
import { turboPieces, englishAbbreviations } from './vieneu-turbo-lib.js';

const ORT_WASM = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.31.1/dist/ort-wasm-simd-threaded.wasm'; // must match vendor/onnxruntime/ort.wasm.bundle.min.mjs
// Pinned: vendor/vieneu-turbo/voices.json came with this revision, and the voices only fit the model they came with.
const VIENEU_TURBO = 'https://huggingface.co/pnnbao-ump/VieNeu-TTS-v3-Turbo/resolve/61b85e3d937fbbacb387714180e8182823512523/onnx_update/';
const MOSS_CODEC = 'https://huggingface.co/OpenMOSS-Team/MOSS-Audio-Tokenizer-Nano-ONNX/resolve/ceff0d0749bfb3fa2d61149794ec6feef0d1e1ae/';

const turbo = (voice, tags, name = voice) => ({
  id: `turbo-${voice}`, engine: 'turbo', voice, name, tags, megabytes: 530, lang: 'vi', tag: 'vi-VN',
  about: 'VieNeu-TTS v3 Turbo, made for Vietnamese and at ease with English words (Apache-2.0).',
});

/** The voices, by language, the default first. `tag` is what Claude translates into; `megabytes` the first download, which they share. */
export const NEURAL_VOICES = {
  vi: [turbo('Trúc Ly', 'Female · Northern'), turbo('Adam', 'Male · Southern')],
};

// The model takes about a gigabyte of memory while it runs: more than a phone can spare.
const roomy = !/Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent) && (navigator.deviceMemory ?? 8) >= 4;

/** Whether a voice can be used here: on a computer, with a server that writes phonemes (assumed, until it has said). */
export const usableVoice = () => roomy && (!ai.checked || ai.phonemes);

/** What has to be loaded for a voice: voices with the same key share it. */
export const engineKey = (spec) => spec.engine;

/** Download what a voice runs on and get it ready to speak. `onProgress` follows the download. */
export const loadNeural = (spec, options) => TurboVoice.load(spec, options);

/** Have the phonemes of sentences about to be read written now, so that saying them needn't wait for the server. */
export function phonemesAhead(texts) {
  if (ai.phonemes && texts.length) ai.phonemize(texts.flatMap((t) => turboPieces(t)).map(englishAbbreviations)).catch(() => {});
}

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

class TurboVoice {
  jobs = new Map();
  seq = 0;
  sampleRate = 48000;
  streams = true; // can hand over a sentence in parts as it is made

  /** One pace only: the caller stretches the audio for other speeds. */
  pace() { return 1; }

  static async load(spec, { onProgress } = {}) {
    const names = ['config.json', 'tokenizer.json', 'vieneu_v3_heads.npz', 'vieneu_prefill.onnx', 'vieneu_decode_step.onnx', 'vieneu_acoustic_cached.onnx', 'vieneu_backbone_shared.data'];
    const codecNames = ['codec_browser_onnx_meta.json', 'moss_audio_tokenizer_decode_step.onnx', 'moss_audio_tokenizer_decode_shared.data'];
    const [cfg, tokenizer, heads, prefill, step, acoustic, backbone, codecMeta, codec, codecData, ortWasm] = await fetchAll(
      [...names.map((n) => VIENEU_TURBO + n), ...codecNames.map((n) => MOSS_CODEC + n), ORT_WASM],
      [0, 0, 52, 0.3, 0.3, 7, 415, 0, 0.4, 44, 12], onProgress);
    const { voices } = await (await fetch(new URL('./vendor/vieneu-turbo/voices.json', import.meta.url))).json();
    const voice = new TurboVoice();
    voice.start('./vieneu-turbo-worker.js');
    try {
      const models = { prefill, step, acoustic, backbone, codec, codecData };
      await voice.ask({ type: 'init', cfg: json(cfg), tokenizer: json(tokenizer), codecMeta: json(codecMeta), heads, voices, ortWasm, models },
        [heads.buffer, ortWasm.buffer, ...Object.values(models).map((f) => f.buffer)]);
    } catch (e) {
      voice.dispose();
      throw e;
    }
    return voice;
  }

  /**
   * Speak one piece of text: the server writes its phonemes, the worker says them. With
   * `onPart`, the audio is handed over in parts as it is made, and what is returned is empty.
   * → Float32Array at `sampleRate`
   */
  async synth(text, spec, { signal, onPart = null } = {}) {
    const phonemes = await ai.phonemize(turboPieces(text).map(englishAbbreviations)); // abbreviations said in English
    if (signal?.aborted) throw signal.reason;
    return this.request({ type: 'synth', phonemes, voice: spec.voice, stream: !!onPart }, signal, onPart);
  }

  start(script) {
    this.worker = new Worker(new URL(script, import.meta.url), { type: 'module' });
    this.worker.onmessage = ({ data }) => {
      const job = this.jobs.get(data.id);
      if (data.part) { job?.onPart?.(data.part); return; } // some of a sentence, ahead of the rest
      this.jobs.delete(data.id);
      if (data.error) job?.reject(new Error(data.error)); else job?.resolve(data.pcm);
    };
    this.worker.onerror = (e) => {
      for (const job of this.jobs.values()) job.reject(new Error(e.message || 'The voice stopped working.'));
      this.jobs.clear();
    };
  }

  ask(message, transfer = [], onPart = null) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.jobs.set(id, { resolve, reject, onPart });
      this.worker.postMessage({ ...message, id }, transfer);
    });
  }

  /** Ask the worker for a sentence, letting go of it if `signal` fires first. `onPart` takes what comes ahead of the rest. */
  request(message, signal, onPart = null) {
    if (signal?.aborted) return Promise.reject(signal.reason);
    const done = this.ask(message, [], onPart);
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
