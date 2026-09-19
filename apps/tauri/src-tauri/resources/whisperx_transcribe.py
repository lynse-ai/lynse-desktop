#!/usr/bin/env python3
"""Local speech-to-text via WhisperX (faster-whisper on CTranslate2 + wav2vec2
alignment), running on CPU.

Bridge contract mirrors `qwen3_transcribe.py`: the Rust side spawns this
script as a subprocess with the model directory scoped as the HF cache root
and reads the transcript JSON from `--output`. Weights download on first use
from HuggingFace (hf-mirror as the fallback), and a `.snapshot` marker pins
the resolved directory so an installed model never re-downloads at
transcription time.

First cut (PRD §12 Q7 still pending): transcription + segment timestamps with
best-effort word alignment. pyannote speaker diarization is deliberately not
wired — its models are HF license-gated and the distribution channel is not
decided yet, so segments stay single-speaker and the engine-agnostic Rust-side
post-processing (hotword rewrite) applies as with the other engines.
"""

import argparse
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path


DEFAULT_MODEL = "Systran/faster-whisper-large-v3"
HF_MIRROR_ENDPOINT = "https://hf-mirror.com"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("audio_path", nargs="?")
    parser.add_argument("--model-dir", default="", help="Directory holding (or to receive) the CTranslate2 weights; also used as the HF cache root.")
    parser.add_argument("--model", default=DEFAULT_MODEL, help="HF repo id of the faster-whisper model to download/transcribe.")
    parser.add_argument("--download-models", action="store_true", help="Pre-download weights into --model-dir, then exit.")
    parser.add_argument("--region", default="global", choices=["cn", "global"], help="IP-detected network region: cn tries the hf-mirror proxy first, global tries HuggingFace first. The other source is kept as a fallback.")
    parser.add_argument("--output", default="", help="Write the transcript JSON here instead of stdout.")
    parser.add_argument("--context", default="", help="Accepted for bridge parity (hotword bias); WhisperX has no context input and hotword correction stays a Rust-side post-process.")
    return parser.parse_args()


def cached_snapshot(model_dir: str) -> str | None:
    """Snapshot path recorded by a previous download, if it still exists."""
    if not model_dir:
        return None
    marker = Path(model_dir).joinpath(".snapshot")
    try:
        path = marker.read_text(encoding="utf-8").strip()
    except OSError:
        return None
    return path if path and Path(path).exists() else None


def record_snapshot(model_dir: str, path: str) -> str:
    if model_dir:
        try:
            Path(model_dir).mkdir(parents=True, exist_ok=True)
            Path(model_dir).joinpath(".snapshot").write_text(path, encoding="utf-8")
        except OSError:
            pass
    return path


def download_model(repo: str, region: str = "global", model_dir: str = "") -> str:
    """Resolve (downloading if needed) the local snapshot path for `repo`.

    HF_HOME is pointed at --model-dir by the Rust side, so the weights land
    inside the same managed model directory. faster-whisper weights are not
    reliably mirrored on ModelScope, so both regions go HuggingFace first with
    the hf-mirror proxy as the fallback.
    """
    cached = cached_snapshot(model_dir)
    if cached:
        return cached

    from huggingface_hub import snapshot_download

    try:
        return record_snapshot(model_dir, snapshot_download(repo, local_files_only=True))
    except Exception:  # noqa: BLE001 - not cached yet, fall through to download
        pass

    def from_huggingface() -> str:
        return record_snapshot(model_dir, snapshot_download(repo))

    def from_hf_mirror() -> str:
        return record_snapshot(model_dir, snapshot_download(repo, endpoint=HF_MIRROR_ENDPOINT))

    sources = [from_hf_mirror, from_huggingface] if region == "cn" else [from_huggingface, from_hf_mirror]

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


def main() -> int:
    args = parse_args()

    try:
        import whisperx
    except Exception as exc:
        print(f"whisperx is not available: {exc}", file=sys.stderr)
        raise SystemExit(3) from exc

    model_repo = args.model or DEFAULT_MODEL

    if args.download_models:
        if args.model_dir:
            Path(args.model_dir).mkdir(parents=True, exist_ok=True)
        download_model(model_repo, args.region, args.model_dir)
        mark_ready(args.model_dir)
        print(json.dumps({"status": "installed"}, ensure_ascii=False))
        return 0

    if not args.audio_path:
        print("usage: whisperx_transcribe.py <audio_path> [--model-dir <path>] [--output <json>]", file=sys.stderr)
        return 2

    # Resolve the snapshot locally before inference so transcription never
    # touches the network (the .snapshot marker / offline cache resolves it).
    model_path = download_model(model_repo, args.region, args.model_dir)

    wav = prepare_wav(args.audio_path)
    try:
        model = whisperx.load_model(model_path, device="cpu", compute_type="int8")
        audio = whisperx.load_audio(wav)
        result = model.transcribe(audio, batch_size=8)
        segments = [
            {"text": seg.get("text", ""), "start": float(seg.get("start", 0.0)), "end": float(seg.get("end", 0.0))}
            for seg in result.get("segments", [])
        ]
        # Word alignment refines segment boundaries; it downloads a wav2vec2
        # align model per language, so keep it best-effort — a failure must
        # never lose the transcript itself.
        try:
            align_model, metadata = whisperx.load_align_model(result.get("language", "en"), "cpu")
            aligned = whisperx.align(
                result.get("segments", []),
                align_model,
                metadata,
                audio,
                "cpu",
                return_char_alignments=False,
            )
            refined = [
                {"text": seg.get("text", ""), "start": float(seg.get("start", 0.0)), "end": float(seg.get("end", 0.0))}
                for seg in aligned.get("segments", [])
                if seg.get("text", "").strip()
            ]
            if refined:
                segments = refined
        except Exception as exc:  # noqa: BLE001 - alignment is optional
            print(f"Alignment skipped: {exc}", file=sys.stderr)
    finally:
        try:
            os.remove(wav)
        except OSError:
            pass

    text = " ".join(seg["text"].strip() for seg in segments if seg.get("text")).strip()
    out = {"text": text, "language": result.get("language", ""), "segments": segments}

    if args.output:
        Path(args.output).write_text(json.dumps(out, ensure_ascii=False), encoding="utf-8")
    else:
        print(json.dumps(out, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
