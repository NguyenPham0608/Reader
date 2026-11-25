"""Tests for the server's translation pipeline: python3 -m unittest discover -s tests -v

Claude itself is faked: `FakeClaude.run` answers from the task it is given, so these run offline.
"""
import json
import re
import sys
import tempfile
import threading
import time
import unittest
import unittest.mock
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
_argv, sys.argv = sys.argv, sys.argv[:1]  # serve.py reads a port from the command line
import serve  # noqa: E402
sys.argv = _argv

SHA = "a" * 64


def asked(task):
    """The pieces a translation task asks for, as {id: text}."""
    body = task.split("\nPieces:\n", 1)[1].split("\n\nAnswer", 1)[0]
    return dict(line.split(": ", 1) for line in body.splitlines() if line)


class FakeClaude(serve.Claude):
    def __init__(self, leave_out=(), leave_out_always=(), garbage=False):
        super().__init__()
        self.calls = []  # (label, task)
        self.documents = []  # whether each call had the document
        self.later = []  # glossaries started without waiting
        self.leave_out, self.leave_out_always, self.garbage = set(leave_out), set(leave_out_always), garbage

    hold = None  # (entered, release): the first translation waits for `release` once it has started

    def run(self, sha, label, task, on_text=None, turns=(), document=True):
        self.calls.append((label, task))
        self.documents.append(document)
        if self.hold and label.startswith("translate"):
            (entered, release), self.hold = self.hold, None
            entered.set()
            release.wait(5)
        if "wording" in label:
            text = json.dumps({"terms": [{"term": "system block", "say": "khối hệ"}]})
        elif self.garbage:
            text = "Sorry, I can't format that."
        else:
            lines = []
            for pid, text in asked(task).items():
                if pid in self.leave_out_always or pid in self.leave_out:
                    self.leave_out.discard(pid)
                    continue
                lines.append(json.dumps({"id": pid, "say": f"VI {text}"}, ensure_ascii=False))
            text = "```\n" + "\n".join(lines) + "\n```"
        if on_text:
            for i in range(0, len(text), 7):  # streamed in small, arbitrary pieces
                on_text(text[i:i + 7])
        return text

    def _glossary_later(self, sha, lang, language, english):
        self.later.append(lang)

    def translations(self):
        return [task for label, task in self.calls if label.startswith("translate")]


def pieces(*ids):
    return [{"id": i, "text": f"sentence {i}"} for i in ids]


class TranslateTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self._cache, serve.CACHE = serve.CACHE, Path(self.tmp.name)

    def tearDown(self):
        serve.CACHE = self._cache
        self.tmp.cleanup()

    def translate(self, claude, page, ps, english="none", urgent=True):
        out = []
        claude.translate(SHA, page, ps, "vi-VN", "Vietnamese", english, urgent, out.append)
        return {line["id"]: line["say"] for line in out}

    def test_json_lines_reads_objects_split_across_chunks(self):
        got = []
        feed, end = serve.json_lines(got.append)
        for chunk in ['```\n{"id": "1.0", "sa', 'y": "một"}\n', 'not json\n{"id": "1.1", ', '"say": "hai"},', '\n{"id": "1.2", "say": "ba"}']:
            feed(chunk)
        end()
        self.assertEqual([g["id"] for g in got], ["1.0", "1.1", "1.2"])

    def test_second_request_for_the_same_pieces_is_served_from_the_cache(self):
        claude = FakeClaude()
        first = self.translate(claude, 2, pieces("1.0", "1.1"))
        second = self.translate(claude, 2, pieces("1.0", "1.1"))
        self.assertEqual(first, {"1.0": "VI sentence 1.0", "1.1": "VI sentence 1.1"})
        self.assertEqual(second, first)
        self.assertEqual(len(claude.translations()), 1)

    def test_only_uncached_pieces_are_asked_for_with_their_translated_neighbours_as_context(self):
        claude = FakeClaude()
        self.translate(claude, 2, pieces("1.0"))
        got = self.translate(claude, 2, pieces("1.0", "1.1", "1.2"))
        self.assertEqual(set(got), {"1.0", "1.1", "1.2"})
        task = claude.translations()[-1]
        self.assertEqual(set(asked(task)), {"1.1", "1.2"})
        self.assertIn("1.0: sentence 1.0\n  said as: VI sentence 1.0", task)

    def test_a_piece_left_out_is_asked_for_again_on_its_own(self):
        claude = FakeClaude(leave_out={"1.1"})
        got = self.translate(claude, 2, pieces("1.0", "1.1", "1.2"))
        self.assertEqual(set(got), {"1.0", "1.1", "1.2"})
        self.assertEqual(set(asked(claude.translations()[-1])), {"1.1"})

    def test_a_piece_left_out_twice_is_not_answered(self):
        claude = FakeClaude(leave_out_always={"1.1"})
        got = self.translate(claude, 2, pieces("1.0", "1.1"))
        self.assertEqual(set(got), {"1.0"})
        self.assertEqual(len(claude.translations()), 2)

    def test_an_answer_with_no_pieces_at_all_is_an_error(self):
        with self.assertRaises(serve.ApiError) as e:
            self.translate(FakeClaude(garbage=True), 2, pieces("1.0"))
        self.assertEqual(e.exception.code, "bad_output")

    def test_an_answer_in_the_old_single_object_form_is_accepted(self):
        claude = FakeClaude()
        claude.run = lambda sha, label, task, on_text=None, turns=(), document=True: json.dumps(
            {"lines": [{"id": "1.0", "say": "một"}]}) if label.startswith("translate") else '{"terms": []}'
        self.assertEqual(self.translate(claude, 2, pieces("1.0")), {"1.0": "một"})

    def test_a_page_request_waits_for_the_glossary_and_uses_it(self):
        claude = FakeClaude()
        self.translate(claude, 2, pieces("1.0"), urgent=False)
        self.translate(claude, 3, pieces("1.0"), urgent=False)
        labels = [label for label, _ in claude.calls]
        self.assertEqual(sum("wording" in label for label in labels), 1)
        self.assertTrue("wording" in labels[0])
        self.assertIn("- system block: khối hệ", claude.translations()[0])

    def test_an_urgent_request_does_not_wait_for_the_glossary(self):
        claude = FakeClaude()
        self.translate(claude, 2, pieces("1.0"), urgent=True)
        self.assertEqual([label for label, _ in claude.calls if "wording" in label], [])
        self.assertEqual(claude.later, ["vi-VN"])
        self.assertNotIn("Use this wording", claude.translations()[0])

    def test_the_voice_changes_the_prompt_and_is_cached_apart(self):
        claude = FakeClaude()
        self.translate(claude, 2, pieces("1.0"), english="none")
        self.translate(claude, 2, pieces("1.0"), english="words")
        none, words = claude.translations()
        self.assertIn("pronounces everything as Vietnamese", none)
        self.assertIn("says English words", words)

    def test_an_unknown_voice_hint_means_english_words(self):
        claude = FakeClaude()
        self.translate(claude, 2, pieces("1.0"), english="klingon")
        self.assertIn("says English words", claude.translations()[0])

    def test_a_piece_from_the_next_page_is_cached_under_that_page(self):
        claude = FakeClaude()
        self.translate(claude, 2, [{"id": "4.3", "text": "The lattice is split into four"}, {"id": "3:0.0", "text": "blocks: two large ones."}])
        got = self.translate(claude, 3, [{"id": "0.0", "text": "blocks: two large ones."}])
        self.assertEqual(got, {"0.0": "VI blocks: two large ones."})
        self.assertEqual(len(claude.translations()), 1)

    def test_a_page_request_waits_for_pieces_another_request_is_translating(self):
        claude, entered, release = FakeClaude(), threading.Event(), threading.Event()
        claude.hold = (entered, release)
        urgent = threading.Thread(target=self.translate, args=(claude, 2, pieces("1.0")), kwargs={"urgent": True})
        urgent.start()
        self.assertTrue(entered.wait(5))
        page = {}
        later = threading.Thread(target=lambda: page.update(self.translate(claude, 2, pieces("1.0", "1.1"), urgent=False)))
        later.start()
        time.sleep(0.3)  # the page request is now waiting on 1.0
        release.set()
        urgent.join(5)
        later.join(5)
        self.assertEqual(page, {"1.0": "VI sentence 1.0", "1.1": "VI sentence 1.1"})
        self.assertEqual([set(asked(t)) for t in claude.translations()], [{"1.0"}, {"1.1"}])

    def test_a_page_request_whose_pieces_another_request_brings_is_not_an_error(self):
        claude, entered, release = FakeClaude(), threading.Event(), threading.Event()
        claude.hold = (entered, release)
        urgent = threading.Thread(target=self.translate, args=(claude, 2, pieces("1.0")), kwargs={"urgent": True})
        urgent.start()
        self.assertTrue(entered.wait(5))
        page, errors = {}, []

        def later():
            try:
                page.update(self.translate(claude, 2, pieces("1.0"), urgent=False))
            except serve.ApiError as e:
                errors.append(e)

        waiting = threading.Thread(target=later)
        waiting.start()
        time.sleep(0.3)
        release.set()
        urgent.join(5)
        waiting.join(5)
        self.assertEqual(errors, [])
        self.assertEqual(page, {"1.0": "VI sentence 1.0"})
        self.assertEqual(len(claude.translations()), 1)

    def test_a_page_request_asks_for_the_rest_while_another_request_brings_some(self):
        claude, entered, release = FakeClaude(), threading.Event(), threading.Event()
        claude.hold = (entered, release)
        urgent = threading.Thread(target=self.translate, args=(claude, 2, pieces("1.0")), kwargs={"urgent": True})
        urgent.start()
        self.assertTrue(entered.wait(5))
        got = []
        waiting = threading.Thread(target=lambda: claude.translate(SHA, 2, pieces("1.0", "1.1"), "vi-VN", "Vietnamese", "none", False, got.append))
        waiting.start()
        for _ in range(50):  # 1.1 comes while 1.0 is still held up in the other request
            if got:
                break
            time.sleep(0.05)
        self.assertEqual([line["id"] for line in got], ["1.1"])
        release.set()
        urgent.join(5)
        waiting.join(5)
        self.assertEqual(sorted(line["id"] for line in got), ["1.0", "1.1"])

    def test_a_quick_request_goes_without_the_document_or_the_glossary(self):
        claude = FakeClaude()
        out = []
        claude.translate(SHA, 1, pieces("0.0", "1.0"), "vi-VN", "Vietnamese", "words", True, out.append, quick=True)
        self.assertEqual({line["id"] for line in out}, {"0.0", "1.0"})
        self.assertEqual(claude.documents, [False])
        self.assertEqual(claude.later, [])  # the glossary is left to the pages' requests, which come with the document
        self.assertIn("isn't attached to this request", claude.translations()[0])
        self.assertIn("(quick)", claude.calls[0][0])
        # What it brought is there for the page's own request, which asks only for the rest.
        self.translate(claude, 1, pieces("0.0", "1.0", "2.0"), english="words", urgent=False)
        self.assertEqual(set(asked(claude.translations()[-1])), {"2.0"})
        self.assertTrue(claude.documents[-1])

    def test_the_glossary_can_be_worked_out_ahead(self):
        claude = FakeClaude()
        self.assertEqual(claude.glossary(SHA, "vi-VN", "Vietnamese", "none"), [{"term": "system block", "say": "khối hệ"}])
        self.translate(claude, 2, pieces("1.0"), urgent=True)
        self.assertIn("- system block: khối hệ", claude.translations()[0])

    def test_the_status_names_the_prompt_version_the_page_keys_its_answers_by(self):
        with unittest.mock.patch.dict("os.environ", {"ANTHROPIC_API_KEY": "test"}), \
                unittest.mock.patch.object(serve, "anthropic", serve.anthropic or object()):  # as if the SDK were installed
            status = FakeClaude().status()
        self.assertTrue(status["available"])
        self.assertEqual(status["cache"], f"{serve.PROMPT_VERSION}.{serve.TRANSLATE_VERSION}")

    def test_the_prompt_asks_for_numbers_in_words_and_no_identifiers(self):
        claude = FakeClaude()
        self.translate(claude, 2, pieces("1.0"))
        task = claude.translations()[0]
        self.assertRegex(task, r"never as digits")
        self.assertTrue(re.search(r"DOIs.*web and email addresses.*postal codes", task))


if __name__ == "__main__":
    unittest.main()
