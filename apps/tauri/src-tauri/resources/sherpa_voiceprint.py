#!/usr/bin/env python3
"""Voiceprint embedding bridge: sherpa-onnx + the 3D-Speaker CAM++ ONNX model.

Speaks the same stdout protocol as the other bridges: a single JSON line
{"embeddings": [{"id": ..., "embedding": [...]}]} that the Rust side parses
with parse_funasr_json. Runs on a small dedicated venv (sherpa-onnx bundles
onnxruntime; audio is decoded through imageio-ffmpeg) — no torch required.
"""
import argparse
import json
import os
import subprocess
import sys
from pathlib import Path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("audio_path")
    parser.add_argument("--model", required=True, help="Path to the CAM++ .onnx checkpoint")
    parser.add_argument("--segments-json-file", required=True,
                        help="Path to a JSON array of {id,startMs,endMs}. It is a file, "
                             "not an inline argument: a long recording's segment list "
                             "exceeds the 32K CreateProcess command-line limit.")
    return parser.parse_args()


def load_waveform_16k_mono(audio_path: str) -> "np.ndarray":
    """Decode any ffmpeg-readable container to 16 kHz mono float32 samples."""
    import imageio_ffmpeg
    import numpy as np

    ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
    process = subprocess.run(
        [ffmpeg, "-v", "error", "-i", audio_path, "-ac", "1", "-ar", "16000", "-f", "f32le", "-"],
        capture_output=True,
    )
    if process.returncode != 0:
        raise RuntimeError(f"ffmpeg decode failed: {process.stderr.decode(errors='replace')[-400:]}")
    return np.frombuffer(process.stdout, dtype=np.float32)


def main() -> int:
    args = parse_args()
    model_path = Path(args.model)
    if not model_path.exists():
        print(f"Voiceprint model is not installed: {model_path}", file=sys.stderr)
        raise SystemExit(4)

    segments = json.loads(Path(args.segments_json_file).read_text(encoding="utf-8"))
    if not isinstance(segments, list) or not segments:
        print("segments-json-file must contain a non-empty JSON array", file=sys.stderr)
        raise SystemExit(2)

    try:
        import numpy as np
        import sherpa_onnx
    except Exception as exc:
        print(f"sherpa-onnx is not available: {exc}", file=sys.stderr)
        raise SystemExit(3) from exc

    config = sherpa_onnx.SpeakerEmbeddingExtractorConfig(
        model=str(model_path),
        num_threads=1,
        debug=False,
        provider="cpu",
    )
    if not config.validate():
        print(f"Invalid voiceprint model config: {config}", file=sys.stderr)
        raise SystemExit(5)
    extractor = sherpa_onnx.SpeakerEmbeddingExtractor(config)
    if extractor.dim <= 0:
        print("Failed to load the voiceprint model", file=sys.stderr)
        raise SystemExit(5)

    waveform = load_waveform_16k_mono(args.audio_path)
    min_samples = int(float(os.environ.get("LYNSE_VOICEPRINT_MIN_SECONDS", "1.5")) * 16000)
    embeddings = []

    for segment in segments:
        segment_id = str(segment.get("id") or "")
        start_ms = max(0, int(segment.get("startMs") or segment.get("start_ms") or 0))
        end_ms = int(segment.get("endMs") or segment.get("end_ms") or 0)
        if not segment_id or end_ms <= start_ms:
            continue

        start_sample = int(start_ms * 16)
        end_sample = min(len(waveform), int(end_ms * 16))
        samples = waveform[start_sample:end_sample].astype("float32")
        if samples.size == 0:
            continue
        if samples.size < min_samples:
            samples = np.pad(samples, (0, min_samples - samples.size), "constant")

        stream = extractor.create_stream()
        stream.accept_waveform(16000, samples)
        stream.input_finished()
        if not extractor.is_ready(stream):
            continue
        embedding = np.asarray(extractor.compute(stream), dtype="float32")
        norm = float(np.linalg.norm(embedding))
        if norm > 0:
            embedding = embedding / norm
        embeddings.append({
            "id": segment_id,
            "embedding": embedding.tolist(),
        })

    print(json.dumps({"embeddings": embeddings}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
