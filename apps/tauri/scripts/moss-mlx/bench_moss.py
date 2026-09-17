#!/usr/bin/env python3
"""Unified MOSS-Transcribe-Diarize benchmark harness.

One instrumented entry point for both engines so numbers stay comparable:
  * torch-mps: PyTorch reference (the pre-quantization baseline), run with the
    dedicated venv at ~/Documents/lynse-app/moss-mlx/venv.
  * mlx: quantized MLX port (implemented in Step 2 of the moss-mlx plan).

Measured per run: model load time, decode wall time (excluding load), RTF,
peak RSS (psutil, 100 ms sampling), token counts, parsed segments. Results go
to a JSON file that eval_quality.py consumes later.

Usage:
  venv/bin/python bench_moss.py --engine torch-mps \
      --audio ~/Documents/lynse-app/moss-mlx/fixtures/meeting-5min.wav \
      --runs 3 --out ~/Documents/lynse-app/moss-mlx/results/baseline-torch.json
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
import threading
import time
import wave
from pathlib import Path

MOSS_HOME = Path("~/Documents/lynse-app/moss-mlx").expanduser()
DEFAULT_WEIGHTS = MOSS_HOME / "weights"
DEFAULT_MAX_NEW_TOKENS = 16384  # same as the baseline bench.sh invocation


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--engine", choices=["torch-mps", "mlx"], required=True)
    p.add_argument("--audio", required=True, type=Path)
    p.add_argument("--weights", type=Path, default=DEFAULT_WEIGHTS,
                   help="Model directory (torch: HF layout with remote code; mlx: converted port).")
    p.add_argument("--runs", type=int, default=3)
    p.add_argument("--max-new-tokens", type=int, default=DEFAULT_MAX_NEW_TOKENS)
    p.add_argument("--label", default="", help="Name recorded in the report (defaults to engine).")
    p.add_argument("--out", required=True, type=Path, help="Report JSON path.")
    return p.parse_args()


class RssSampler:
    """Samples RSS (and MPS allocated memory when available) every 100 ms."""

    def __init__(self) -> None:
        import psutil

        self._proc = psutil.Process()
        self._stop = threading.Event()
        self.rss_peak = 0
        self.mps_peak = 0
        self._thread = threading.Thread(target=self._loop, daemon=True)

    def _loop(self) -> None:
        while not self._stop.is_set():
            self.rss_peak = max(self.rss_peak, self._proc.memory_info().rss)
            try:
                import torch

                if torch.backends.mps.is_available():
                    self.mps_peak = max(self.mps_peak, torch.mps.current_allocated_memory())
            except Exception:
                pass
            self._stop.wait(0.1)

    def __enter__(self) -> "RssSampler":
        self._thread.start()
        return self

    def __exit__(self, *exc) -> None:
        self._stop.set()
        self._thread.join(timeout=1.0)


def audio_duration_sec(path: Path) -> float:
    with wave.open(str(path), "rb") as w:
        return w.getnframes() / float(w.getframerate())


def sha1_of(obj) -> str:
    return hashlib.sha1(json.dumps(obj, ensure_ascii=False, sort_keys=True).encode()).hexdigest()


def bench_torch_once(weights: Path, audio: Path, max_new_tokens: int) -> dict:
    """One load+generate cycle on the PyTorch reference path."""
    import torch
    from transformers import AutoModelForCausalLM, AutoProcessor

    from moss_transcribe_diarize.inference_utils import (
        build_transcription_messages,
        generate_transcription,
    )
    from moss_transcribe_diarize.transcript_parser import parse_transcript

    sampler = RssSampler()
    with sampler:
        t0 = time.perf_counter()
        model = AutoModelForCausalLM.from_pretrained(
            str(weights), trust_remote_code=True, dtype="auto", attn_implementation="sdpa"
        )
        processor = AutoProcessor.from_pretrained(str(weights), trust_remote_code=True)
        model.to(torch.device("mps"))
        load_sec = time.perf_counter() - t0

        messages = build_transcription_messages(str(audio))
        t1 = time.perf_counter()
        out = generate_transcription(
            model, processor, messages, device=torch.device("mps"),
            max_new_tokens=max_new_tokens, do_sample=False,
        )
        decode_sec = time.perf_counter() - t1
        del model, processor

    text = out["text"]
    segments = [
        {"start": s.start, "end": s.end, "speaker": s.speaker, "text": s.text}
        for s in parse_transcript(text)
    ]
    speakers = sorted({s["speaker"] for s in segments})
    return {
        "load_sec": round(load_sec, 3),
        "decode_sec": round(decode_sec, 3),
        "prompt_len": out.get("prompt_len"),
        "generated_tokens": out.get("generated_tokens"),
        "rss_peak_mb": round(sampler.rss_peak / (1024 * 1024), 1),
        "mps_alloc_peak_mb": round(sampler.mps_peak / (1024 * 1024), 1),
        "text": text,
        "segments": segments,
        "n_segments": len(segments),
        "speakers": speakers,
        "text_sha1": sha1_of(text),
        "segments_sha1": sha1_of(segments),
    }


def bench_mlx_once(weights: Path, audio: Path, max_new_tokens: int) -> dict:
    """One load+generate cycle on the MLX port."""
    import sys
    import time as _time

    import mlx.core as mx
    import soundfile as sf

    repo_root = Path(__file__).resolve().parents[4]
    resources = repo_root / "apps" / "tauri" / "src-tauri" / "resources"
    if str(resources) not in sys.path:
        sys.path.insert(0, str(resources))

    from mlx_lm.models.cache import make_prompt_cache  # noqa: F401 (warm import)

    from moss_mlx.generate import generate
    from moss_mlx.transcript_parser import parse_transcript
    from moss_mlx.weights import load_model, load_processor

    sampler = RssSampler()
    with sampler:
        t0 = _time.perf_counter()
        model, cfg = load_model(weights)
        proc = load_processor(weights)
        load_sec = _time.perf_counter() - t0
        import mlx.core as _mx

        _mx.metal.clear_cache()
        _mx.metal.reset_peak_memory()

        waveform, sr = sf.read(str(audio), dtype="float32")
        assert sr == 16000
        feats, lengths = proc.features(waveform)
        before, span, after = proc.encode_prompt_split(sum(lengths))
        audio_embeds = model.audio_embeds(feats, lengths)
        mx.eval(audio_embeds)

        t1 = _time.perf_counter()
        first_seg = {"t": None}

        def on_segment(seg):
            if first_seg["t"] is None:
                first_seg["t"] = _time.perf_counter() - t1

        ids = generate(
            model, proc.tokenizer, before, span, audio_embeds, after,
            eos_id=cfg["eos_token_id"], max_new_tokens=max_new_tokens,
            on_segment=on_segment,
        )
        decode_sec = _time.perf_counter() - t1
        mlx_peak_mb = _mx.metal.get_peak_memory() / (1024 * 1024)
        del model, proc

    # model freed above; decode token ids via a fresh lightweight tokenizer
    text = decode_ids(weights, ids)
    segments = [
        {"start": s.start, "end": s.end, "speaker": s.speaker, "text": s.text}
        for s in parse_transcript(text)
    ]
    speakers = sorted({s["speaker"] for s in segments})
    return {
        "load_sec": round(load_sec, 3),
        "decode_sec": round(decode_sec, 3),
        "prompt_len": len(before) + len(span) + len(after),
        "generated_tokens": len(ids),
        "rss_peak_mb": round(sampler.rss_peak / (1024 * 1024), 1),
        "mps_alloc_peak_mb": None,
        "gpu_alloc_peak_mb": round(mlx_peak_mb, 1),
        "first_segment_sec": round(first_seg["t"], 3) if first_seg["t"] else None,
        "text": text,
        "segments": segments,
        "n_segments": len(segments),
        "speakers": speakers,
        "text_sha1": sha1_of(text),
        "segments_sha1": sha1_of(segments),
    }


def decode_ids(weights: Path, ids: list[int]) -> str:
    from tokenizers import Tokenizer

    tok = Tokenizer.from_file(str(weights.expanduser() / "tokenizer.json"))
    return tok.decode(ids)


def main() -> int:
    args = parse_args()
    audio = args.audio.expanduser()
    if not audio.exists():
        print(f"audio not found: {audio}", file=sys.stderr)
        return 2

    duration = audio_duration_sec(audio)
    run_fn = bench_torch_once if args.engine == "torch-mps" else bench_mlx_once
    runs = []
    for i in range(args.runs):
        print(f"[bench] run {i + 1}/{args.runs} loading+decoding {audio.name} ({duration:.1f}s audio)...",
              flush=True)
        r = run_fn(args.weights.expanduser(), audio, args.max_new_tokens)
        r["rtf"] = round(r["decode_sec"] / duration, 4)
        print(f"[bench]   load={r['load_sec']}s decode={r['decode_sec']}s rtf={r['rtf']} "
              f"segments={r['n_segments']} speakers={len(r['speakers'])} "
              f"rss_peak={r['rss_peak_mb']}MB", flush=True)
        runs.append(r)

    def median(vals):
        vals = sorted(vals)
        n = len(vals)
        return vals[n // 2] if n % 2 else (vals[n // 2 - 1] + vals[n // 2]) / 2

    report = {
        "label": args.label or args.engine,
        "engine": args.engine,
        "weights": str(args.weights),
        "audio": str(audio),
        "audio_sec": round(duration, 2),
        "runs": runs,
        "summary": {
            "cold_load_sec": runs[0]["load_sec"],
            "warm_load_sec_median": round(median([r["load_sec"] for r in runs[1:]]), 3) if len(runs) > 1 else None,
            "decode_sec_median": round(median([r["decode_sec"] for r in runs]), 3),
            "rtf_median": round(median([r["rtf"] for r in runs]), 4),
            "rss_peak_mb_median": round(median([r["rss_peak_mb"] for r in runs]), 1),
            "n_segments_median": median([r["n_segments"] for r in runs]),
            "n_speakers": [len(r["speakers"]) for r in runs],
            "all_runs_same_text": len({r["text_sha1"] for r in runs}) == 1,
        },
    }
    args.out.expanduser().parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(report, ensure_ascii=False, indent=2))
    print(f"[bench] report -> {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
