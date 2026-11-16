// The page's side of the Claude features. All requests go to the local server (serve.py),
// which holds the API key and talks to Claude; nothing here contacts Anthropic directly.

const MESSAGES = {
  no_sdk: 'Claude is off: start the reader with “uv run serve.py”.',
  no_key: 'Claude needs an Anthropic API key.',
  auth: 'The Anthropic API key was not accepted.',
  offline: 'Could not reach Claude. Check the connection.',
  rate_limit: 'Claude is busy right now. Try again in a moment.',
  refused: 'Claude declined to work on this passage.',
  too_long: 'This document is too long for Claude to read in one go.',
};

export class AiError extends Error {
  constructor(code, message) {
    super(message || MESSAGES[code] || 'Claude ran into a problem.');
    this.code = code;
  }
}

async function post(path, body, { type = 'application/json', signal, timeout = 90000 } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(new AiError('offline', 'Claude took too long to answer.')), timeout);
  signal?.addEventListener('abort', () => ctl.abort(signal.reason), { once: true });
  let res;
  try {
    res = await fetch(path, {
      method: 'POST',
      headers: { 'X-Reader': '1', 'Content-Type': type },
      body: type === 'application/json' ? JSON.stringify(body) : body,
      signal: ctl.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    if (signal?.aborted) throw e;
    throw e instanceof AiError ? e : new AiError('offline');
  }
  if (!res.ok) {
    clearTimeout(timer);
    const info = await res.json().catch(() => ({}));
    throw new AiError(info.error || 'api', MESSAGES[info.error] || info.message);
  }
  return { res, done: () => clearTimeout(timer) };
}

async function postJson(path, body, opts) {
  const { res, done } = await post(path, body, opts);
  try { return await res.json(); } finally { done(); }
}

export const ai = {
  available: false,
  reason: 'no_sdk', // why not, when unavailable: no_sdk | no_key
  model: '',
  /** The open document as Claude knows it: { state, id, notes, error, ready } */
  doc: null,
  onChange: () => {},

  async init() {
    try {
      const s = await (await fetch('/api/status')).json();
      Object.assign(this, { available: !!s.available, reason: s.reason || null, model: s.model || '' });
    } catch {
      Object.assign(this, { available: false, reason: 'no_sdk' });
    }
    this.onChange();
  },

  async setKey(key) {
    const s = await postJson('/api/key', { key });
    Object.assign(this, { available: !!s.available, reason: s.reason || null });
    this.onChange();
  },

  /** True while Claude is, or is about to be, usable for the open document. */
  get usable() {
    return this.available && !!this.doc && this.doc.state !== 'error';
  },

  close() {
    this.doc = null;
    this.onChange();
  },

  /**
   * Hand the document to Claude. `payload` is the PDF's bytes, or its extracted text for
   * documents too long to send as pages. Returns once it is registered; Claude then reads
   * it through in the background and `doc.notes` fills in.
   */
  open(payload, name) {
    const doc = this.doc = { state: 'sending', id: null, notes: null, error: null, payload, name };
    doc.ready = (async () => {
      try {
        await this.register(doc, false);
        doc.state = doc.notes ? 'ready' : 'reading';
        this.onChange();
        if (!doc.notes) {
          postJson('/api/understand', { doc: doc.id }, { timeout: 180000 }).then(
            (notes) => { doc.notes = notes; if (doc.state === 'reading') doc.state = 'ready'; if (this.doc === doc) this.onChange(); },
            // The notes only keep pronunciation consistent; reading still works without them.
            () => { if (doc.state === 'reading') doc.state = 'ready'; if (this.doc === doc) this.onChange(); },
          );
        }
      } catch (e) {
        this.fail(doc, e);
        throw e;
      }
    })();
    doc.ready.catch(() => {});
    this.onChange();
    return doc.ready;
  },

  async register(doc, force) {
    const isText = typeof doc.payload === 'string';
    const q = new URLSearchParams({ name: doc.name, force: force ? '1' : '0' });
    const out = await postJson(`/api/doc?${q}`, doc.payload, { type: isText ? 'text/plain' : 'application/pdf', timeout: 180000 });
    doc.id = out.doc;
    doc.notes = out.notes || doc.notes;
  },

  fail(doc, e) {
    if (this.doc !== doc) return;
    doc.state = 'error';
    doc.error = e instanceof AiError ? e : new AiError('api');
    if (doc.error.code === 'auth' || doc.error.code === 'no_key') { this.available = false; this.reason = 'no_key'; }
    if (doc.error.code === 'no_sdk') { this.available = false; this.reason = 'no_sdk'; }
    this.onChange();
  },

  /** Run a request against the open document, sending the document again once if the server lost it. */
  async withDoc(fn) {
    const doc = this.doc;
    if (!doc) throw new AiError('api');
    await doc.ready;
    try {
      return await fn(doc);
    } catch (e) {
      if (e.code !== 'reupload') throw e;
      await this.register(doc, true);
      return fn(doc);
    }
  },

  /** Ask which pieces of a page need different words when spoken. → { changes: [{id, say}], skip: [block] } */
  narrate(page, pieces) {
    return this.withDoc((doc) => postJson('/api/narrate', { doc: doc.id, page, pieces }));
  },

  /** Stream a spoken explanation of one paragraph; `onText` receives it piece by piece. */
  explain({ page, text, before, after, signal, onText }) {
    return this.withDoc(async (doc) => {
      const { res, done } = await post('/api/explain', { doc: doc.id, page, text, before, after }, { signal });
      try {
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        for (;;) {
          const { value, done: end } = await reader.read();
          if (end) break;
          onText(decoder.decode(value, { stream: true }));
        }
      } finally {
        done();
      }
    });
  },
};
