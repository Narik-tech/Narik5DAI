"""Train a bounded-memory Transformer value model on JSONL {position,value} rows.

Values are white-relative centipawns, transformed to tanh(value / 1000). This is
supervised value learning; heuristic labels bootstrap a model but prove no
playing strength. Supply independent validation data to measure generalization.
"""

import argparse
from dataclasses import asdict
from datetime import datetime, timezone
import json
import hashlib
import math
import os
from pathlib import Path
import random
import sys
import time

MAX_LINE_BYTES = 32 * 1024 * 1024


def records(path, max_tokens):
    try:
        from .encoding import encode_position
    except ImportError:
        from encoding import encode_position
    with open(path, "rb") as stream:
        line_number = 0
        while True:
            line = stream.readline(MAX_LINE_BYTES + 1)
            if not line:
                return
            line_number += 1
            if len(line) > MAX_LINE_BYTES:
                raise ValueError(f"{path}:{line_number}: row exceeds 32 MiB")
            if not line.strip():
                continue
            try:
                row = json.loads(line)
                value = row["value"]
                if type(value) not in (int, float) or not math.isfinite(value):
                    raise ValueError("value must be finite white-relative centipawns")
                yield encode_position(row["position"], max_tokens), math.tanh(value / 1000)
            except (KeyError, TypeError, ValueError) as error:
                raise ValueError(f"{path}:{line_number}: {error}") from error


def stream_training(path, max_tokens, buffer_size, rng):
    # Only encoded, bounded-token records enter the shuffle buffer. No complete
    # dataset or collection of full multiverse histories is retained in RAM.
    while True:
        buffer, count = [], 0
        for record in records(path, max_tokens):
            count += 1
            if len(buffer) < buffer_size:
                buffer.append(record)
            else:
                index = rng.randrange(len(buffer))
                yield buffer[index]
                buffer[index] = record
        rng.shuffle(buffer)
        yield from buffer
        if count == 0:
            raise ValueError(f"training file has no examples: {path}")


def write_checkpoint(path, payload):
    """Publish a complete checkpoint atomically, including baseline copies."""
    import torch
    output = Path(path)
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_name(output.name + ".tmp")
    try:
        torch.save(payload, temporary)
        os.replace(temporary, output)
    finally:
        if temporary.exists():
            temporary.unlink()


def save_checkpoint(path, model, optimizer, steps, examples, args, loss, validation, selection=None):
    import torch
    try:
        from .model import ARCHITECTURE
        from .encoding import ENCODING_VERSION
    except ImportError:
        from model import ARCHITECTURE
        from encoding import ENCODING_VERSION
    payload = {"architecture": ARCHITECTURE, "encodingVersion": ENCODING_VERSION,
               "config": asdict(model.config), "state_dict": model.state_dict(),
               "optimizer": optimizer.state_dict(), "trainedSteps": steps,
               "examplesSeen": examples, "label": args.label,
               "createdAt": datetime.now(timezone.utc).isoformat(),
               "training": {"data": str(Path(args.data).resolve()), "seed": args.seed,
                            "dataSha256": args.data_sha256,
                            "batchSize": args.batch_size, "learningRate": args.learning_rate,
                            "loss": loss, "validation": validation,
                            "torchVersion": str(torch.__version__)}}
    if selection is not None:
        payload["selection"] = selection
    write_checkpoint(path, payload)


def validation_loss(model, path, device, batch_size, max_batches):
    try:
        from .evaluate import evaluate_records
    except ImportError:
        from evaluate import evaluate_records
    metrics = evaluate_records(model, records(path, model.config.max_tokens), device, batch_size, max_batches)
    metrics["mse"] = metrics.pop("normalizedMse")
    return {**metrics, "data": str(Path(path).resolve())}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data", default="artifacts/transformer/training.jsonl")
    parser.add_argument("--output", default="artifacts/transformer/model.pt")
    parser.add_argument("--resume", help="continue optimizer/model from a checkpoint; --steps is additional updates")
    parser.add_argument("--device", choices=("auto", "cpu", "cuda"), default="auto")
    parser.add_argument("--steps", type=int, default=1000)
    parser.add_argument("--batch-size", type=int, default=16)
    parser.add_argument("--learning-rate", type=float, default=0.0003)
    parser.add_argument("--weight-decay", type=float, default=0.01)
    parser.add_argument("--shuffle-buffer", type=int, default=128)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--threads", type=int, default=2)
    parser.add_argument("--save-every", type=int, default=100)
    parser.add_argument("--log-every", type=int, default=10)
    parser.add_argument("--validation-data")
    parser.add_argument("--validation-batches", type=int, default=16)
    parser.add_argument("--best-output", help="save lowest-validation-MSE checkpoint separately, including a resumed baseline if it remains best")
    parser.add_argument("--label", default="Experimental supervised value model; strength unverified")
    parser.add_argument("--width", type=int, default=128)
    parser.add_argument("--heads", type=int, default=4)
    parser.add_argument("--layers", type=int, default=4)
    parser.add_argument("--feedforward", type=int, default=384)
    parser.add_argument("--max-tokens", type=int, default=512)
    parser.add_argument("--dropout", type=float, default=0.1)
    args = parser.parse_args()
    try:
        import torch
        try:
            from .model import ModelConfig, TransformerValue, choose_device, collate, load_checkpoint
        except ImportError:
            from model import ModelConfig, TransformerValue, choose_device, collate, load_checkpoint
        if args.steps < 1 or not 1 <= args.batch_size <= 128 or not 1 <= args.shuffle_buffer <= 4096:
            raise ValueError("steps must be positive, batch-size 1–128, shuffle-buffer 1–4096")
        if not 1 <= args.threads <= 32 or min(args.save_every, args.log_every, args.validation_batches) < 1:
            raise ValueError("threads must be 1–32; save/log/validation intervals must be positive")
        if not math.isfinite(args.learning_rate) or args.learning_rate <= 0 or not math.isfinite(args.weight_decay) or args.weight_decay < 0:
            raise ValueError("learning-rate must be positive and weight-decay nonnegative")
        if args.best_output and not args.validation_data:
            raise ValueError("--best-output requires --validation-data")
        if args.best_output and Path(args.best_output).resolve() == Path(args.output).resolve():
            raise ValueError("--best-output must differ from --output so latest and best checkpoints remain separate")
        torch.set_num_threads(args.threads)
        data_hash = hashlib.sha256()
        with open(args.data, "rb") as data_stream:
            for chunk in iter(lambda: data_stream.read(1024 * 1024), b""):
                data_hash.update(chunk)
        args.data_sha256 = data_hash.hexdigest()
        torch.manual_seed(args.seed)
        rng = random.Random(args.seed)
        device = choose_device(args.device)
        checkpoint = {}
        if args.resume:
            model, checkpoint = load_checkpoint(args.resume, device)
        else:
            config = ModelConfig(args.width, args.heads, args.layers, args.feedforward, args.max_tokens, args.dropout)
            model = TransformerValue(config).to(device)
        optimizer = torch.optim.AdamW(model.parameters(), lr=args.learning_rate, weight_decay=args.weight_decay)
        if "optimizer" in checkpoint:
            optimizer.load_state_dict(checkpoint["optimizer"])
            for group in optimizer.param_groups:
                group["lr"], group["weight_decay"] = args.learning_rate, args.weight_decay
        scaler = torch.amp.GradScaler("cuda", enabled=device.type == "cuda")
        stream = iter(stream_training(args.data, model.config.max_tokens, args.shuffle_buffer, rng))
        previous_steps = checkpoint.get("trainedSteps", 0)
        examples = checkpoint.get("examplesSeen", 0)
        updates, attempts, truncated = 0, 0, 0
        started = time.perf_counter()
        if device.type == "cuda":
            torch.cuda.reset_peak_memory_stats()
        model.train()
        print(json.dumps({"event": "start", "device": str(device), "config": asdict(model.config),
                          "parameters": sum(parameter.numel() for parameter in model.parameters()),
                          "additionalSteps": args.steps, "previousSteps": previous_steps}), flush=True)
        baseline_validation = validation_loss(model, args.validation_data, device, args.batch_size, args.validation_batches) if args.validation_data else None
        # An untrained baseline can be measured but cannot become a playable
        # checkpoint. A resumed, trained baseline is eligible immediately.
        best_validation = baseline_validation if previous_steps else None
        best_step = previous_steps if previous_steps and baseline_validation else None
        selection = {"baselineValidation": baseline_validation, "baselineStep": previous_steps,
                     "bestValidation": best_validation, "bestStep": best_step} if baseline_validation else None
        if baseline_validation:
            print(json.dumps({"event": "validation_baseline", "step": previous_steps,
                              "validation": baseline_validation, "eligibleForBest": bool(previous_steps)}), flush=True)
            if args.best_output and previous_steps:
                # Keep original training provenance for an unchanged baseline.
                write_checkpoint(args.best_output, {**checkpoint, "selection": selection})
        while updates < args.steps:
            attempts += 1
            if attempts > args.steps * 10:
                raise RuntimeError("too many skipped nonfinite AMP updates; reduce learning rate")
            rows = [next(stream) for _ in range(args.batch_size)]
            batch = collate([row[0] for row in rows], device)
            targets = torch.tensor([row[1] for row in rows], dtype=torch.float32, device=device)
            optimizer.zero_grad(set_to_none=True)
            with torch.autocast(device_type=device.type, dtype=torch.float16, enabled=device.type == "cuda"):
                prediction = model(*batch)
                loss = torch.nn.functional.mse_loss(prediction.float(), targets)
            if not torch.isfinite(loss):
                raise RuntimeError("nonfinite training loss; reduce learning rate or inspect data")
            scaler.scale(loss).backward()
            scaler.unscale_(optimizer)
            torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            previous_scale = scaler.get_scale()
            scaler.step(optimizer)
            scaler.update()
            if scaler.get_scale() < previous_scale:
                continue
            updates += 1
            examples += args.batch_size
            truncated += sum(row[0].context["truncated"] for row in rows)
            trained_steps = previous_steps + updates
            loss_value = float(loss.item())
            if updates == 1 or updates % args.log_every == 0 or updates == args.steps:
                print(json.dumps({"event": "train", "step": trained_steps, "loss": loss_value,
                                  "examplesSeen": examples, "truncatedExamplesThisRun": truncated,
                                  "seconds": round(time.perf_counter() - started, 3)}), flush=True)
            if updates % args.save_every == 0 or updates == args.steps:
                validation = validation_loss(model, args.validation_data, device, args.batch_size, args.validation_batches) if args.validation_data else None
                improved = validation is not None and (best_validation is None or validation["mse"] < best_validation["mse"])
                if improved:
                    best_validation, best_step = validation, trained_steps
                if selection is not None:
                    selection = {**selection, "bestValidation": best_validation, "bestStep": best_step}
                save_checkpoint(args.output, model, optimizer, trained_steps, examples, args, loss_value, validation, selection)
                if args.best_output and improved:
                    save_checkpoint(args.best_output, model, optimizer, trained_steps, examples, args, loss_value, validation, selection)
                if validation is not None:
                    print(json.dumps({"event": "validation", "step": trained_steps, "validation": validation,
                                      "baselineValidation": baseline_validation, "bestValidation": best_validation,
                                      "bestStep": best_step, "improved": improved}), flush=True)
        result = {"event": "complete", "output": str(Path(args.output).resolve()),
                  "trainedSteps": previous_steps + updates, "loss": loss_value,
                  "validation": validation, "seconds": round(time.perf_counter() - started, 3)}
        if selection is not None:
            result.update(selection)
        if args.best_output:
            result["bestOutput"] = str(Path(args.best_output).resolve())
        if device.type == "cuda":
            result.update(peakAllocatedMiB=round(torch.cuda.max_memory_allocated() / 2**20, 1),
                          peakReservedMiB=round(torch.cuda.max_memory_reserved() / 2**20, 1))
        print(json.dumps(result), flush=True)
        return 0
    except Exception as error:
        print(json.dumps({"event": "error", "error": str(error)}), file=sys.stderr, flush=True)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
