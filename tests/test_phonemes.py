"""Tests for the phonemes the VieNeu Turbo voices read: python3 -m unittest discover -s tests -v

sea-g2p itself is faked, so these check how the server calls it, not the phonemes it writes.
"""
import sys
import types
import unittest
import unittest.mock
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
_argv, sys.argv = sys.argv, sys.argv[:1]  # serve.py reads a port from the command line
import serve  # noqa: E402
sys.argv = _argv


class FakePipeline:
    made = 0

    def __init__(self, lang):
        assert lang == "vi"
        FakePipeline.made += 1
        self.calls = []

    def run(self, text, punc_norm=False):
        self.calls.append((text, punc_norm))
        return f"/{text}/"


class PhonemesTest(unittest.TestCase):
    def setUp(self):
        FakePipeline.made = 0
        self.patch = unittest.mock.patch.object(serve, "sea_g2p", types.SimpleNamespace(SEAPipeline=FakePipeline))
        self.patch.start()
        self.phonemizer = serve.Phonemizer()

    def tearDown(self):
        self.patch.stop()

    def test_each_text_is_phonemized_in_order_with_punctuation_settled(self):
        self.assertEqual(self.phonemizer.run(["Xin chào", "  Kết   quả \n"]), ["/Xin chào/", "/Kết quả/"])
        self.assertEqual(self.phonemizer._pipeline.calls, [("Xin chào", True), ("Kết quả", True)])

    def test_the_pipeline_is_made_once(self):
        self.phonemizer.run(["một"])
        self.phonemizer.run(["hai"])
        self.assertEqual(FakePipeline.made, 1)

    def test_empty_text_has_no_phonemes(self):
        self.assertEqual(self.phonemizer.run(["", "   "]), ["", ""])

    def test_too_many_or_not_a_list_is_refused(self):
        for bad in [None, "một", ["x"] * (serve.MAX_PHONEMIZE + 1)]:
            with self.assertRaises(serve.ApiError) as e:
                self.phonemizer.run(bad)
            self.assertEqual(e.exception.code, "bad_request")

    def test_long_text_is_cut(self):
        out = self.phonemizer.run(["a" * (serve.MAX_PHONEMIZE_TEXT + 50)])
        self.assertEqual(len(out[0]), serve.MAX_PHONEMIZE_TEXT + 2)

    def test_without_sea_g2p_the_voices_are_off(self):
        with unittest.mock.patch.object(serve, "sea_g2p", None):
            self.assertFalse(serve.Phonemizer().available())
            self.assertFalse(serve.status()["phonemes"])
            with self.assertRaises(serve.ApiError) as e:
                serve.Phonemizer().run(["một"])
        self.assertEqual(e.exception.code, "phonemes_off")

    def test_the_status_says_so_when_it_is_there(self):
        self.assertTrue(serve.status()["phonemes"])


if __name__ == "__main__":
    unittest.main()
