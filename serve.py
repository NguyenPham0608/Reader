#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = ["anthropic>=2.8,<3", "sea-g2p==0.10.0"]
# ///
"""Reader's local server.

    uv run serve.py [port]        # everything, including the Claude features
    python3 serve.py [port]       # reading aloud only (no Anthropic SDK needed)

With sea-g2p installed (uv run installs it) it also writes the phonemes the
VieNeu-TTS v3 Turbo voices read; the page runs those voices itself.

It serves the page, and it is the only part that talks to Claude: the browser
sends the document here once, and asks this server to prepare pages for
reading aloud or to explain a paragraph. The API key stays on this side, read
from ANTHROPIC_API_KEY or from a .env file next to this script.

It can also speak with Azure's neural voices (Azure AI Speech), which start at
once with nothing to download: set AZURE_SPEECH_KEY and AZURE_SPEECH_REGION
(the region of the Speech resource, such as "westus2"), here or in .env.

Hosted on Render (see render.yaml) it listens publicly and anyone with the
address can use it, paid for by the owner's API keys. To keep that bounded it
stops calling Claude and Azure once a day's use reaches READER_DAILY_BUDGET
dollars (reading aloud with the page's own voices carries on).
READER_ACCESS=password with READER_PASSWORD makes
it private instead: the browser then asks for the password, and the daily cap
no longer applies. READER_ALLOWED_ORIGINS names other sites whose copy of the
page may use this server, such as the GitHub Pages address; the word
"localhost" in that list allows a copy served from anyone's own machine.

The two Cross-Origin headers let the page use threads and the GPU for speech.
"""
import base64
import functools
import hashlib
import hmac
import http.server
import json
import os
import re
import sys
import threading
import time
import urllib.error
import urllib.request
import webbrowser
from pathlib import Path
from urllib.parse import parse_qs, urlparse
from xml.sax.saxutils import escape as xml_escape

try:
    import anthropic
except ImportError:  # started with plain python3: the reader still works, without Claude
    anthropic = None

try:
    import sea_g2p  # the VieNeu-TTS v3 Turbo voices' text front end (the page offers them only with it)
except ImportError:
    sea_g2p = None

HOSTED = os.environ.get("RENDER") == "true"  # on Render, rather than on your own machine
_ports = [a for a in sys.argv[1:] if not a.startswith("--")]
PORT = int(_ports[0]) if _ports else int(os.environ.get("PORT") or 10000) if HOSTED else 8137
BIND = "0.0.0.0" if HOSTED else "127.0.0.1"
PUBLIC_HOST = os.environ.get("RENDER_EXTERNAL_HOSTNAME", "") if HOSTED else ""
# READER_ACCESS=open ignores any password, so the choice in render.yaml decides it.
PASSWORD = "" if os.environ.get("READER_ACCESS") == "open" else os.environ.get("READER_PASSWORD", "")
# Other sites that host a copy of the page and may call this server from the browser.
ALLOWED_ORIGINS = {o.strip().rstrip("/") for o in os.environ.get("READER_ALLOWED_ORIGINS", "").split(",") if o.strip()}
LOCAL_ORIGIN = re.compile(r"http://(localhost|127\.0\.0\.1)(:\d+)?")


def origin_allowed(origin):
    """Whether a page served from `origin` (another site) may call this server."""
    if not origin:
        return False
    return origin in ALLOWED_ORIGINS or ("localhost" in ALLOWED_ORIGINS and bool(LOCAL_ORIGIN.fullmatch(origin)))
OPEN = HOSTED and not PASSWORD  # anyone with the address can use it, on the owner's key
DAILY_BUDGET = float(os.environ.get("READER_DAILY_BUDGET") or 3)  # dollars of Claude use a day while open
ROOT = Path(__file__).resolve().parent
CACHE = ROOT / ".reader-cache"
ENV_FILE = ROOT / ".env"

MODEL = "claude-sonnet-5-5"
# If Claude's safety classifiers decline a request, the API retries it on a fallback model.
BETAS = ["server-side-fallback-2026-07-01"]
PROMPT_VERSION = "4"  # bump to stop using answers cached under older prompts
TRANSLATE_VERSION = "3"  # the same, for translations and replies in another language only
# Sonnet 5.5 prices in dollars per million tokens (cache writes at the 1-hour rate), for the daily cap.
PRICE = {"input": 2.0, "cache_write": 4.0, "cache_read": 0.10, "output": 10.0}
WARM_FOR = 50 * 60  # seconds a document's prompt cache is assumed alive (it is written with a 1-hour lifetime)
MAX_BODY = 80 * 1024 * 1024
MAX_PDF = 32 * 1024 * 1024  # the page sends larger documents as text instead
MAX_TEXT = 8 * 1024 * 1024

MAX_PHONEMIZE = 64  # texts in one request for phonemes
MAX_PHONEMIZE_TEXT = 2000  # characters in each: the page sends pieces of a sentence

# Azure's voices the page may ask for, and the language each speaks.
SPEECH_VOICES = {"vi-VN-HoaiMyNeural": "vi-VN", "vi-VN-NamMinhNeural": "vi-VN"}
SPEECH_FORMAT = "audio-24khz-48kbitrate-mono-mp3"  # about 22 MB an hour
SPEECH_PRICE = float(os.environ.get("AZURE_SPEECH_PRICE") or 16)  # dollars per million characters, for the daily cap
MAX_SPEECH_TEXT = 3000  # characters in one request: the page sends a sentence at a time
ENV_NAMES = ("ANTHROPIC_API_KEY", "AZURE_SPEECH_KEY", "AZURE_SPEECH_REGION")  # what a .env file may set

SYSTEM = (
    "You work inside a read-aloud app for PDF documents. A listener hears your words through a "
    "text-to-speech voice while following the page with their eyes. Whatever you write to be spoken "
    "is heard and never seen, so it has to be plain spoken language, in English unless the task names "
    "another language: no markdown, no LaTeX, no symbols a voice cannot say. The complete document is attached to every request. Text extracted from a PDF "
    "loses superscripts, subscripts, fractions and special symbols, so when the extracted text and the "
    "document disagree, trust what the document shows.\n\n"
    "How mathematics and notation are spoken\n"
    "Say notation the way a person says it out loud to a colleague at a whiteboard, never the way it is "
    "typeset. People drop almost all of the scaffolding, and so should you:\n"
    "- A subscript is simply said after its letter: x_i is \"x i\", k_n is \"k n\", d_model is \"d model\", "
    "h_{t-1} is \"h t minus one\". Do not say \"sub\" or \"subscript\", except in the rare case where leaving "
    "it out would make two different things in the document sound the same.\n"
    "- Powers: \"x squared\", \"x cubed\", \"x to the n\", \"ten to the minus nine\", \"e to the minus x\".\n"
    "- Fractions and division: \"a over b\", \"one half\", \"one over the square root of d k\".\n"
    "- Functions: f(x) is \"f of x\", P(A|B) is \"the probability of A given B\", O(n^2) is \"order n squared\", "
    "max(0, x) is \"the max of zero and x\".\n"
    "- Sums, products and integrals: \"the sum over i from one to n of x i\", \"the integral from zero to one "
    "of f of x, d x\".\n"
    "- Relations and operators in everyday words: \"equals\" or \"is\", \"is about\", \"is at most\", \"is at "
    "least\", \"in\" for set membership, \"goes to\" for an arrow, \"is proportional to\". A product is "
    "\"times\", or nothing at all where people would say \"two x\"; a cross between sizes is \"by\", as in "
    "\"512 by 512\".\n"
    "- Greek letters by name. Marks are named after the letter: \"x hat\", \"x bar\", \"y prime\", \"x star\", "
    "\"Q K transpose\". Bold, calligraphic and blackboard styles are not mentioned.\n"
    "- Brackets are not read out. Word the phrase so the grouping stays clear, with a comma for a short "
    "pause, or \"all over\" or \"the quantity\" only where a listener would otherwise mishear the structure.\n"
    "- Units, numbers and abbreviations become the words people say: \"5 ms\" is \"five milliseconds\", "
    "\"3.5x\" is \"three and a half times\", \"2-5\" is \"two to five\", \"Fig. 3\" is \"Figure 3\", \"e.g.\" is "
    "\"for example\", \"i.e.\" is \"that is\".\n"
    "- The number or label that tags a displayed equation is not read.\n"
    "Choose the shortest wording a listener would still follow, and say the same symbol the same way every "
    "time. The voice reads exactly what you write, so write words and letters, never symbols, and write a "
    "variable named a as a capital \"A\" so the voice does not take it for the word \"a\"."
)

UNDERSTAND = """Task: read the whole document and write the notes the app keeps beside it while reading it aloud.

Answer with one JSON object and nothing else, with these fields:
- "title": the document's title.
- "summary": what the document is about, what it sets out to do and what it finds or argues, in 100 to 150 words of plain spoken English, for a listener who is new to the subject.
- "notation": a list with one entry for each recurring symbol, variable, abbreviation or unit whose spoken form is not obvious from its spelling. Each entry has "symbol" (as written in the document), "say" (how a person would say it aloud in conversation, the same way every time and without "sub" or "subscript", for example "d k" for d_k) and "meaning" (a few words). Leave out anything a voice would already read correctly."""

NARRATE = """Task: prepare page {page} for reading aloud.

Below is the text of page {page} as the app extracted it, already cut into the pieces it will speak one after another. Each piece has an id such as 12.1 (block 12, piece 1). Where the app could detect them, ^{{...}} marks a superscript and _{{...}} marks a subscript.

Most pieces are ordinary prose, and those must be spoken exactly as written, so leave them out of your answer. Return only the pieces a voice would get wrong if it read them as written, each with the text to speak instead:
- Mathematics and formulas, said naturally, the way a person would say them to a colleague. x_{{i}} becomes "x i", k_{{n}} becomes "k n", E^{{4}} becomes "E to the fourth", and a fraction with QK^{{T}} over the square root of d_{{k}} becomes "Q K transpose over the square root of d k". It should sound like someone talking, not like someone spelling out symbols.
- Other notation a voice stumbles on: Greek letters and symbols, units, chemical formulas, ranges, and abbreviations that are not said as spelled.
- Damage from extraction: words glued together or broken apart, or a formula whose parts came out scrambled. Rebuild these from the document.
- Citation and footnote markers such as [12], a superscript footnote number, or a dagger are not spoken, so remove them. Where the sentence leans on the marker as if it were a word ("such as [38, 2, 9]", "similar to [30]"), say "references 38, 2 and 9" or "reference 30" there instead, so the sentence still makes sense.
Within a piece you return, keep every ordinary word exactly as it is and in the same order, and never move words from one piece into another. Do not summarize, explain or add anything.

Also give, under "skip", the block numbers of anything that is not part of the document's running text and should be passed over during continuous reading: page numbers, running headers and footers, line numbers, watermarks and stamps, and stray labels that belong to the inside of a figure. Headings, captions, footnotes, equations and tables stay.
{notes}
Page {page} pieces:
{pieces}

Answer with one JSON object and nothing else, in this shape: {{"changes": [{{"id": "5.1", "say": "..."}}], "skip": [0, 13]}}. Use empty lists when there is nothing to report."""

TRANSLATE = """Task: translate page {page} into {language} for reading aloud.

Below is text from page {page} as the app extracted it, already cut into the pieces it will speak one after another. Each piece has an id such as 12.1 (block 12, piece 1). An id that begins with another page's number and a colon, such as 13:0.0, is a piece from that page which finishes a sentence begun on this one. Where the app could detect them, ^{{...}} marks a superscript and _{{...}} marks a subscript.

The listener wants to hear this document in {language}. For every piece, write what the voice should say in {language}: a faithful, natural translation, the way a good translator would put it for someone listening, neither word for word nor a summary. In this task your spoken text is not English: write {language} only, in its usual script.
- Each piece is translated under its own id, because the app marks on the page the piece being spoken. Never merge pieces, and never move content from one piece into another. A piece can begin or end in the middle of a sentence, where a column or a page breaks: translate just that fragment, worded so that it runs on from the piece before it and into the piece after it.
- Write every number as the words a {language} speaker says, never as digits: counts, years, dates, decimals, percentages, ranges, and numbers inside labels, names and formulas. Say the same number the same way each time.
- Mathematics, formulas and notation are said the way a {language} speaker would say them aloud to a colleague, following the rules you were given, carried over into {language}. Units and ordinary abbreviations (Fig., e.g., etc.) become the words a {language} speaker says.
- Identifiers that nobody reads aloud are left out: DOIs, web and email addresses, postal codes, ISBNs and ISSNs, arXiv and grant numbers. Where the sentence needs something in their place, say in {language} what it is ("the DOI", "the project's website"). Citation and footnote markers such as [12] are not spoken either; where the sentence leans on the marker as if it were a word, say the {language} for "reference 12" there.
- Repair damage from extraction (words glued together or broken apart, a formula whose parts came out scrambled) from the document before translating.
- Names of people, places and products stay as they are, and so do the titles of cited works. {english}
- A piece that is already in {language} is returned as it should be spoken, changed only as the points above require.
- A piece with nothing to say aloud (a page number, a stray label, a lone symbol from inside a figure) gets an empty string.
{glossary}{context}
Pieces:
{pieces}

Answer with one line for each piece above, in the order given, and nothing else. Each line is a JSON object of its own, such as {{"id": "5.1", "say": "..."}}, and every piece gets one, even when its "say" is empty."""

# What the voice reading a translation can say the English way, as the page reports it: VieNeu
# says English words and acronyms in English ("words"), Piper only acronyms, and the others
# pronounce everything in the language they speak.
ENGLISH = {
    "words": "The voice says English words, and acronyms written in Latin capitals (AI, DNA, GDP, WHO, mRNA), the English way. Keep such acronyms exactly as written, neither translated nor expanded nor spelled out in {language} letters. A technical term takes its established {language} equivalent where there is one, and otherwise stays in English.",
    "acronyms": "The voice says acronyms written in Latin capitals (AI, DNA, GDP, WHO, mRNA) the English way, so keep them exactly as written, neither translated nor expanded nor spelled out in {language} letters. Every other word it pronounces as {language}, so an English word left in would come out wrong: a technical term takes its established {language} equivalent, or else the spelling {language} speakers use for it as a loanword, and stays in English only where neither exists.",
    "none": "The voice pronounces everything as {language}, English words included. Keep acronyms written in Latin capitals (AI, DNA, GDP) as they are, but give every other technical term its established {language} equivalent, or else the spelling {language} speakers use for it as a loanword, and leave a word in English only where neither exists.",
}

GLOSSARY = """Task: before this document is translated into {language} for reading aloud, page by page, settle the wording the translation will keep to, so that every page says the same thing the same way.

List the document's recurring technical terms, names of methods and models, and recurring phrases that a translator would otherwise word afresh each time, each with the {language} wording to use every time. {english} Then list each recurring symbol or variable whose spoken form is not obvious, with how a {language} speaker says it aloud. Leave out ordinary words, people's names, acronyms that stay as written, and anything every translator would render the same way. Give at most sixty entries, the most frequent first, and write each "say" the way it is spoken: in words, not digits or symbols.

Answer with one JSON object and nothing else, in this shape: {{"terms": [{{"term": "as written in the document", "say": "in {language}"}}]}}."""

IN_LANGUAGE = """

The listener is hearing this document in {language}, through a voice that speaks only {language}. Give your whole reply in {language}, in its usual script, and say any notation the way a {language} speaker would. Acronyms written in capitals (AI, DNA, GDP) stay exactly as written: the voice says them the English way."""

LAYOUT = """Task: find the paragraphs on page {page}.

Below is every line of text the app extracted from page {page}, in the order the PDF stores them. Each has an id, where it sits (x and y of its left end, in points from the top-left corner of the page, and its type size) and its text, with ^{{...}} around a superscript and _{{...}} around a subscript where the app could tell. Extraction is rough: the pieces of a formula (a numerator, a denominator, a limit, an equation number) come out as separate short lines, a table comes out cell by cell, and the stored order is not always the reading order. Look at the page itself in the document to see what belongs together.

Group the lines into blocks. A block is what a reader would point at and say "read me this one":
- each paragraph of running text, however many lines it has;
- each heading or title;
- each displayed equation, together with all of its fragments and its equation number;
- each item of a list, each figure or table caption, each footnote, each entry in a reference list, each author with their affiliation and email;
- each row of a table.
The app draws one box around a block, so a block has to be a single compact patch of the page. When a paragraph is interrupted by a displayed equation or a figure, or runs on from the bottom of one column to the top of the next, each part is its own block, and lines from different columns never share a block.
Use the kind "skip" for whatever is not part of what the document says: page numbers, running headers and footers, line numbers, watermarks and margin stamps, and stray labels and numbers that belong to the inside of a figure or chart.

List the blocks in reading order, and the lines within a block in reading order. Every line id belongs to exactly one block.

Page {page} lines:
{lines}

Answer with one JSON object and nothing else, in this shape: {{"blocks": [["heading", "0"], ["paragraph", "1-9"], ["equation", "10-12,14"], ["skip", "13"]]}}. Each block is a kind followed by its line ids, written as numbers and ranges. The kinds are: heading, paragraph, equation, list, caption, table, footnote, reference, other, skip."""

EXPLAIN = """Task: the listener double-clicked the paragraph below, on page {page}, because they want to understand it. Explain what it means: what it is saying in plain words and why it matters here, using the rest of the document for any terms, symbols or earlier results it relies on. Talk to them the way you would to a curious colleague from another field, and go straight into the explanation without announcing it. This is a quick spoken aside before they carry on reading, so keep it to three or four sentences, and no more than about ninety words.
{context}
Paragraph:
{text}"""

ASK = """Task: the listener is following page {page} and double-clicked the paragraph below to ask a question about it. Answer the question, using that paragraph and the rest of the document for whatever it relies on. If the document does not settle it, say so in a few words and then give what is generally known. Talk to them the way you would to a curious colleague from another field, and go straight into the answer without repeating the question. Your answer is spoken aloud as a quick aside before they carry on reading, so give the direct answer first and keep it as short as the question allows: usually two to five sentences, and no more than about a hundred and fifty words.
{context}
Paragraph:
{text}

The listener's question:
{question}"""

FOLLOW_UP = """The listener goes on:
{question}

Reply the same way as before: spoken aloud as a quick aside, the direct answer first, in plain sentences, and no more than about a hundred and fifty words."""


class ApiError(Exception):
    def __init__(self, status, code, message):
        super().__init__(message)
        self.status, self.code, self.message = status, code, message


def language_of(lang, language):
    """A language tag and its English name as the page sent them, checked: both end up in a prompt, and the tag in a file name."""
    lang, language = str(lang), " ".join(str(language).split())
    if not re.fullmatch(r"[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8}){0,3}", lang) or not re.fullmatch(r"[^\W\d_](?:[^\W_]|[ ()',.-]){1,59}", language):
        raise ApiError(400, "bad_request", "Unknown language.")
    return lang, language


def load_env_file():
    """Keys from the .env file next to this script, for any not set already."""
    if not ENV_FILE.exists():
        return
    for line in ENV_FILE.read_text().splitlines():
        name, _, value = line.partition("=")
        name, value = name.strip(), value.strip().strip("\"'")
        if name in ENV_NAMES and value and not os.environ.get(name):
            os.environ[name] = value


def read_json(path):
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return None


def write_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    # Its own name for each writer: two requests for the same answer can finish together.
    tmp = path.with_suffix(f"{path.suffix}.{threading.get_ident()}.tmp")
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


def json_lines(on_obj):
    """Read an answer written as one JSON object per line while it streams in. → (feed, end):
    `feed` takes each piece of text as it arrives and `end` closes the answer; every complete
    object goes to `on_obj`. Lines that aren't an object (a code fence, a remark) are passed over."""
    buf = ""

    def take(line):
        line = line.strip().rstrip(",")
        if not (line.startswith("{") and line.endswith("}")):
            return
        try:
            obj = json.loads(line)
        except ValueError:
            return
        if isinstance(obj, dict):
            on_obj(obj)

    def feed(text):
        nonlocal buf
        *lines, buf = (buf + text).split("\n")
        for line in lines:
            take(line)

    def end():
        nonlocal buf
        take(buf)
        buf = ""

    return feed, end


class Allowance:
    """How much Claude use the open, hosted reader has paid for today.

    The tally is kept in memory, so it starts again whenever the service restarts: it stops
    runaway use, and a spend limit set in the Anthropic Console is what holds for certain.
    """

    def __init__(self):
        self._lock = threading.Lock()
        self._day, self._spent = None, 0.0

    def _today(self):
        today = time.strftime("%Y-%m-%d", time.gmtime())
        if today != self._day:
            self._day, self._spent = today, 0.0

    def check(self):
        if not OPEN:
            return
        with self._lock:
            self._today()
            if self._spent >= DAILY_BUDGET:
                raise ApiError(429, "limit", "Today's shared Claude allowance is used up, so text is read as written. It resets tomorrow.")

    def charge(self, usage):
        if not OPEN:
            return
        cost = (usage.input_tokens * PRICE["input"] + (usage.cache_creation_input_tokens or 0) * PRICE["cache_write"]
                + (usage.cache_read_input_tokens or 0) * PRICE["cache_read"] + usage.output_tokens * PRICE["output"]) / 1e6
        self.spend(cost)

    def spend(self, dollars):
        if not OPEN:
            return
        with self._lock:
            self._today()
            self._spent += dollars


allowance = Allowance()


class Speech:
    """Sentences spoken by Azure's neural voices (Azure AI Speech), on Microsoft's servers."""

    def endpoint(self):
        """Where to ask, and the key: (url, key), or (None, None) when not set up."""
        key = os.environ.get("AZURE_SPEECH_KEY", "").strip()
        url = os.environ.get("AZURE_SPEECH_ENDPOINT", "").strip()  # instead of a region, for tests and custom domains
        region = os.environ.get("AZURE_SPEECH_REGION", "").strip().lower().replace(" ", "")
        if not url and re.fullmatch(r"[a-z0-9]+", region):
            url = f"https://{region}.tts.speech.microsoft.com/cognitiveservices/v1"
        return (url, key) if url and key else (None, None)

    def voices(self):
        return list(SPEECH_VOICES) if self.endpoint()[0] else []

    def speak(self, text, voice, rate=1.0):
        """`text` said by `voice`, `rate` times its usual pace (0.5 to 2). → MP3 audio"""
        url, key = self.endpoint()
        if not url:
            raise ApiError(503, "speech_off", "Azure's voices aren't set up on this server.")
        if voice not in SPEECH_VOICES:
            raise ApiError(400, "bad_request", "Unknown voice.")
        text = " ".join(str(text).split())[:MAX_SPEECH_TEXT]
        if not text:
            raise ApiError(400, "bad_request", "Nothing to say.")
        rate = min(2.0, max(0.5, float(rate)))
        said = xml_escape(text)
        if abs(rate - 1) >= 0.01:  # markup is billed by the character as well, so only when it's needed
            said = f'<prosody rate="{rate:.2f}">{said}</prosody>'
        ssml = (f'<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="{SPEECH_VOICES[voice]}">'
                f'<voice name="{voice}">{said}</voice></speak>')
        allowance.check()
        for attempt in range(3):
            request = urllib.request.Request(url, data=ssml.encode(), method="POST", headers={
                "Ocp-Apim-Subscription-Key": key,
                "Content-Type": "application/ssml+xml",
                "X-Microsoft-OutputFormat": SPEECH_FORMAT,
                "User-Agent": "reader",
            })
            try:
                with urllib.request.urlopen(request, timeout=30) as reply:
                    audio = reply.read()
                break
            except urllib.error.HTTPError as e:
                if e.code == 429 and attempt < 2:  # the free tier takes 20 requests a minute: wait a moment
                    try:
                        wait = float(e.headers.get("Retry-After") or 1)
                    except ValueError:
                        wait = 1
                    time.sleep(min(3.0, max(0.2, wait)))
                    continue
                print(f"[speech] Azure answered {e.code} for {voice}", flush=True)
                raise self._failure(e.code) from e
            except (urllib.error.URLError, OSError) as e:
                raise ApiError(503, "offline", "Could not reach Azure's voices. Check the connection.") from e
        allowance.spend(len(said) * SPEECH_PRICE / 1e6)
        return audio

    @staticmethod
    def _failure(status):
        if status == 401:
            return ApiError(502, "speech_auth", "Azure didn't accept the speech key: check AZURE_SPEECH_KEY and AZURE_SPEECH_REGION.")
        if status == 403:
            return ApiError(429, "speech_quota", "Azure won't speak any more for now: the speech key's monthly allowance may be used up.")
        if status == 429:
            return ApiError(429, "speech_busy", "Azure's voices are busy (the free tier takes 20 sentences a minute).")
        return ApiError(502, "speech", f"Azure couldn't speak that sentence ({status}).")


speech = Speech()


class Phonemizer:
    """Vietnamese text as the phonemes the VieNeu-TTS v3 Turbo voices read, written by sea-g2p,
    the model's own front end (it also says numbers, dates and abbreviations in words). The page
    runs the voice itself; this part is a compiled library with a large dictionary, so it runs here."""

    def __init__(self):
        self._pipeline = None
        self._lock = threading.Lock()

    def available(self):
        return sea_g2p is not None

    def run(self, texts):
        """→ the phonemes of each text, in order"""
        if sea_g2p is None:
            raise ApiError(503, "phonemes_off", "This server can't prepare text for the VieNeu voices (sea-g2p isn't installed).")
        if not isinstance(texts, list) or len(texts) > MAX_PHONEMIZE:
            raise ApiError(400, "bad_request", f"Send a list of at most {MAX_PHONEMIZE} texts.")
        with self._lock:
            if self._pipeline is None:
                self._pipeline = sea_g2p.SEAPipeline(lang="vi")
            pipeline = self._pipeline
        out = []
        for text in texts:
            text = " ".join(str(text).split())[:MAX_PHONEMIZE_TEXT]
            out.append(pipeline.run(text, punc_norm=True) if text else "")  # as VieNeu-TTS calls it: punctuation settled
        return out


phonemizer = Phonemizer()


def status():
    """What the page can use here: Claude, phonemes for the VieNeu Turbo voices, and which of Azure's voices."""
    return {**claude.status(), "phonemes": phonemizer.available(), "speech": speech.voices()}


class Claude:
    """Everything that calls the Claude API. One instance, shared by request threads."""

    def __init__(self):
        self._client = None
        self._lock = threading.Lock()
        self._doc_locks = {}
        self._file_locks = {}
        self._said = {}  # translation file → {piece key: what to say}, kept in memory once read
        self._claims = {}  # translation file → {piece key: Event}, for pieces being translated right now
        self._warm_at = {}

    def status(self):
        if anthropic is None:
            return {"available": False, "reason": "no_sdk", "model": MODEL}
        has_login = (Path.home() / ".config" / "anthropic").exists()
        if not (os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN") or has_login):
            return {"available": False, "reason": "no_key", "model": MODEL}
        # `cache`: the page keeps answers too, and drops them when this changes.
        return {"available": True, "reason": None, "model": MODEL, "cache": f"{PROMPT_VERSION}.{TRANSLATE_VERSION}"}

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
        if HOSTED:  # the disk there is wiped on every restart, so a key saved to .env would not last
            raise ApiError(403, "hosted", "Set ANTHROPIC_API_KEY in the Render dashboard instead.")
        try:
            anthropic.Anthropic(api_key=key).models.retrieve(MODEL)
        except anthropic.AuthenticationError as e:
            raise ApiError(401, "auth", "That key was not accepted.") from e
        except anthropic.APIError as e:
            raise ApiError(502, "api", f"Could not check the key: {e}") from e
        others = [ln for ln in ENV_FILE.read_text().splitlines() if ln.partition("=")[0].strip() != "ANTHROPIC_API_KEY"] if ENV_FILE.exists() else []
        ENV_FILE.write_text("\n".join([f"ANTHROPIC_API_KEY={key}", *others]) + "\n")  # keeping the Azure key, if there
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
            if len(data) > (MAX_PDF if mime == "application/pdf" else MAX_TEXT):
                raise ApiError(413, "too_large", "That document is too large for Claude.")
            allowance.check()
            filename = "document.pdf" if mime == "application/pdf" else "document.txt"
            uploaded = self._call(lambda: self.client().files.upload(file=(filename, data, mime)))
            meta = {"file_id": uploaded.id, "mime": mime, "name": name, "created": int(time.time())}
            write_json(path, meta)
            self._warm_at.pop(sha, None)
            print(f"[claude] uploaded {'a document' if OPEN else repr(name)} ({len(data) // 1024} KB)", flush=True)
        return sha, read_json(self.doc_dir(sha) / "notes.json")

    def _request(self, meta, task, turns=()):
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
            }, *turns],  # `turns`: the rest of a conversation that began with this task
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
            allowance.charge(u)
            print(f"[claude] cached document: {u.cache_creation_input_tokens} tokens written, "
                  f"{u.cache_read_input_tokens} already cached ({time.time() - t:.1f}s)", flush=True)

    def run(self, sha, label, task, on_text=None, turns=()):
        meta = self.meta(sha)
        allowance.check()
        self._ensure_warm(sha, meta)
        t = time.time()

        def go():
            with self.client().beta.messages.stream(max_tokens=64000, **self._request(meta, task, turns)) as stream:
                for text in stream.text_stream:
                    if on_text:
                        on_text(text)
                return stream.get_final_message()

        msg = self._call(go, sha)
        self._warm_at[sha] = time.time()
        u = msg.usage
        allowance.charge(u)
        print(f"[claude] {label}: {u.cache_read_input_tokens} cached + {u.input_tokens + u.cache_creation_input_tokens} new in, "
              f"{u.output_tokens} out ({time.time() - t:.1f}s)", flush=True)
        if msg.stop_reason == "refusal":
            raise ApiError(422, "refused", "Claude declined this request.")
        return "".join(b.text for b in msg.content if b.type == "text")

    # -- the jobs ------------------------------------------------------------

    KINDS = {"heading", "paragraph", "equation", "list", "caption", "table", "footnote", "reference", "other", "skip"}

    def layout(self, sha, page, lines):
        """Which of a page's lines make up each paragraph. → {"blocks": [{"kind", "lines": [id]}]} in reading order."""
        lines = [(int(ln["id"]), int(ln.get("x", 0)), int(ln.get("y", 0)), float(ln.get("size", 0)), " ".join(str(ln.get("text", "")).split())[:240])
                 for ln in lines[:2000]]
        key = hashlib.sha1(json.dumps([PROMPT_VERSION, page, lines]).encode()).hexdigest()[:16]
        path = self.doc_dir(sha) / "layout" / f"{page}-{key}.json"
        cached = read_json(path)
        if cached:
            return cached
        listing = "\n".join(f"{i} | x={x} y={y} size={size:g} | {text}" for i, x, y, size, text in lines)
        data = parse_json_answer(self.run(sha, f"find the paragraphs on page {page}", LAYOUT.format(page=page, lines=listing)))
        known, seen, blocks = {ln[0] for ln in lines}, set(), []
        for item in data.get("blocks", []):
            if not (isinstance(item, list) and len(item) == 2):
                continue
            kind, spec = item
            if isinstance(spec, list):
                spec = ",".join(str(x) for x in spec)
            ids = []
            for part in str(spec).split(","):
                lo, _, hi = part.strip().partition("-")
                try:
                    lo, hi = int(lo), int(hi or lo)
                except ValueError:
                    continue
                for i in range(lo, min(hi, lo + 2000) + 1):
                    if i in known and i not in seen:  # each line belongs to one block: the first that claims it
                        seen.add(i)
                        ids.append(i)
            if ids:
                blocks.append({"kind": kind if kind in self.KINDS else "other", "lines": ids})
        if not blocks:
            raise ApiError(502, "bad_output", "Claude's answer was not in the expected form.")
        result = {"blocks": blocks}
        write_json(path, result)
        return result

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

    def _file_lock(self, path):
        """One lock per file, for files that several requests read, change and write back."""
        with self._lock:
            return self._file_locks.setdefault(str(path), threading.Lock())

    def _glossary_path(self, sha, lang, english):
        return self.doc_dir(sha) / "glossary" / f"{lang}-{english}-v{PROMPT_VERSION}.{TRANSLATE_VERSION}.json"

    def glossary(self, sha, lang, language, english, wait=True):
        """The wording a document's translation into a language keeps to, worked out once.

        → [{"term", "say"}], or None if another request is working it out and `wait` is false.
        """
        path = self._glossary_path(sha, lang, english)
        lock = self._file_lock(path)
        if not lock.acquire(blocking=wait):
            return None
        try:
            known = read_json(path)
            if known is not None:
                return known.get("terms", [])
            task = GLOSSARY.format(language=language, english=ENGLISH[english].format(language=language))
            try:
                data = parse_json_answer(self.run(sha, f"settle the wording for {language}", task))
            except ApiError as e:
                if e.code != "bad_output":
                    raise
                data = {}  # kept as an empty glossary, rather than asked for again with every page
            clean = lambda v, n: " ".join(str(v).split())[:n]
            terms = [{"term": clean(t["term"], 120), "say": clean(t["say"], 200)}
                     for t in data.get("terms", []) if isinstance(t, dict) and t.get("term") and t.get("say")][:80]
            write_json(path, {"terms": terms})
            return terms
        finally:
            lock.release()

    def _glossary_later(self, sha, lang, language, english):
        """Start working out the glossary without waiting for it (nothing happens if that is under way)."""
        def go():
            try:
                self.glossary(sha, lang, language, english, wait=False)
            except ApiError as e:
                print(f"[claude] could not settle the wording for {language}: {e.message}", flush=True)
        threading.Thread(target=go, daemon=True).start()

    def translate(self, sha, page, pieces, lang, language, english, urgent, on_line):
        """Pieces of a page as they should be spoken in another language, each handed to
        `on_line({"id", "say"})` as soon as it is known.

        Translations are kept per piece, whichever request brought them (a page, or one paragraph
        of it), so only pieces never translated before are asked of Claude; a page request also
        waits for pieces another request is translating right now, rather than pay for them twice.
        A piece Claude leaves out is asked for once more on its own; one still missing after that
        goes unanswered. `english` is how much English the voice says the English way (see
        ENGLISH). `urgent`: someone is waiting to hear this, so nothing is waited for.
        """
        lang, language = language_of(lang, language)
        english = english if english in ENGLISH else "words"  # a page from before this was asked for
        pieces = [(str(p["id"]), " ".join(str(p["text"]).split())) for p in pieces[:400]]
        # A piece is known by its page and text: its id changes whenever the page's paragraphs do.
        # "13:0.0" is a piece of page 13 sent with page 12, the end of a sentence begun there.
        page_of = lambda pid: int(pid.split(":", 1)[0]) if ":" in pid else page
        keys = {pid: hashlib.sha1(json.dumps([page_of(pid), text]).encode()).hexdigest()[:16] for pid, text in pieces}
        store = self.doc_dir(sha) / "translated" / f"{lang}-{english}-v{PROMPT_VERSION}.{TRANSLATE_VERSION}.json"
        with self._lock:
            if str(store) not in self._said:
                self._said[str(store)] = (read_json(store) or {}).get("pieces", {})
            known, claims = self._said[str(store)], self._claims.setdefault(str(store), {})
        said = {}

        def from_cache():
            for pid, _ in pieces:
                if pid not in said and keys[pid] in known:
                    said[pid] = known[keys[pid]]
                    on_line({"id": pid, "say": said[pid]})

        from_cache()
        if all(pid in said for pid, _ in pieces):
            return
        if urgent:
            terms = (read_json(self._glossary_path(sha, lang, english)) or {}).get("terms")
            if terms is None:
                self._glossary_later(sha, lang, language, english)
        else:
            try:
                terms = self.glossary(sha, lang, language, english)
            except ApiError as e:  # the glossary only keeps the wording steady: translate without it
                print(f"[claude] could not settle the wording for {language}: {e.message}", flush=True)
                terms = None
            from_cache()  # including what other requests brought meanwhile
        until = time.time() + 120
        for _ in range(2):
            todo = [(pid, text) for pid, text in pieces if pid not in said]
            if not todo:
                break
            # Each piece is translated by the one request that claims it. A page request leaves pieces
            # another request is translating right now to that one, and waits for them, rather than
            # pay for them twice; someone waiting to hear a piece (`urgent`) asks for it regardless.
            mine, theirs = {}, []
            with self._lock:
                for pid, _ in todo:
                    key = keys[pid]
                    if key not in claims:
                        claims[key] = mine[key] = threading.Event()
                    elif not urgent:
                        theirs.append(claims[key])
            ask = [(pid, text) for pid, text in todo if urgent or keys[pid] in mine]

            def heard(line):  # kept the moment it arrives, so other requests can use it at once
                key = keys[line["id"]]
                known[key] = line["say"]
                with self._lock:
                    if key in mine:
                        claims.pop(key, None)
                        mine.pop(key).set()
                on_line(line)

            try:
                got = self._ask_translation(sha, page, language, english, terms, pieces, said, ask, heard) if ask else {}
            finally:
                with self._lock:
                    for key, event in mine.items():
                        claims.pop(key, None)
                        event.set()
            if got:
                said.update(got)
                with self._file_lock(store):
                    write_json(store, {"pieces": dict(known)})
            for event in theirs:
                event.wait(max(0.0, until - time.time()))
            from_cache()  # what the other requests brought (a piece they missed is asked for next time round)
        if not said:
            raise ApiError(502, "bad_output", "Claude's answer was not in the expected form.")

    def _ask_translation(self, sha, page, language, english, terms, pieces, said, todo, on_line):
        """One request to Claude for the pieces in `todo`, each passed to `on_line` as it comes. → {id: say}"""
        source, order, wanted = dict(pieces), [pid for pid, _ in pieces], {pid for pid, _ in todo}
        # Neighbours already translated come along, so a sentence split between pieces still fits together.
        near = [pid for i, pid in enumerate(order) if pid in said and (
            (i > 0 and order[i - 1] in wanted) or (i + 1 < len(order) and order[i + 1] in wanted))]
        context = glossary = ""
        if near:
            context = ("\nThese neighbouring pieces have been translated already. They are here only so that the pieces "
                       "below can run on from them and into them; don't answer for them:\n"
                       + "\n".join(f"{pid}: {source[pid]}\n  said as: {said[pid]}" for pid in near[:12]) + "\n")
        if terms:
            glossary = ("\nUse this wording every time these come up, so that every page says them the same way:\n"
                        + "\n".join(f"- {t['term']}: {t['say']}" for t in terms) + "\n")
        task = TRANSLATE.format(page=page, language=language, english=ENGLISH[english].format(language=language),
                                glossary=glossary, context=context, pieces="\n".join(f"{pid}: {text}" for pid, text in todo))
        got = {}

        def take(obj):
            pid, say = str(obj.get("id")), obj.get("say")
            # Some languages run longer than others, but not many times longer.
            if pid in wanted and pid not in got and isinstance(say, str) and len(say) <= 8 * len(source[pid]) + 200:
                got[pid] = " ".join(say.split())
                on_line({"id": pid, "say": got[pid]})

        feed, end = json_lines(take)
        answer = self.run(sha, f"translate page {page} into {language}", task, feed)
        end()
        if not got:  # written the way this used to be asked for, as one object
            try:
                lines = parse_json_answer(answer).get("lines", [])
            except ApiError:
                lines = []
            for obj in lines if isinstance(lines, list) else []:
                if isinstance(obj, dict):
                    take(obj)
        return got

    def explain(self, sha, page, text, before, after, on_text, question="", history=(), lang="", language=""):
        """Explain a paragraph aloud or, given a question about it, answer that instead.

        `history` is the conversation about this paragraph so far, as (question, answer) pairs;
        with it, `question` is a follow-up and Claude sees the earlier turns.
        """
        suffix = ""
        if lang:
            lang, language = language_of(lang, language)
            suffix = IN_LANGUAGE.format(language=language)
        key = hashlib.sha1(json.dumps([PROMPT_VERSION, page, text] + ([question] if question else []) + ([lang, TRANSLATE_VERSION] if lang else [])).encode()).hexdigest()[:16]
        path = self.doc_dir(sha) / "explain" / f"{key}.json"
        cached = None if history else read_json(path)  # a follow-up depends on what was said before it
        if cached:
            on_text(cached["text"])
            return
        context = ""
        if before or after:
            context = "\nTo help you find it on the page, the text just before it is:\n" + (before or "(nothing)") + \
                      "\nand the text just after it is:\n" + (after or "(nothing)") + "\n"
        first = history[0][0] if history else question  # what opened the conversation
        if first:
            label, task = "answer a question", ASK.format(page=page, context=context, text=text, question=first) + suffix
        else:
            label, task = "explain a paragraph", EXPLAIN.format(page=page, context=context, text=text) + suffix
        turns = []
        for i, (_, said) in enumerate(history):
            then = history[i + 1][0] if i + 1 < len(history) else question
            turns.append({"role": "assistant", "content": said})
            turns.append({"role": "user", "content": FOLLOW_UP.format(question=then or "Explain this paragraph.") + suffix})
        if history:
            label = "answer a follow-up"
        answer = self.run(sha, f"{label} on page {page}", task, on_text, turns)
        if answer.strip() and not history:
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
        origin = self.headers.get("Origin")
        if origin_allowed(origin) and self.path.startswith("/api/"):
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
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
        origins = {f"localhost:{PORT}": f"http://localhost:{PORT}", f"127.0.0.1:{PORT}": f"http://127.0.0.1:{PORT}"}
        if PUBLIC_HOST:
            origins = {PUBLIC_HOST: f"https://{PUBLIC_HOST}"}
        host, origin = self.headers.get("Host"), self.headers.get("Origin")
        if host not in origins or (origin and origin != origins[host] and not origin_allowed(origin)):
            return False
        return self.command != "POST" or self.headers.get("X-Reader") == "1"

    def _signed_in(self):
        """With a password set, every request needs it (HTTP Basic sign-in; any user name)."""
        if not PASSWORD:
            return True
        kind, _, value = (self.headers.get("Authorization") or "").partition(" ")
        try:
            given = base64.b64decode(value).decode().partition(":")[2]
        except ValueError:
            return False
        return kind.lower() == "basic" and hmac.compare_digest(given.encode(), PASSWORD.encode())

    def _gate(self):
        """Answer the requests that never reach the reader itself. True when the request is finished."""
        if urlparse(self.path).path == "/healthz":  # Render's check that the service is up
            self.send_response(200)
            self.send_header("Content-Type", "text/plain")
            self.send_header("Content-Length", "2")
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(b"ok")
            return True
        if not self._signed_in():
            self.send_response(401)
            self.send_header("WWW-Authenticate", 'Basic realm="Reader", charset="UTF-8"')
            self.send_header("Content-Length", "0")
            self.end_headers()
            return True
        return False

    def do_HEAD(self):
        if not self._gate():
            super().do_HEAD()

    def do_OPTIONS(self):
        """The browser's permission check before a page on another site may post to /api."""
        ok = origin_allowed(self.headers.get("Origin")) and self.path.startswith("/api/")
        self.send_response(204 if ok else 403)
        if ok:
            self.send_header("Access-Control-Allow-Methods", "GET, POST")
            self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Reader")
            self.send_header("Access-Control-Max-Age", "86400")
        self.send_header("Content-Length", "0")
        self.end_headers()

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
        if self._gate():
            return
        if not self.path.startswith("/api/"):
            return super().do_GET()
        if not self._allowed():
            return self._json({"error": "forbidden"}, 403)
        if urlparse(self.path).path == "/api/status":
            return self._json(status())
        self._json({"error": "not_found"}, 404)

    def do_POST(self):
        if self._gate():
            return
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
                return self._json(status())
            if url.path == "/api/phonemize":
                return self._json({"phonemes": phonemizer.run(req.get("texts"))})
            if url.path == "/api/speak":
                audio = speech.speak(req["text"], str(req.get("voice", "")), float(req.get("rate", 1)))
                self.send_response(200)
                self.send_header("Content-Type", "audio/mpeg")
                self.send_header("Content-Length", str(len(audio)))
                self.end_headers()
                return self.wfile.write(audio)
            if url.path == "/api/understand":
                return self._json(claude.understand(req["doc"]))
            if url.path == "/api/layout":
                return self._json(claude.layout(req["doc"], int(req["page"]), req["lines"]))
            if url.path == "/api/narrate":
                return self._json(claude.narrate(req["doc"], int(req["page"]), req["pieces"]))
            if url.path == "/api/translate":
                return self._translate(req)
            if url.path == "/api/glossary":  # asked for ahead of the first translation, which then needn't wait
                lang, language = language_of(req["lang"], req["language"])
                english = req.get("english") if req.get("english") in ENGLISH else "words"
                return self._json({"terms": len(claude.glossary(req["doc"], lang, language, english))})
            if url.path == "/api/explain":
                return self._explain(req)
            self._json({"error": "not_found"}, 404)
        except ApiError as e:
            self._json({"error": e.code, "message": e.message}, e.status)
        except (KeyError, ValueError, TypeError) as e:
            self._json({"error": "bad_request", "message": str(e)}, 400)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _translate(self, req):
        """Stream the translation one piece per line, then {"done": true}, so speech can start on the
        first sentence. A failure before the first line is an ordinary error reply; after it, a line
        {"error", "message"}."""
        started = gone = False

        def send(obj):
            nonlocal started, gone
            if gone:
                return
            try:
                if not started:
                    started = True
                    self.send_response(200)
                    self.send_header("Content-Type", "application/x-ndjson; charset=utf-8")
                    self.end_headers()
                self.wfile.write((json.dumps(obj, ensure_ascii=False) + "\n").encode())
                self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError):
                gone = True  # the page went away: carry on, so what Claude writes is still kept

        try:
            claude.translate(req["doc"], int(req["page"]), req["pieces"], req["lang"], req["language"],
                             str(req.get("english", "words")), bool(req.get("urgent")), send)
        except (ApiError, KeyError, ValueError, TypeError) as e:
            if not started:
                raise
            send({"error": getattr(e, "code", "bad_request"), "message": getattr(e, "message", str(e))})
            return
        send({"done": True})

    def _explain(self, req):
        """Stream the explanation as plain text, so speech can start on the first sentence."""
        started = False
        clean = lambda v: " ".join(str(v).split())

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
                           str(req.get("before", ""))[:600], str(req.get("after", ""))[:600], on_text,
                           clean(req.get("question", ""))[:1000],
                           [(clean(h.get("question", ""))[:1000], clean(h.get("answer", ""))[:6000])
                            for h in req.get("history", [])[-12:] if clean(h.get("answer", ""))],
                           str(req.get("lang", "")), str(req.get("language", "")))
            if not started:
                raise ApiError(502, "bad_output", "Claude returned nothing.")
        except ApiError:
            if started:  # already mid-stream: just end it
                return
            raise


if __name__ == "__main__":
    load_env_file()
    handler = functools.partial(Handler, directory=str(ROOT))
    with http.server.ThreadingHTTPServer((BIND, PORT), handler) as httpd:
        url = f"https://{PUBLIC_HOST}/" if PUBLIC_HOST else f"http://localhost:{PORT}/"
        state = claude.status()
        note = {"no_sdk": "off (start with 'uv run serve.py' to turn it on)", "no_key": "waiting for an API key", None: f"on, using {MODEL}"}
        print(f"Reader is running at {url}  (Ctrl+C to stop)", flush=True)
        print(f"Claude features: {note[state['reason']]}", flush=True)
        print(f"VieNeu Turbo voices: {'on' if phonemizer.available() else 'off (start with uv run serve.py, which installs sea-g2p)'}", flush=True)
        voices = speech.voices()
        print(f"Azure voices: {'on (' + ', '.join(voices) + ')' if voices else 'off (set AZURE_SPEECH_KEY and AZURE_SPEECH_REGION to turn them on)'}", flush=True)
        if OPEN:
            print(f"Open to anyone with the address; Claude use stops at ${DAILY_BUDGET:g} a day.", flush=True)
        elif HOSTED:
            print("Private: every request needs the password.", flush=True)
        if "--no-open" not in sys.argv and not HOSTED:
            threading.Timer(0.4, webbrowser.open, args=(url,)).start()
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print()
