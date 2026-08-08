import unittest

try:
    from webui import webui as app
except ImportError:
    import webui as app


class TtsChunkingTests(unittest.TestCase):
    def test_qwen3_uses_coarse_webui_transport_chunks(self):
        profile = app.profile_for({"family": "qwen3_tts"})
        self.assertEqual(profile["chunk_chars"], 1000)

    def test_qwen3_long_text_avoids_one_request_per_inner_chunk(self):
        profile = app.profile_for({"family": "qwen3_tts"})
        text = "长" * 10000
        chunks = app._split_tts_chunks(text, profile["chunk_chars"])
        self.assertEqual(len(chunks), 10)
        self.assertEqual("".join(chunks), text)

    def test_unspaced_long_cjk_sentence_is_hard_split_without_loss(self):
        text = "长" * 10000
        chunks = app._split_tts_chunks(text, 200)
        self.assertEqual("".join(chunks), text)
        self.assertTrue(chunks)
        self.assertTrue(all(0 < len(chunk) <= 200 for chunk in chunks))

    def test_overlong_latin_sentence_prefers_word_boundaries(self):
        text = " ".join(["harbor"] * 100)
        chunks = app._split_tts_chunks(text, 40)
        self.assertEqual(" ".join(" ".join(chunks).split()), text)
        self.assertTrue(all(0 < len(chunk) <= 40 for chunk in chunks))
        self.assertTrue(all(not chunk.startswith(" ") and not chunk.endswith(" ")
                            for chunk in chunks))


if __name__ == "__main__":
    unittest.main()
