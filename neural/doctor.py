"""Report Python, PyTorch, CUDA, GPU memory, and optional checkpoint readiness."""

import argparse
import json
import platform
import sys
import time
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--checkpoint", default="artifacts/transformer/model.pt")
    parser.add_argument("--benchmark", action="store_true", help="run three full 512-token training updates; creates no checkpoint")
    parser.add_argument("--batch-size", type=int, default=16)
    parser.add_argument("--device", choices=("auto", "cpu", "cuda"), default="auto")
    args = parser.parse_args()
    result = {"python": sys.executable, "pythonVersion": platform.python_version(),
              "checkpoint": str(Path(args.checkpoint).resolve()), "checkpointExists": Path(args.checkpoint).is_file()}
    try:
        import torch
        torch.set_num_threads(2)
        result.update(torch=str(torch.__version__), cudaBuild=torch.version.cuda, cudaAvailable=torch.cuda.is_available())
        if torch.cuda.is_available():
            gpu = torch.cuda.get_device_properties(0)
            free, total = torch.cuda.mem_get_info()
            result.update(gpu=gpu.name, computeCapability=f"{gpu.major}.{gpu.minor}",
                          totalVramMiB=round(total / 2**20), freeVramMiB=round(free / 2**20))
        if result["checkpointExists"]:
            try:
                from .model import load_checkpoint, metadata
            except ImportError:
                from model import load_checkpoint, metadata
            model, checkpoint = load_checkpoint(args.checkpoint, torch.device("cpu"))
            result["model"] = metadata(model, checkpoint, args.checkpoint)
        if args.benchmark:
            if not 1 <= args.batch_size <= 128:
                raise ValueError("batch-size must be 1–128")
            try:
                from .model import TransformerValue, choose_device
            except ImportError:
                from model import TransformerValue, choose_device
            device = choose_device(args.device)
            benchmark_model = TransformerValue().to(device).train()
            batch = args.batch_size
            categories = torch.zeros((batch, 512, 5), dtype=torch.long, device=device)
            coordinates = torch.zeros((batch, 512, 7), device=device)
            coordinates[:, :, 1] = torch.arange(512, device=device)
            global_features = torch.zeros((batch, 32), device=device)
            padding = torch.zeros((batch, 512), dtype=torch.bool, device=device)
            optimizer = torch.optim.AdamW(benchmark_model.parameters(), lr=0.0003)
            scaler = torch.amp.GradScaler("cuda", enabled=device.type == "cuda")
            if device.type == "cuda":
                torch.cuda.reset_peak_memory_stats()
                torch.cuda.synchronize()
            start = time.perf_counter()
            for _ in range(3):
                optimizer.zero_grad(set_to_none=True)
                with torch.autocast(device_type=device.type, dtype=torch.float16, enabled=device.type == "cuda"):
                    loss = benchmark_model(categories, coordinates, global_features, padding).float().square().mean()
                scaler.scale(loss).backward()
                scaler.unscale_(optimizer)
                torch.nn.utils.clip_grad_norm_(benchmark_model.parameters(), 1.0)
                scaler.step(optimizer)
                scaler.update()
            if device.type == "cuda":
                torch.cuda.synchronize()
            result["benchmark"] = {"device": str(device), "batchSize": batch, "tokens": 512, "steps": 3,
                                   "seconds": round(time.perf_counter() - start, 3),
                                   "parameters": sum(parameter.numel() for parameter in benchmark_model.parameters())}
            if device.type == "cuda":
                result["benchmark"].update(peakAllocatedMiB=round(torch.cuda.max_memory_allocated() / 2**20, 1),
                                            peakReservedMiB=round(torch.cuda.max_memory_reserved() / 2**20, 1))
    except Exception as error:
        result["error"] = str(error)
    print(json.dumps(result, indent=2))
    return 1 if "error" in result else 0


if __name__ == "__main__":
    raise SystemExit(main())
