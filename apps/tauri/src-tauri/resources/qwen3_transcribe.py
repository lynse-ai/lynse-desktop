#!/usr/bin/env python3
"""Local speech-to-text via Qwen3-ASR on Apple MLX (`mlx-qwen3-asr`).

Replaces the FunASR bridge as the default local engine. The Rust side spawns
this script as a subprocess and reads the transcript JSON from `--output`
(mirroring `mlx_transcribe.py`). Qwen3-ASR runs natively on the M-series GPU
through MLX; long recordings are split at low-energy pauses into <=30 s chunks
and transcribed sequentially with per-chunk GPU memory release, so hour-long
meetings stay within bounded memory.

Speed notes (MLX):
- Quantized `mlx-community` weights (8-bit ~= fp16 quality, ~1.5x faster;
  4-bit for the 0.6B speed tier) are the default download targets.
- The resolved snapshot directory is passed to the model loader, so an
  installed model never performs a network round trip at transcription time.
- Hotwords and trailing context are folded into the model's native `context`
  bias input — no post-hoc text rewriting is needed for the bias itself.

Audio decoding is handled via `imageio-ffmpeg` (which vendors a portable
ffmpeg binary) so any format ffmpeg understands (wav, mp3, m4a, ...) works
without the shared STT runtime or a system codec.
"""

import argparse
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path


DEFAULT_MODEL = "mlx-community/Qwen3-ASR-1.7B-8bit"
HF_MIRROR_ENDPOINT = "https://hf-mirror.com"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("audio_path", nargs="?")
    parser.add_argument("--model-dir", default="", help="Directory holding (or to receive) the Qwen3-ASR weights; also used as the HF cache root.")
    parser.add_argument("--model", default=DEFAULT_MODEL, help="HF repo id of the model to download/transcribe.")
    parser.add_argument("--download-models", action="store_true", help="Pre-download weights into --model-dir, then exit.")
    parser.add_argument("--output", default="", help="Write the transcript JSON here instead of stdout.")
    parser.add_argument("--context", default="", help="Hotword terms + trailing prior context, passed as the model's context bias.")
    parser.add_argument("--timestamps", action="store_true", help="Word-level timestamps via the forced aligner (downloads an extra model).")
    return parser.parse_args()


def mark_ready(model_dir: str) -> None:
    if model_dir:
        Path(model_dir).mkdir(parents=True, exist_ok=True)
        Path(model_dir).joinpath(".ready").write_text("ok\n", encoding="utf-8")


def download_model(repo: str) -> str:
    """Resolve (downloading if needed) the local snapshot path for `repo`.

    The cache is checked fully offline first (`local_files_only`), so an
    installed model never pays a network round trip — direct huggingface.co
    connectivity is slow or blocked in some regions and etag probes would
    otherwise run on every transcription. Only on a cache miss do we hit the
    network, trying the default endpoint and then the hf-mirror.com proxy.
    """
    from huggingface_hub import snapshot_download

    try:
        return snapshot_download(repo, local_files_only=True)
    except Exception:  # noqa: BLE001 - not cached yet, fall through to download
        pass

    endpoints = [None, HF_MIRROR_ENDPOINT]
    last_error: Exception | None = None
    for endpoint in endpoints:
        try:
            return snapshot_download(repo, endpoint=endpoint)
        except Exception as exc:  # noqa: BLE001 - network errors vary by region
            last_error = exc
            print(f"Download from {endpoint or 'huggingface.co'} failed: {exc}", file=sys.stderr)
    raise last_error  # type: ignore[misc]


def prepare_wav(path: str) -> str:
    """Decode `path` to a 16 kHz mono 16-bit WAV using imageio-ffmpeg's
    portable ffmpeg. Returns the temp WAV path (caller is responsible for it)."""
    try:
        import imageio_ffmpeg
    except Exception as exc:  # pragma: no cover - dependency guard
        print(f"imageio-ffmpeg is not available: {exc}", file=sys.stderr)
        raise SystemExit(3) from exc

    exe = imageio_ffmpeg.get_ffmpeg_exe()
    wav = tempfile.mktemp(suffix=".wav")
    subprocess.run(
        [exe, "-y", "-i", path, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", wav],
        check=True,
        capture_output=True,
    )
    return wav


def main() -> int:
    args = parse_args()

    try:
        from mlx_qwen3_asr import transcribe
    except Exception as exc:
        print(f"mlx-qwen3-asr is not available: {exc}", file=sys.stderr)
        raise SystemExit(3) from exc

    model_repo = args.model or DEFAULT_MODEL

    if args.download_models:
        if args.model_dir:
            Path(args.model_dir).mkdir(parents=True, exist_ok=True)
        download_model(model_repo)
        mark_ready(args.model_dir)
        print(json.dumps({"status": "installed"}, ensure_ascii=False))
        return 0

    if not args.audio_path:
        print("usage: qwen3_transcribe.py <audio_path> [--model-dir <path>] [--output <json>]", file=sys.stderr)
        return 2

    # Resolve the snapshot locally before inference so transcription never
    # touches the network (snapshot_download is cache-first).
    model_path = download_model(model_repo)

    wav = prepare_wav(args.audio_path)
    try:
        result = transcribe(
            wav,
            model=model_path,
            context=args.context.strip(),
            return_timestamps=args.timestamps,
            return_chunks=not args.timestamps,
            verbose=False,
        )
    finally:
        try:
            os.remove(wav)
        except OSError:
            pass

    if args.timestamps and result.segments:
        segments = [
            {"text": seg.get("text", ""), "start": float(seg.get("start", 0.0)), "end": float(seg.get("end", 0.0))}
            for seg in result.segments
        ]
    else:
        # Chunk-level timestamps: exact boundaries of the <=30 s energy-split
        # chunks, no forced aligner model required.
        segments = [
            {"text": chunk.get("text", ""), "start": float(chunk.get("start", 0.0)), "end": float(chunk.get("end", 0.0))}
            for chunk in (result.chunks or [])
        ]

    out = {"text": result.text, "language": result.language, "segments": segments}

    if args.output:
        Path(args.output).write_text(json.dumps(out, ensure_ascii=False), encoding="utf-8")
    else:
        print(json.dumps(out, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
