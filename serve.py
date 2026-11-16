#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = ["anthropic>=2.8,<3"]
# ///
"""Reader's local server.

    uv run serve.py [port]        # everything, including the Claude features
    python3 serve.py [port]       # reading aloud only (no Anthropic SDK needed)

It serves the page, and it is the only part that talks to Claude: the browser
sends the document here once, and asks this server to prepare pages for
reading aloud or to explain a paragraph. The API key stays on this side, read
from ANTHROPIC_API_KEY or from a .env file next to this script.

The two Cross-Origin headers let the page use threads and the GPU for speech.
"""
import functools
import hashlib
import http.server
import json
import os
import sys
import threading
import time
import webbrowser
from pathlib import Path
from urllib.parse import parse_qs, urlparse

try:
    import anthropic
except ImportError:  # started with plain python3: the reader still works, without Claude
    anthropic = None

_ports = [a for a in sys.argv[1:] if not a.startswith("--")]
PORT = int(_ports[0]) if _ports else 8137
ROOT = Path(__file__).resolve().parent
CACHE = ROOT / ".reader-cache"
ENV_FILE = ROOT / ".env"

MODEL = "claude-sonnet-5-5"
# If Claude's safety classifiers decline a request, the API retries it on a fallback model.
BETAS = ["server-side-fallback-2026-07-01"]
PROMPT_VERSION = "3"  # bump to stop using answers cached under older prompts
WARM_FOR = 50 * 60  # seconds a document's prompt cache is assumed alive (it is written with a 1-hour lifetime)
MAX_BODY = 80 * 1024 * 1024

SYSTEM = (
    "You work inside a read-aloud app for PDF documents. A listener hears your words through a "
    "text-to-speech voice while following the page with their eyes. Whatever you write to be spoken "
    "is heard and never seen, so it has to be plain spoken English: no markdown, no LaTeX, no symbols "
    "a voice cannot say. The complete document is attached to every request. Text extracted from a PDF "
    "loses superscripts, subscripts, fractions and special symbols, so when the extracted text and the "
    "document disagree, trust what the document shows."
)

UNDERSTAND = """Task: read the whole document and write the notes the app keeps beside it while reading it aloud.

Answer with one JSON object and nothing else, with these fields:
- "title": the document's title.
- "summary": what the document is about, what it sets out to do and what it finds or argues, in 100 to 150 words of plain spoken English, for a listener who is new to the subject.
- "notation": a list with one entry for each recurring symbol, variable, abbreviation or unit whose spoken form is not obvious from its spelling. Each entry has "symbol" (as written in the document), "say" (how a lecturer would speak it, the same way every time, with subscripts spoken as "sub", for example "d sub k") and "meaning" (a few words). Leave out anything a voice would already read correctly."""

NARRATE = """Task: prepare page {page} for reading aloud.

Below is the text of page {page} as the app extracted it, already cut into the pieces it will speak one after another. Each piece has an id such as 12.1 (block 12, piece 1). Where the app could detect them, ^{{...}} marks a superscript and _{{...}} marks a subscript.

Most pieces are ordinary prose, and those must be spoken exactly as written, so leave them out of your answer. Return only the pieces a voice would get wrong if it read them as written, each with the text to speak instead:
- Mathematics and formulas, said the way a lecturer reads them aloud. E^{{4}} becomes "E to the fourth power", x_{{i}} becomes "x sub i", and a fraction with QK^{{T}} over the square root of d_{{k}} becomes "Q times K transpose, divided by the square root of d sub k".
- Other notation a voice stumbles on: Greek letters and symbols, units, chemical formulas, ranges, and abbreviations that are not said as spelled ("Fig. 3" is "Figure 3", "e.g." is "for example").
- Damage from extraction: words glued together or broken apart, or a formula whose parts came out scrambled. Rebuild these from the document.
- Citation and footnote markers such as [12], a superscript footnote number, or a dagger are not spoken, so remove them.
Within a piece you return, keep every ordinary word exactly as it is and in the same order, and never move words from one piece into another. Do not summarize, explain or add anything.

Also give, under "skip", the block numbers of anything that is not part of the document's running text and should be passed over during continuous reading: page numbers, running headers and footers, line numbers, watermarks and stamps, and stray labels that belong to the inside of a figure. Headings, captions, footnotes, equations and tables stay.
{notes}
Page {page} pieces:
{pieces}

Answer with one JSON object and nothing else, in this shape: {{"changes": [{{"id": "5.1", "say": "..."}}], "skip": [0, 13]}}. Use empty lists when there is nothing to report."""

EXPLAIN = """Task: the listener double-clicked the paragraph below, on page {page}, because they want to understand it. Explain what it means: what it is saying in plain words and why it matters here, using the rest of the document for any terms, symbols or earlier results it relies on. Talk to them the way you would to a curious colleague from another field, and go straight into the explanation without announcing it. This is a quick spoken aside before they carry on reading, so keep it to three or four sentences, and no more than about ninety words.
{context}
Paragraph:
{text}"""


class ApiError(Exception):
    def __init__(self, status, code, message):
        super().__init__(message)
        self.status, self.code, self.message = status, code, message


def load_env_file():
    if not ENV_FILE.exists() or os.environ.get("ANTHROPIC_API_KEY"):
        return
    for line in ENV_FILE.read_text().splitlines():
        name, _, value = line.partition("=")
        if name.strip() == "ANTHROPIC_API_KEY" and value.strip():
            os.environ["ANTHROPIC_API_KEY"] = value.strip().strip("\"'")


def read_json(path):
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return None


def write_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False))
    tmp.replace(path)


def parse_json_answer(text):
    start, end = text.find("{"), text.rfind("}")
    if start < 0 or end <= start:
        raise ApiError(502, "bad_output", "Claude's answer was not in the expected form.")
    try:
        return json.loads(text[start : end + 1])
    except ValueError as e:
        raise ApiError(502, "bad_output", "Claude's answer was not in the expected form.") from e


class Claude:
    """Everything that calls the Claude API. One instance, shared by request threads."""

    def __init__(self):
        self._client = None
        self._lock = threading.Lock()
        self._doc_locks = {}
        self._warm_at = {}

    def status(self):
        if anthropic is None:
            return {"available": False, "reason": "no_sdk", "model": MODEL}
        has_login = (Path.home() / ".config" / "anthropic").exists()
        if not (os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN") or has_login):
            return {"available": False, "reason": "no_key", "model": MODEL}
        return {"available": True, "reason": None, "model": MODEL}

    def client(self):
        if anthropic is None:
            raise ApiError(503, "no_sdk", "Start the reader with 'uv run serve.py' to use Claude.")
        with self._lock:
            if self._client is None:
                self._client = anthropic.Anthropic()
            return self._client

    def set_key(self, key):
        """Check a key against the API and, if it works, keep it in .env for next time."""
        if anthropic is None:
            raise ApiError(503, "no_sdk", "Start the reader with 'uv run serve.py' to use Claude.")
        try:
            anthropic.Anthropic(api_key=key).models.retrieve(MODEL)
        except anthropic.AuthenticationError as e:
            raise ApiError(401, "auth", "That key was not accepted.") from e
        except anthropic.APIError as e:
            raise ApiError(502, "api", f"Could not check the key: {e}") from e
        ENV_FILE.write_text(f"ANTHROPIC_API_KEY={key}\n")
        ENV_FILE.chmod(0o600)
        os.environ["ANTHROPIC_API_KEY"] = key
        with self._lock:
            self._client = None

    # -- documents -----------------------------------------------------------

    def doc_dir(self, sha):
        if not (len(sha) == 64 and all(c in "0123456789abcdef" for c in sha)):
            raise ApiError(400, "bad_request", "Unknown document.")
        return CACHE / "docs" / sha

    def meta(self, sha):
        meta = read_json(self.doc_dir(sha) / "meta.json")
        if not meta:
            raise ApiError(409, "reupload", "The document needs to be sent again.")
        return meta

    def register(self, data, mime, name, force=False):
        """Upload a document to Claude's file store once; later requests refer to it by id."""
        sha = hashlib.sha256(data).hexdigest()
        path = self.doc_dir(sha) / "meta.json"
        meta = None if force else read_json(path)
        if not meta:
            filename = "document.pdf" if mime == "application/pdf" else "document.txt"
            uploaded = self._call(lambda: self.client().files.upload(file=(filename, data, mime)))
            meta = {"file_id": uploaded.id, "mime": mime, "name": name, "created": int(time.time())}
            write_json(path, meta)
            self._warm_at.pop(sha, None)
            print(f"[claude] uploaded {name!r} ({len(data) // 1024} KB)")
        return sha, read_json(self.doc_dir(sha) / "notes.json")

    def _request(self, meta, task):
        return dict(
            model=MODEL,
            betas=BETAS,
            fallbacks="default",
            system=SYSTEM,
            # Kept identical on every call: changing effort or thinking would start a separate prompt cache.
            output_config={"effort": "low"},
            messages=[{
                "role": "user",
                "content": [
                    {
                        "type": "document",
                        "source": {"type": "file", "file_id": meta["file_id"]},
                        "cache_control": {"type": "ephemeral", "ttl": "1h"},
                    },
                    {"type": "text", "text": task},
                ],
            }],
        )

    def _call(self, fn, sha=None):
        try:
            return fn()
        except anthropic.AuthenticationError as e:
            raise ApiError(401, "auth", "The Anthropic API key was not accepted.") from e
        except anthropic.PermissionDeniedError as e:
            raise ApiError(403, "auth", "This API key is not allowed to use that model.") from e
        except (anthropic.NotFoundError, anthropic.BadRequestError) as e:
            if sha and "file" in str(e).lower():  # the uploaded copy is gone: forget it and ask for it again
                (self.doc_dir(sha) / "meta.json").unlink(missing_ok=True)
                raise ApiError(409, "reupload", "The document needs to be sent again.") from e
            raise ApiError(502, "api", f"Claude rejected the request: {e}") from e
        except anthropic.RateLimitError as e:
            raise ApiError(429, "rate_limit", "Claude is rate-limited right now. Try again shortly.") from e
        except anthropic.APIStatusError as e:
            raise ApiError(502, "api", f"Claude returned an error ({e.status_code}).") from e
        except anthropic.APIConnectionError as e:
            raise ApiError(503, "offline", "Could not reach Claude. Check the connection.") from e

    def _ensure_warm(self, sha, meta):
        """Write the document into the prompt cache before the first real request.

        Requests sent in parallel cannot share a cache entry that is still being written, so the first
        caller pays for one empty request and everyone after it reads the document at the cached rate.
        """
        with self._lock:
            lock = self._doc_locks.setdefault(sha, threading.Lock())
        with lock:
            if time.time() - self._warm_at.get(sha, 0) < WARM_FOR:
                return
            t = time.time()
            r = self._call(lambda: self.client().beta.messages.create(max_tokens=0, **self._request(meta, "Ready.")), sha)
            self._warm_at[sha] = time.time()
            u = r.usage
            print(f"[claude] cached document: {u.cache_creation_input_tokens} tokens written, "
                  f"{u.cache_read_input_tokens} already cached ({time.time() - t:.1f}s)")

    def run(self, sha, label, task, on_text=None):
        meta = self.meta(sha)
        self._ensure_warm(sha, meta)
        t = time.time()

        def go():
            with self.client().beta.messages.stream(max_tokens=64000, **self._request(meta, task)) as stream:
                for text in stream.text_stream:
                    if on_text:
                        on_text(text)
                return stream.get_final_message()

        msg = self._call(go, sha)
        self._warm_at[sha] = time.time()
        u = msg.usage
        print(f"[claude] {label}: {u.cache_read_input_tokens} cached + {u.input_tokens + u.cache_creation_input_tokens} new in, "
              f"{u.output_tokens} out ({time.time() - t:.1f}s)")
        if msg.stop_reason == "refusal":
            raise ApiError(422, "refused", "Claude declined this request.")
        return "".join(b.text for b in msg.content if b.type == "text")

    # -- the three jobs ------------------------------------------------------

    def understand(self, sha):
        path = self.doc_dir(sha) / "notes.json"
        notes = read_json(path)
        if notes and notes.get("v") == PROMPT_VERSION:
            return notes
        data = parse_json_answer(self.run(sha, "read the document", UNDERSTAND))
        notes = {
            "v": PROMPT_VERSION,
            "title": str(data.get("title", "")),
            "summary": str(data.get("summary", "")),
            "notation": [
                {"symbol": str(n.get("symbol", "")), "say": str(n.get("say", "")), "meaning": str(n.get("meaning", ""))}
                for n in data.get("notation", []) if isinstance(n, dict) and n.get("symbol") and n.get("say")
            ],
        }
        write_json(path, notes)
        return notes

    def narrate(self, sha, page, pieces):
        pieces = [(str(p["id"]), str(p["text"])) for p in pieces]
        key = hashlib.sha1(json.dumps([PROMPT_VERSION, page, pieces]).encode()).hexdigest()[:16]
        path = self.doc_dir(sha) / "pages" / f"{page}-{key}.json"
        cached = read_json(path)
        if cached:
            return cached
        notes = read_json(self.doc_dir(sha) / "notes.json")
        notes_text = ""
        if notes and notes.get("notation"):
            lines = "\n".join(f'- {n["symbol"]}: "{n["say"]}"' for n in notes["notation"])
            notes_text = f"\nSay recurring symbols the same way every time. The app's notes for this document:\n{lines}\n"
        task = NARRATE.format(page=page, notes=notes_text, pieces="\n".join(f"{i}: {t}" for i, t in pieces))
        data = parse_json_answer(self.run(sha, f"prepare page {page}", task))
        known = dict(pieces)
        blocks = {i.split(".")[0] for i in known}
        result = {
            "changes": [
                {"id": c["id"], "say": " ".join(c["say"].split())}
                for c in data.get("changes", [])
                if isinstance(c, dict) and c.get("id") in known and isinstance(c.get("say"), str) and c["say"].strip()
                # A rewrite many times longer than its source is not "the same words": ignore it.
                and len(c["say"]) <= 6 * len(known[c["id"]]) + 200
            ],
            "skip": [b for b in data.get("skip", []) if isinstance(b, int) and str(b) in blocks],
        }
        write_json(path, result)
        return result

    def explain(self, sha, page, text, before, after, on_text):
        key = hashlib.sha1(json.dumps([PROMPT_VERSION, page, text]).encode()).hexdigest()[:16]
        path = self.doc_dir(sha) / "explain" / f"{key}.json"
        cached = read_json(path)
        if cached:
            on_text(cached["text"])
            return
        context = ""
        if before or after:
            context = "\nTo help you find it on the page, the text just before it is:\n" + (before or "(nothing)") + \
                      "\nand the text just after it is:\n" + (after or "(nothing)") + "\n"
        answer = self.run(sha, f"explain a paragraph on page {page}", EXPLAIN.format(page=page, context=context, text=text), on_text)
        if answer.strip():
            write_json(path, {"text": answer})


claude = Claude()


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".mjs": "text/javascript",
        ".js": "text/javascript",
        ".wasm": "application/wasm",
    }

    def end_headers(self):
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def log_message(self, *args):
        pass

    def translate_path(self, path):
        # Never serve the key file, the answer cache or version-control data.
        first = urlparse(path).path.lstrip("/").split("/", 1)[0]
        if first.startswith("."):
            return str(ROOT / "__not_served__")
        return super().translate_path(path)

    # -- API -----------------------------------------------------------------

    def _allowed(self):
        """Only this page may use the API: other sites open in the browser must not spend the key."""
        hosts = {f"localhost:{PORT}", f"127.0.0.1:{PORT}"}
        origin = self.headers.get("Origin")
        if self.headers.get("Host") not in hosts or (origin and origin not in {f"http://{h}" for h in hosts}):
            return False
        return self.command != "POST" or self.headers.get("X-Reader") == "1"

    def _json(self, data, status=200):
        body = json.dumps(data).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _body(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length > MAX_BODY:
            raise ApiError(413, "too_large", "That document is too large.")
        return self.rfile.read(length)

    def do_GET(self):
        if not self.path.startswith("/api/"):
            return super().do_GET()
        if not self._allowed():
            return self._json({"error": "forbidden"}, 403)
        if urlparse(self.path).path == "/api/status":
            return self._json(claude.status())
        self._json({"error": "not_found"}, 404)

    def do_POST(self):
        url = urlparse(self.path)
        if not url.path.startswith("/api/") or not self._allowed():
            return self._json({"error": "forbidden"}, 403)
        try:
            raw = self._body()
            if url.path == "/api/doc":
                q = parse_qs(url.query)
                name = (q.get("name") or ["document"])[0][:200]
                force = (q.get("force") or ["0"])[0] == "1"
                if self.headers.get("Content-Type") == "application/pdf":
                    sha, notes = claude.register(raw, "application/pdf", name, force)
                else:  # a long document sent as extracted text
                    sha, notes = claude.register(raw, "text/plain", name, force)
                return self._json({"doc": sha, "notes": notes})
            req = json.loads(raw or b"{}")
            if url.path == "/api/key":
                claude.set_key(str(req.get("key", "")).strip())
                return self._json(claude.status())
            if url.path == "/api/understand":
                return self._json(claude.understand(req["doc"]))
            if url.path == "/api/narrate":
                return self._json(claude.narrate(req["doc"], int(req["page"]), req["pieces"]))
            if url.path == "/api/explain":
                return self._explain(req)
            self._json({"error": "not_found"}, 404)
        except ApiError as e:
            self._json({"error": e.code, "message": e.message}, e.status)
        except (KeyError, ValueError, TypeError) as e:
            self._json({"error": "bad_request", "message": str(e)}, 400)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _explain(self, req):
        """Stream the explanation as plain text, so speech can start on the first sentence."""
        started = False

        def on_text(text):
            nonlocal started
            if not started:
                started = True
                self.send_response(200)
                self.send_header("Content-Type", "text/plain; charset=utf-8")
                self.end_headers()
            self.wfile.write(text.encode())
            self.wfile.flush()

        try:
            claude.explain(req["doc"], int(req["page"]), str(req["text"])[:6000],
                           str(req.get("before", ""))[:600], str(req.get("after", ""))[:600], on_text)
            if not started:
                raise ApiError(502, "bad_output", "Claude returned nothing.")
        except ApiError:
            if started:  # already mid-stream: just end it
                return
            raise


if __name__ == "__main__":
    load_env_file()
    handler = functools.partial(Handler, directory=str(ROOT))
    with http.server.ThreadingHTTPServer(("127.0.0.1", PORT), handler) as httpd:
        url = f"http://localhost:{PORT}/"
        state = claude.status()
        note = {"no_sdk": "off (start with 'uv run serve.py' to turn it on)", "no_key": "waiting for an API key", None: f"on, using {MODEL}"}
        print(f"Reader is running at {url}  (Ctrl+C to stop)")
        print(f"Claude features: {note[state['reason']]}")
        if "--no-open" not in sys.argv:
            threading.Timer(0.4, webbrowser.open, args=(url,)).start()
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print()
