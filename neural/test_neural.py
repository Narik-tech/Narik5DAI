"""Run with python -m unittest neural.test_neural (model tests require PyTorch)."""

import copy
from dataclasses import asdict
import importlib.util
import json
import math
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
if __package__ in (None, ""):
    sys.path.insert(0, str(ROOT))

from neural.encoding import ENCODING_VERSION, encode_position


def position():
    return {"board": [[[[12, 0], [0, -11]], [[12, 2], [0, -11]]]], "action": 1, "promotions": [9, 10]}


class EncodingTests(unittest.TestCase):
    def test_history_geometry_unmoved_and_side_survive(self):
        encoded = encode_position(position())
        self.assertEqual(len(encoded.global_features), 32)
        self.assertFalse(encoded.context["truncated"])
        self.assertTrue(any(c[1] == 11 and c[2] == 1 for c in encoded.categories))
        self.assertEqual({c[1] for c in encoded.coordinates[1:]}, {0, 1})
        self.assertEqual({c[4] for c in encoded.coordinates[1:]}, {0, 1})
        changed = position()
        changed["board"][0][0][0][1] = 4
        self.assertNotEqual(encode_position(changed).categories, encoded.categories)
        changed = position()
        changed["action"] = 2
        self.assertNotEqual(encode_position(changed).global_features, encoded.global_features)

    def test_frontier_preserved_and_history_sampling_deterministic(self):
        source = position()
        source["board"][0] = [copy.deepcopy(source["board"][0][1]) for _ in range(30)]
        encoded = encode_position(source, 16)
        self.assertEqual(encoded.context["tokens"], 16)
        self.assertTrue(encoded.context["truncated"])
        self.assertFalse(encoded.context["frontierTruncated"])
        self.assertEqual(sum(c[4] == 1 for c in encoded.categories), 4)
        self.assertEqual(encoded, encode_position(source, 16))
        historic_times = {coordinate[1] for category, coordinate in zip(encoded.categories[1:], encoded.coordinates[1:]) if not category[4]}
        self.assertIn(0, historic_times)
        self.assertIn(28, historic_times)

    def test_frontier_overflow_disclosed_and_royals_prioritized(self):
        squares = [[2] * 8 for _ in range(8)]
        squares[0][0], squares[7][7] = 12, 11
        encoded = encode_position({"board": [[squares]], "action": 0}, 16)
        self.assertTrue(encoded.context["frontierTruncated"])
        self.assertEqual({11, 12} & {category[1] for category in encoded.categories}, {11, 12})

    def test_even_timelines_use_upstream_coordinates(self):
        source = position()
        source["board"] = [None, source["board"][0], source["board"][0]]
        encoded = encode_position(source)
        self.assertEqual({coordinate[0] for coordinate in encoded.coordinates[1:]}, {-1, 0})
        self.assertEqual(encoded.global_features[6], 1)

    def test_invalid_input_rejected(self):
        for invalid in ({}, {"board": [], "action": 0}, {"board": [[[[25]]]], "action": 0},
                        {"board": [[[[True]]]], "action": 0}, {"board": [[[[0], [0, 0]]]], "action": 0}):
            with self.assertRaises(ValueError):
                encode_position(invalid)


@unittest.skipUnless(importlib.util.find_spec("torch"), "PyTorch is not installed")
class ModelTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        import torch
        torch.set_num_threads(2)

    def test_training_updates_weights_and_checkpoint_roundtrips(self):
        import torch
        from neural.model import ARCHITECTURE, ModelConfig, TransformerValue, collate, load_checkpoint, predict
        torch.manual_seed(23)
        model = TransformerValue(ModelConfig(width=32, heads=4, layers=1, feedforward=64, max_tokens=64, dropout=0))
        batch = collate([encode_position(position(), 64)], torch.device("cpu"))
        target = torch.tensor([0.5])
        optimizer = torch.optim.AdamW(model.parameters(), lr=0.003)
        before = torch.nn.functional.mse_loss(model(*batch), target).item()
        for _ in range(12):
            optimizer.zero_grad()
            loss = torch.nn.functional.mse_loss(model(*batch), target)
            loss.backward()
            optimizer.step()
        after = torch.nn.functional.mse_loss(model(*batch), target).item()
        self.assertLess(after, before)
        with tempfile.TemporaryDirectory() as directory:
            checkpoint = Path(directory) / "model.pt"
            torch.save({"architecture": ARCHITECTURE, "encodingVersion": ENCODING_VERSION,
                        "config": asdict(model.config), "state_dict": model.state_dict(), "trainedSteps": 12}, checkpoint)
            loaded, _ = load_checkpoint(checkpoint, torch.device("cpu"))
            self.assertEqual(predict(model, [position()], torch.device("cpu")), predict(loaded, [position()], torch.device("cpu")))
            response = subprocess.run([sys.executable, "neural/service.py", "--checkpoint", str(checkpoint), "--device", "cpu"],
                                      input=json.dumps({"id": "test", "positions": [position()]}) + "\n" + json.dumps({"id": "bad", "positions": [{}]}) + "\n",
                                      capture_output=True, text=True, cwd=ROOT, timeout=60)
            self.assertEqual(response.returncode, 0, response.stderr)
            messages = [json.loads(line) for line in response.stdout.splitlines()]
            self.assertTrue(messages[0]["ready"])
            self.assertEqual(messages[1]["id"], "test")
            self.assertTrue(math.isfinite(messages[1]["values"][0]))
            self.assertIn("error", messages[2])

    def test_padding_does_not_change_single_position_value(self):
        import torch
        from neural.model import ModelConfig, TransformerValue, predict
        torch.manual_seed(11)
        model = TransformerValue(ModelConfig(width=32, heads=4, layers=1, feedforward=64, max_tokens=64, dropout=0))
        larger = position()
        larger["board"][0].extend(copy.deepcopy(larger["board"][0]))
        alone, _ = predict(model, [position()], torch.device("cpu"))
        batched, _ = predict(model, [position(), larger], torch.device("cpu"))
        self.assertAlmostEqual(alone[0], batched[0], delta=0.01)

    def test_missing_and_untrained_checkpoints_fail_closed(self):
        import torch
        from neural.model import ARCHITECTURE, load_checkpoint
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "absent.pt"
            with self.assertRaises(FileNotFoundError):
                load_checkpoint(path, torch.device("cpu"))
            torch.save({"architecture": ARCHITECTURE, "encodingVersion": ENCODING_VERSION, "trainedSteps": 0}, path)
            with self.assertRaisesRegex(ValueError, "no completed training steps"):
                load_checkpoint(path, torch.device("cpu"))

    def test_training_cli_and_resume(self):
        with tempfile.TemporaryDirectory() as directory:
            data = Path(directory) / "train.jsonl"
            output = Path(directory) / "model.pt"
            data.write_text(json.dumps({"position": position(), "value": 400}) + "\n", encoding="utf-8")
            command = [sys.executable, "neural/train.py", "--data", str(data), "--output", str(output), "--device", "cpu",
                       "--steps", "2", "--batch-size", "2", "--width", "32", "--layers", "1", "--feedforward", "64", "--max-tokens", "64"]
            first = subprocess.run(command, capture_output=True, text=True, cwd=ROOT, timeout=60)
            self.assertEqual(first.returncode, 0, first.stderr)
            self.assertEqual(json.loads(first.stdout.splitlines()[-1])["trainedSteps"], 2)
            second = subprocess.run(command + ["--resume", str(output)], capture_output=True, text=True, cwd=ROOT, timeout=60)
            self.assertEqual(second.returncode, 0, second.stderr)
            self.assertEqual(json.loads(second.stdout.splitlines()[-1])["trainedSteps"], 4)

    def test_best_output_preserves_better_resumed_baseline_and_evaluation(self):
        import torch
        from neural.model import ARCHITECTURE, ModelConfig, TransformerValue
        with tempfile.TemporaryDirectory() as directory:
            directory = Path(directory)
            data, validation = directory / "train.jsonl", directory / "validation.jsonl"
            baseline, latest, best = (directory / name for name in ("baseline.pt", "latest.pt", "best.pt"))
            data.write_text(json.dumps({"position": position(), "value": 1000}) + "\n", encoding="utf-8")
            validation.write_text((json.dumps({"position": position(), "value": 0}) + "\n") * 3, encoding="utf-8")
            model = TransformerValue(ModelConfig(width=32, heads=4, layers=1, feedforward=64, max_tokens=64, dropout=0))
            with torch.no_grad():
                model.head[3].weight.zero_()
                model.head[3].bias.zero_()
            torch.save({"architecture": ARCHITECTURE, "encodingVersion": ENCODING_VERSION,
                        "config": asdict(model.config), "state_dict": model.state_dict(),
                        "trainedSteps": 4, "examplesSeen": 8, "label": "fixture",
                        "training": {"note": "baseline provenance"}}, baseline)
            command = [sys.executable, "neural/train.py", "--data", str(data), "--validation-data", str(validation),
                       "--resume", str(baseline), "--output", str(latest), "--best-output", str(best),
                       "--device", "cpu", "--steps", "2", "--batch-size", "2", "--save-every", "1"]
            trained = subprocess.run(command, capture_output=True, text=True, cwd=ROOT, timeout=60)
            self.assertEqual(trained.returncode, 0, trained.stderr)
            result = json.loads(trained.stdout.splitlines()[-1])
            self.assertEqual(result["trainedSteps"], 6)
            self.assertEqual(result["baselineValidation"]["samples"], 3)
            self.assertLessEqual(result["bestValidation"]["mse"], result["baselineValidation"]["mse"])
            self.assertGreater(result["validation"]["mse"], result["bestValidation"]["mse"])
            best_payload = torch.load(best, weights_only=True)
            self.assertEqual(best_payload["trainedSteps"], 4)
            self.assertEqual(best_payload["training"]["note"], "baseline provenance")
            self.assertEqual(torch.load(latest, weights_only=True)["trainedSteps"], 6)
            evaluated = subprocess.run([sys.executable, "neural/evaluate.py", "--data", str(validation),
                                        "--checkpoints", str(best), str(latest), "--device", "cpu", "--batch-size", "2"],
                                       capture_output=True, text=True, cwd=ROOT, timeout=60)
            self.assertEqual(evaluated.returncode, 0, evaluated.stderr)
            report = json.loads(evaluated.stdout)
            self.assertEqual(len(report["checkpoints"]), 2)
            self.assertEqual(report["checkpoints"][0]["samples"], 3)
            self.assertEqual(report["checkpoints"][0]["normalizedMse"], 0)
            self.assertEqual(report["checkpoints"][0]["maeClippedCp"], 0)
            self.assertGreater(report["checkpoints"][1]["normalizedMse"], 0)


if __name__ == "__main__":
    unittest.main()
