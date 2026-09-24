"""Context-budget integration tests; run python -m unittest neural.test_context_config."""

from dataclasses import asdict
import importlib.util
import json
import math
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from neural.encoding import ENCODING_VERSION, MAX_TOKENS

ROOT = Path(__file__).resolve().parents[1]


@unittest.skipUnless(importlib.util.find_spec("torch"), "PyTorch is not installed")
class ContextConfigTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        import torch
        torch.set_num_threads(2)

    def checkpoint(self, path):
        import torch
        from neural.model import ARCHITECTURE, ModelConfig, TransformerValue
        model = TransformerValue(ModelConfig(width=32, heads=4, layers=1, feedforward=64,
                                             max_tokens=512, dropout=0))
        torch.save({"architecture": ARCHITECTURE, "encodingVersion": ENCODING_VERSION,
                    "config": asdict(model.config), "state_dict": model.state_dict(),
                    "trainedSteps": 1}, path)
        return model

    def test_legacy_checkpoint_predicts_with_current_context_without_rewriting(self):
        import torch
        from neural.model import load_checkpoint, metadata, predict
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "legacy.pt"
            original = self.checkpoint(path)
            saved_bytes = path.read_bytes()
            model, checkpoint = load_checkpoint(path, torch.device("cpu"))
            self.assertEqual(model.config.max_tokens, 4096)
            self.assertEqual(checkpoint["config"]["max_tokens"], 512)
            self.assertEqual(metadata(model, checkpoint, path)["config"]["max_tokens"], MAX_TOKENS)
            self.assertTrue(all(torch.equal(before, after) for before, after in
                                zip(original.parameters(), model.parameters())))
            # Overflow by one complete board, exercising the actual 4,096-token
            # inference path and attention after distance-based truncation.
            position = {"board": [[[[12, 11]] for _ in range(1366)]], "action": 1}
            values, contexts = predict(model, [position], torch.device("cpu"))
            self.assertTrue(math.isfinite(values[0]))
            self.assertEqual(contexts[0]["tokens"], 4096)
            self.assertEqual(contexts[0]["totalTokens"], 4099)
            self.assertTrue(contexts[0]["truncated"])
            self.assertFalse(contexts[0]["frontierTruncated"])
            self.assertEqual(path.read_bytes(), saved_bytes)

    def test_default_and_explicit_resumed_training_budgets(self):
        import torch
        with tempfile.TemporaryDirectory() as directory:
            directory = Path(directory)
            baseline, output, data = (directory / name for name in ("legacy.pt", "output.pt", "data.jsonl"))
            self.checkpoint(baseline)
            data.write_text(json.dumps({"position": {"board": [[[[12]]]], "action": 0}, "value": 100}) + "\n",
                            encoding="utf-8")
            base = [sys.executable, "neural/train.py", "--data", str(data), "--resume", str(baseline),
                    "--output", str(output), "--device", "cpu", "--steps", "1", "--batch-size", "1"]
            for arguments, expected in (([], 4096), (["--max-tokens", "64"], 64)):
                with self.subTest(arguments=arguments):
                    completed = subprocess.run(base + arguments, capture_output=True, text=True, cwd=ROOT, timeout=60)
                    self.assertEqual(completed.returncode, 0, completed.stderr)
                    start = json.loads(completed.stdout.splitlines()[0])
                    self.assertEqual(start["config"]["max_tokens"], expected)
                    trained = torch.load(output, map_location="cpu", weights_only=True)
                    self.assertEqual(trained["config"]["max_tokens"], expected)
                    self.assertEqual(trained["trainedSteps"], 2)
            self.assertEqual(torch.load(baseline, map_location="cpu", weights_only=True)["config"]["max_tokens"], 512)

    def test_resumed_training_rejects_budget_above_limit(self):
        import torch
        from neural.model import ModelConfig, load_checkpoint
        self.assertEqual(ModelConfig().max_tokens, 4096)
        with self.assertRaisesRegex(ValueError, "max_tokens"):
            ModelConfig(max_tokens=4097)
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "legacy.pt"
            self.checkpoint(path)
            with self.assertRaisesRegex(ValueError, "max_tokens"):
                load_checkpoint(path, torch.device("cpu"), max_tokens=4097)


if __name__ == "__main__":
    unittest.main()
