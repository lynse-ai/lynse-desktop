#!/usr/bin/env python3
"""Local speech-to-text via MOSS-Transcribe-Diarize on Apple MLX.

Spawns exactly like the other engine bridges (funasr/mlx/qwen3): the Rust side
runs this script as a subprocess and reads the transcript JSON from `--output`.
Unlike the single-speaker engines, MOSS emits speaker-attributed, timestamped
segments natively (SATS), so each segment carries a `speaker` label (S01...).
Long recordings run in a single pass up to the model's 90-minute limit — no
chunking — which is what keeps speaker labels consistent across the session.

Weights are the in-repo MLX port (`moss_mlx/` next to this script) loaded from
a converted model directory (config.json + weights.safetensors + tokenizer.json,
produced by scripts/moss-mlx/convert_weights.py). `--download-models` fetches
the published converted repo from HuggingFace/ModelScope/hf-mirror ordered by
`--region`; a model directory that already contains config.json + weights
is used as-is without any network access.

`--context` is accepted for CLI parity with the other bridges but is not
applied: MOSS has no context-bias input, and injecting text into the prompt
would perturb the SATS output format. Hotword post-processing stays on the
Rust side (engine-agnostic `apply_hotwords`).

Audio decoding uses `imageio-ffmpeg`'s portable ffmpeg, so any format ffmpeg
understands works without the shared STT runtime or a system codec.
"""

import argparse
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

DEFAULT_MODEL = "lynse-ai/moss-transcribe-diarize-mlx-8bit"
HF_MIRROR_ENDPOINT = "https://hf-mirror.com"
# transcript token rate observed ~6-10 tokens/s of audio; 12/s is a safe cap
MAX_NEW_TOKENS_PER_AUDIO_SEC = 12
MIN_MAX_NEW_TOKENS = 4096


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("audio_path", nargs="?")
    parser.add_argument("--model-dir", default="", help="Directory holding (or to receive) the converted MOSS-MLX weights; also used as the HF/ModelScope cache root.")
    parser.add_argument("--model", default=DEFAULT_MODEL, help="HF repo id of the converted model to download/transcribe.")
    parser.add_argument("--download-models", action="store_true", help="Pre-download weights into --model-dir, then exit.")
    parser.add_argument("--region", default="global", choices=["cn", "global"], help="IP-detected network region: cn tries ModelScope first, global tries HuggingFace first. The other source is always kept as a fallback.")
    parser.add_argument("--output", default="", help="Write the transcript JSON here instead of stdout.")
    parser.add_argument("--context", default="", help="Accepted for bridge parity; MOSS has no context-bias input, so this is not applied (hotwords stay a Rust-side post-process).")
    parser.add_argument("--timestamps", action="store_true", help="Accepted for bridge parity; MOSS timestamps are native to every segment.")
    return parser.parse_args()


def local_weights_dir(model_dir: str) -> str | None:
    """A model directory that already holds a converted model, usable offline."""
    if not model_dir:
        return None
    base = Path(model_dir)
    if (base / "config.json").exists() and (base / "weights.safetensors").exists():
        return str(base)
    marker = base / ".snapshot"
    try:
        path = marker.read_text(encoding="utf-8").strip()
    except OSError:
        return None
    if path and (Path(path) / "config.json").exists() and (Path(path) / "weights.safetensors").exists():
        return path
    return None


def record_snapshot(model_dir: str, path: str) -> str:
    if model_dir:
        try:
            Path(model_dir).mkdir(parents=True, exist_ok=True)
            Path(model_dir).joinpath(".snapshot").write_text(path, encoding="utf-8")
        except OSError:
            pass
    return path


def download_model(repo: str, region: str = "global", model_dir: str = "") -> str:
    """Resolve (downloading if needed) the local converted-model directory.

    Same multi-source ordering as qwen3_transcribe.py: offline caches first,
    then ModelScope / hf-mirror / HuggingFace ordered by region.
    """
    local = local_weights_dir(model_dir)
    if local:
        return local

    from huggingface_hub import snapshot_download

    try:
        return record_snapshot(model_dir, snapshot_download(repo, local_files_only=True))
    except Exception:  # noqa: BLE001 - not cached yet, fall through to download
        pass

    def from_modelscope() -> str:
        try:
            from modelscope import snapshot_download as modelscope_download
        except ImportError:  # pragma: no cover - older layouts keep it nested
            from modelscope.hub.snapshot_download import snapshot_download as modelscope_download
        return record_snapshot(model_dir, modelscope_download(repo))

    def from_huggingface() -> str:
        return record_snapshot(model_dir, snapshot_download(repo))

    def from_hf_mirror() -> str:
        return record_snapshot(model_dir, snapshot_download(repo, endpoint=HF_MIRROR_ENDPOINT))

    if region == "cn":
        sources = [from_modelscope, from_hf_mirror, from_huggingface]
    else:
        sources = [from_huggingface, from_modelscope, from_hf_mirror]

    last_error: Exception | None = None
    for source in sources:
        try:
            return source()
        except Exception as exc:  # noqa: BLE001 - network errors vary by region
            last_error = exc
            print(f"Model download source failed: {exc}", file=sys.stderr)
    raise last_error  # type: ignore[misc]


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


def transcribe(model_path: str, wav_path: str) -> dict:
    import wave

    import mlx.core as mx
    import soundfile as sf

    from moss_mlx.generate import generate
    from moss_mlx.weights import load_model, load_processor

    model, config = load_model(model_path)
    processor = load_processor(model_path)

    with wave.open(wav_path, "rb") as w:
        duration = w.getnframes() / float(w.getframerate())
    max_new_tokens = max(MIN_MAX_NEW_TOKENS, int(duration * MAX_NEW_TOKENS_PER_AUDIO_SEC))

    waveform, sr = sf.read(wav_path, dtype="float32")
    assert sr == 16000 and waveform.ndim == 1

    feats, lengths = processor.features(waveform)
    before, span, after = processor.encode_prompt_split(sum(lengths))
    audio_embeds = model.audio_embeds(feats, lengths)
    mx.eval(audio_embeds)

    ids = generate(
        model, processor.tokenizer, before, span, audio_embeds, after,
        eos_id=config["eos_token_id"], max_new_tokens=max_new_tokens,
    )
    text = processor.tokenizer.decode(ids)

    from moss_mlx.transcript_parser import parse_transcript

    segments = [
        {
            "text": s.text,
            "start": float(s.start),
            "end": float(s.end),
            "speaker": s.speaker,
        }
        for s in parse_transcript(text)
    ]
    return {"text": text, "language": "auto", "segments": segments}


def main() -> int:
    args = parse_args()

    if args.download_models:
        if args.model_dir:
            Path(args.model_dir).mkdir(parents=True, exist_ok=True)
        download_model(args.model or DEFAULT_MODEL, args.region, args.model_dir)
        mark_ready(args.model_dir)
        print(json.dumps({"status": "installed"}, ensure_ascii=False))
        return 0

    if not args.audio_path:
        print("usage: moss_transcribe.py <audio_path> [--model-dir <path>] [--output <json>]", file=sys.stderr)
        return 2

    try:
        import mlx  # noqa: F401
        import mlx_lm  # noqa: F401
    except Exception as exc:
        print(f"MLX runtime is not available: {exc}", file=sys.stderr)
        raise SystemExit(3) from exc

    model_path = download_model(args.model or DEFAULT_MODEL, args.region, args.model_dir)

    wav = prepare_wav(args.audio_path)
    try:
        out = transcribe(model_path, wav)
    finally:
        try:
            os.remove(wav)
        except OSError:
            pass

    if args.output:
        Path(args.output).write_text(json.dumps(out, ensure_ascii=False), encoding="utf-8")
    else:
        print(json.dumps(out, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
