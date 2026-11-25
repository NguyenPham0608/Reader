"""Tests for speaking with Azure's voices: python3 -m unittest discover -s tests -v

Azure itself is faked by a small local server that answers as told, so these run offline.
"""
import http.server
import os
import sys
import tempfile
import threading
import unittest
import unittest.mock
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
_argv, sys.argv = sys.argv, sys.argv[:1]  # serve.py reads a port from the command line
import serve  # noqa: E402
sys.argv = _argv

AUDIO = b"ID3 pretend mp3"


class FakeAzure(http.server.BaseHTTPRequestHandler):
    replies = []  # statuses to answer with, in turn (200 once they run out)
    heard = []  # (headers, body) of each request

    def do_POST(self):
        body = self.rfile.read(int(self.headers["Content-Length"]))
        FakeAzure.heard.append((self.headers, body.decode()))  # header names in any case, as HTTP has them
        status = FakeAzure.replies.pop(0) if FakeAzure.replies else 200
        self.send_response(status)
        if status == 429:
            self.send_header("Retry-After", "0")
        self.send_header("Content-Length", str(len(AUDIO) if status == 200 else 0))
        self.end_headers()
        if status == 200:
            self.wfile.write(AUDIO)

    def log_message(self, *args):
        pass


class SpeechTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), FakeAzure)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.url = f"http://127.0.0.1:{cls.server.server_port}/cognitiveservices/v1"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()

    def setUp(self):
        FakeAzure.replies, FakeAzure.heard = [], []
        env = {"AZURE_SPEECH_KEY": "test-key", "AZURE_SPEECH_ENDPOINT": self.url}
        self.env = unittest.mock.patch.dict(os.environ, env)
        self.env.start()

    def tearDown(self):
        self.env.stop()

    def test_without_a_key_there_are_no_voices_and_nothing_is_asked(self):
        with unittest.mock.patch.dict(os.environ, {"AZURE_SPEECH_KEY": ""}):
            self.assertEqual(serve.speech.voices(), [])
            with self.assertRaises(serve.ApiError) as e:
                serve.speech.speak("Xin chào", "vi-VN-HoaiMyNeural")
        self.assertEqual(e.exception.code, "speech_off")
        self.assertEqual(FakeAzure.heard, [])

    def test_a_region_names_azures_address(self):
        with unittest.mock.patch.dict(os.environ, {"AZURE_SPEECH_ENDPOINT": "", "AZURE_SPEECH_REGION": "West US 2"}):
            self.assertEqual(serve.speech.endpoint()[0], "https://westus2.tts.speech.microsoft.com/cognitiveservices/v1")
        with unittest.mock.patch.dict(os.environ, {"AZURE_SPEECH_ENDPOINT": "", "AZURE_SPEECH_REGION": "evil.example/x?"}):
            self.assertEqual(serve.speech.endpoint(), (None, None))

    def test_a_sentence_is_sent_as_ssml_with_the_key_and_comes_back_as_mp3(self):
        audio = serve.speech.speak("Tốc độ <nhanh> & chậm", "vi-VN-HoaiMyNeural")
        self.assertEqual(audio, AUDIO)
        headers, body = FakeAzure.heard[0]
        self.assertEqual(headers["Ocp-Apim-Subscription-Key"], "test-key")
        self.assertEqual(headers["X-Microsoft-OutputFormat"], "audio-24khz-48kbitrate-mono-mp3")
        self.assertEqual(headers["Content-Type"], "application/ssml+xml")
        self.assertIn('xml:lang="vi-VN"><voice name="vi-VN-HoaiMyNeural">Tốc độ &lt;nhanh&gt; &amp; chậm</voice>', body)
        self.assertNotIn("prosody", body)  # billed by the character: only when the pace changes

    def test_another_pace_is_asked_for_with_prosody(self):
        serve.speech.speak("Một hai ba", "vi-VN-NamMinhNeural", 1.25)
        serve.speech.speak("Một hai ba", "vi-VN-NamMinhNeural", 9)
        self.assertIn('<prosody rate="1.25">Một hai ba</prosody>', FakeAzure.heard[0][1])
        self.assertIn('<prosody rate="2.00">', FakeAzure.heard[1][1])

    def test_only_the_offered_voices_can_be_asked_for(self):
        with self.assertRaises(serve.ApiError) as e:
            serve.speech.speak("Hello", "en-US-JennyNeural")
        self.assertEqual(e.exception.code, "bad_request")
        self.assertEqual(FakeAzure.heard, [])

    def test_too_many_requests_is_waited_out(self):
        FakeAzure.replies = [429, 429]
        self.assertEqual(serve.speech.speak("Xin chào", "vi-VN-HoaiMyNeural"), AUDIO)
        self.assertEqual(len(FakeAzure.heard), 3)

    def test_refusals_say_why(self):
        for status, code in [(401, "speech_auth"), (403, "speech_quota"), (400, "speech")]:
            FakeAzure.replies = [status]
            with self.assertRaises(serve.ApiError) as e:
                serve.speech.speak("Xin chào", "vi-VN-HoaiMyNeural")
            self.assertEqual(e.exception.code, code)
        FakeAzure.replies = [429, 429, 429]
        with self.assertRaises(serve.ApiError) as e:
            serve.speech.speak("Xin chào", "vi-VN-HoaiMyNeural")
        self.assertEqual(e.exception.code, "speech_busy")

    def test_unreachable_azure_is_offline(self):
        with unittest.mock.patch.dict(os.environ, {"AZURE_SPEECH_ENDPOINT": "http://127.0.0.1:9/nothing"}):
            with self.assertRaises(serve.ApiError) as e:
                serve.speech.speak("Xin chào", "vi-VN-HoaiMyNeural")
        self.assertEqual(e.exception.code, "offline")

    def test_the_status_lists_the_voices(self):
        self.assertEqual(serve.status()["speech"], ["vi-VN-HoaiMyNeural", "vi-VN-NamMinhNeural"])

    def test_speaking_counts_toward_the_daily_allowance_when_open(self):
        with unittest.mock.patch.object(serve, "OPEN", True), unittest.mock.patch.object(serve, "allowance", serve.Allowance()):
            serve.speech.speak("x" * 1000, "vi-VN-HoaiMyNeural")
            self.assertAlmostEqual(serve.allowance._spent, 1000 * serve.SPEECH_PRICE / 1e6)

    def test_the_env_file_sets_azures_key_without_overriding_the_environment(self):
        with tempfile.TemporaryDirectory() as tmp:
            env_file = Path(tmp) / ".env"
            env_file.write_text("ANTHROPIC_API_KEY=a\nAZURE_SPEECH_KEY='from-file'\nAZURE_SPEECH_REGION=westus2\nOTHER=x\n")
            with unittest.mock.patch.object(serve, "ENV_FILE", env_file), \
                    unittest.mock.patch.dict(os.environ, {"AZURE_SPEECH_KEY": "", "AZURE_SPEECH_REGION": "", "ANTHROPIC_API_KEY": "set"}):
                serve.load_env_file()
                self.assertEqual(os.environ["AZURE_SPEECH_KEY"], "from-file")
                self.assertEqual(os.environ["AZURE_SPEECH_REGION"], "westus2")
                self.assertEqual(os.environ["ANTHROPIC_API_KEY"], "set")
                self.assertNotIn("OTHER", os.environ)


if __name__ == "__main__":
    unittest.main()
