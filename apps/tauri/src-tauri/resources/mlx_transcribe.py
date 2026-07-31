#!/usr/bin/env python3
"""Local speech-to-text via Apple MLX (mlx-whisper).

Mirrors the `funasr_transcribe.py` bridge: the Rust side spawns this script
as a subprocess and reads a JSON transcript from `--output`. MLX is Apple
Silicon-only, so the Rust `MlxAdapter` guards execution before ever reaching
here.

Audio decoding is handled internally via `imageio-ffmpeg` (which vendors a
portable ffmpeg binary) so we never depend on the shared STT runtime's ffmpeg
or on any system codec — any format ffmpeg understands (wav, mp3, m4a, ...)
just works.
"""

import argparse
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path


DEFAULT_MODEL = "mlx-community/whisper-large-v3-turbo"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("audio_path", nargs="?")
    parser.add_argument("--model-dir", default="", help="Directory holding (or to receive) the MLX-Whisper weights.")
    parser.add_argument("--model", default=DEFAULT_MODEL, help="HF repo id used when --model-dir is empty.")
    parser.add_argument("--download-models", action="store_true", help="Pre-download weights into --model-dir, then exit.")
    parser.add_argument("--output", default="", help="Write the transcript JSON here instead of stdout.")
    parser.add_argument("--prompt", default="", help="Trailing prior context fed as initial_prompt to reduce hallucination.")
    parser.add_argument("--hotword", default="", help="Optional hotword bias (passed through for compatibility).")
    return parser.parse_args()


def mark_ready(model_dir: str) -> None:
    if model_dir:
        Path(model_dir).mkdir(parents=True, exist_ok=True)
        Path(model_dir).joinpath(".ready").write_text("ok\n", encoding="utf-8")


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
        from mlx_whisper import load_models, transcribe
    except Exception as exc:
        print(f"MLX-Whisper is not available: {exc}", file=sys.stderr)
        raise SystemExit(3) from exc

    if args.download_models:
        # Download by HF repo id into HF_HOME (Rust points HF_HOME at the model
        # dir), then drop a `.ready` marker. We pass the repo id, not the local
        # dir, because mlx_whisper resolves a local dir as "weights already
        # here" and would not fetch anything.
        model = args.model or DEFAULT_MODEL
        if args.model_dir:
            Path(args.model_dir).mkdir(parents=True, exist_ok=True)
        load_models(path=model)
        mark_ready(args.model_dir)
        print(json.dumps({"status": "installed"}, ensure_ascii=False))
        return 0

    if not args.audio_path:
        print("usage: mlx_transcribe.py <audio_path> [--model-dir <path>] [--output <json>]", file=sys.stderr)
        return 2

    model = args.model or DEFAULT_MODEL
    wav = prepare_wav(args.audio_path)
    try:
        kwargs = {"path_or_hf": model, "verbose": False}
        if args.prompt.strip():
            kwargs["initial_prompt"] = args.prompt.strip()
        segments, _info = transcribe(wav, **kwargs)
    finally:
        try:
            os.remove(wav)
        except OSError:
            pass

    text = "".join(seg.get("text", "") for seg in segments)
    out = {
        "text": text,
        "segments": [
            {
                "text": seg.get("text", ""),
                "start": float(seg.get("start", 0.0)),
                "end": float(seg.get("end", 0.0)),
            }
            for seg in segments
        ],
    }

    if args.output:
        Path(args.output).write_text(json.dumps(out, ensure_ascii=False), encoding="utf-8")
    else:
        print(json.dumps(out, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
