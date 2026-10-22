"""Offline contract checks. No real service, real key, or paid generation."""
import base64
import importlib.util
import io
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from PIL import Image

SPEC = importlib.util.spec_from_file_location("image_api", Path(__file__).resolve().parents[1] / "scripts" / "image_api.py")
api = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(api)
FAKE_KEY = "test-local-only-not-a-real-key"


def png(alpha=True):
    image = Image.new("RGBA" if alpha else "RGB", (8, 6), (255, 0, 0, 255) if alpha else (255, 0, 0))
    if alpha:
        image.putpixel((0, 0), (0, 0, 0, 0))
        image.putpixel((1, 0), (255, 0, 0, 128))
    data = io.BytesIO()
    image.save(data, "PNG")
    return data.getvalue()


class ImageApiTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.output = self.root / "output"
        self.config_file = self.root / "config.json"
        self.jobs_file = self.root / "jobs.json"
        self.config = {"protocol": "openai-images", "base_url": "https://api.example.invalid/v1",
                       "model": "test-image-model", "api_key_env": "LSF_TEST_IMAGE_KEY"}
        self.job = {"id": "E01", "prompt": "controlled test asset", "transparent": True, "expected_size": [8, 6]}
        self.config_file.write_text(json.dumps(self.config), encoding="utf-8")
        self.jobs_file.write_text(json.dumps([self.job]), encoding="utf-8")
        env = patch.dict(os.environ, {"LSF_TEST_IMAGE_KEY": FAKE_KEY})
        env.start()
        self.addCleanup(env.stop)

    def test_check_makes_no_network_requests(self):
        with patch.object(api, "fetch", side_effect=AssertionError("network must not run")):
            result = api.run(self.config_file, self.jobs_file, self.output, check=True)
        self.assertEqual(result["network_requests"], 0)
        self.assertFalse(self.output.exists())

    def test_inline_keys_and_remote_plain_http_are_rejected(self):
        for invalid in [{**self.config, "api_key": "not-a-real-key"},
                        {**self.config, "base_url": "http://remote.example.invalid/v1"}]:
            self.config_file.write_text(json.dumps(invalid), encoding="utf-8")
            with self.assertRaises(ValueError):
                api.load_config(self.config_file)

    def test_duplicate_ids_are_rejected_before_network(self):
        self.jobs_file.write_text(json.dumps([self.job, self.job]), encoding="utf-8")
        with patch.object(api, "fetch", side_effect=AssertionError("network must not run")):
            with self.assertRaisesRegex(ValueError, "unique"):
                api.run(self.config_file, self.jobs_file, self.output)

    def test_actual_png_pixels_alpha_and_no_resize_are_recorded(self):
        data = png()
        with patch.object(api, "generate", return_value=data) as generate:
            result = api.run(self.config_file, self.jobs_file, self.output)
        self.assertEqual(generate.call_count, 1)
        item = result["results"][0]
        self.assertEqual(item["status"], "succeeded")
        self.assertEqual(item["pixels"], [8, 6])
        self.assertTrue(item["transparent_pixels"])
        self.assertTrue(item["semi_transparent_pixels"])
        self.assertFalse(item["resized"])
        self.assertEqual(Path(item["file"]).read_bytes(), data)
        self.assertEqual(result["automatic_retries"], 0)

    def test_opaque_foreground_is_needs_review(self):
        with patch.object(api, "generate", return_value=png(False)):
            result = api.run(self.config_file, self.jobs_file, self.output)
        self.assertEqual(result["results"][0]["status"], "needs_review")

    def test_wrong_size_retains_original_asset_for_review(self):
        self.job["expected_size"] = [16, 12]
        self.jobs_file.write_text(json.dumps([self.job]), encoding="utf-8")
        with patch.object(api, "generate", return_value=png()):
            result = api.run(self.config_file, self.jobs_file, self.output)
        item = result["results"][0]
        self.assertEqual(item["status"], "needs_review")
        self.assertEqual(item["pixels"], [8, 6])
        self.assertTrue(Path(item["file"]).exists())

    def test_existing_asset_is_not_overwritten_or_regenerated(self):
        with patch.object(api, "generate", return_value=png()) as generate:
            first = api.run(self.config_file, self.jobs_file, self.output)
            before = Path(first["results"][0]["file"]).read_bytes()
            second = api.run(self.config_file, self.jobs_file, self.output)
        self.assertEqual(generate.call_count, 1)
        self.assertEqual(second["results"][0]["status"], "failed")
        self.assertEqual(Path(first["results"][0]["file"]).read_bytes(), before)

    def test_unknown_outcome_has_no_automatic_retry_and_redacts(self):
        error = api.ProviderError("unknown outcome " + FAKE_KEY + " https://example.invalid/private", status="unknown")
        with patch.object(api, "generate", side_effect=error) as generate:
            result = api.run(self.config_file, self.jobs_file, self.output)
        self.assertEqual(generate.call_count, 1)
        self.assertEqual(result["results"][0]["status"], "unknown")
        self.assertNotIn(FAKE_KEY, json.dumps(result))
        self.assertNotIn("https://example.invalid/private", json.dumps(result))

    def test_image_url_download_does_not_receive_api_auth(self):
        config, key = api.load_config(self.config_file)
        job = {**self.job, "_images": []}
        response = json.dumps({"data": [{"url": "https://cdn.example.invalid/image.png"}]}).encode()
        with patch.object(api, "fetch", side_effect=[response, png()]) as fetch:
            self.assertEqual(api.generate(config, key, job), png())
        self.assertIn("Authorization", fetch.call_args_list[0].kwargs["headers"])
        self.assertNotIn("headers", fetch.call_args_list[1].kwargs)

    def test_gemini_ignores_thought_images(self):
        config, key = api.load_config(self.config_file)
        config["protocol"] = "gemini-generate-content"
        response = {"candidates": [{"content": {"parts": [
            {"thought": True, "inlineData": {"data": "not-an-image"}},
            {"inlineData": {"data": base64.b64encode(png()).decode()}}
        ]}}]}
        with patch.object(api, "fetch", return_value=json.dumps(response).encode()):
            self.assertEqual(api.generate(config, key, {**self.job, "_images": []}), png())


if __name__ == "__main__":
    unittest.main()
