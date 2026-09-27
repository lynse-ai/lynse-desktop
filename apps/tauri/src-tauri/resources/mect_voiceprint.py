#!/usr/bin/env python3
"""MECT (AntSpeaker) voiceprint embedding bridge.

Extracts L2-normalised speaker embeddings for segment slices of one audio
file and prints a single-line JSON object to stdout:

    {"embeddings": [{"id": "...", "embedding": [...]}]}

The output format matches funasr_transcribe.py --extract-voiceprint so the
Rust side parses both voiceprint backends with the same helper.
"""
import argparse
import json
import os
from pathlib import Path
import sys

# The vendored antspeaker package ships next to this script (resources/antspeaker).
sys.path.insert(0, str(Path(__file__).resolve().parent))

if sys.platform == "darwin":
    os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("audio_path")
    parser.add_argument("--checkpoint", required=True, help="Path to the MECT .pt checkpoint")
    parser.add_argument("--segments-json", default="[]")
    parser.add_argument("--device", default=os.environ.get("LYNSE_MECT_DEVICE", "auto"))
    return parser.parse_args()


def resolve_device(requested_device: str) -> str:
    requested = (requested_device or "auto").strip().lower()
    if requested not in ("auto", "mps"):
        return requested

    try:
        import torch
        mps_available = torch.backends.mps.is_available()
    except Exception:
        mps_available = False

    if mps_available:
        return "mps"
    if requested == "mps":
        print("MPS is unavailable; falling back to CPU.", file=sys.stderr)
    return "cpu"


def load_checkpoint(checkpoint_path: str, device: str):
    try:
        import torch
        import antspeaker.models  # noqa: F401 — registers VPR/backbones/poolings
        from antspeaker.utils.registry import create_model
    except Exception as exc:
        print(f"antspeaker package is not available: {exc}", file=sys.stderr)
        raise SystemExit(3) from exc

    if not Path(checkpoint_path).exists():
        print(f"MECT checkpoint is not installed: {checkpoint_path}", file=sys.stderr)
        raise SystemExit(4)

    checkpoint = torch.load(checkpoint_path, map_location="cpu")
    feature_config = checkpoint["config"]["feature"]
    model = create_model(checkpoint["config"]["model"])
    model, _ = model.load_model(checkpoint_path)
    model.eval()
    model.to(device)
    return model, feature_config


def extract_fbank(samples, feature_config, device: str):
    import torch
    import torchaudio.compliance.kaldi as kaldi

    # Kaldi features expect 16-bit-scaled floats; mirrors the upstream example.
    waveform = torch.from_numpy(samples).unsqueeze(0) * (1 << 15)
    fbank = kaldi.fbank(
        waveform,
        num_mel_bins=feature_config["num_mel_bins"],
        frame_length=feature_config["frame_length"],
        frame_shift=feature_config["frame_shift"],
        dither=feature_config["dither"],
        energy_floor=0.0,
        window_type="hamming",
        sample_frequency=feature_config["sampling_rate"],
    )
    return fbank.unsqueeze(0).transpose(-1, -2).to(device)


def extract_voiceprint_embeddings(audio_path: str, segments_json: str, checkpoint: str, device: str):
    import librosa
    import numpy as np
    import torch

    segments = json.loads(segments_json)
    if not isinstance(segments, list) or not segments:
        print("segments-json must be a non-empty JSON array", file=sys.stderr)
        raise SystemExit(2)

    model, feature_config = load_checkpoint(checkpoint, device)
    waveform, _sr = librosa.load(audio_path, sr=16000, mono=True)
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
        min_samples = int(float(os.environ.get("LYNSE_VOICEPRINT_MIN_SECONDS", "1.5")) * 16000)
        if samples.shape[0] < min_samples:
            samples = np.pad(samples, (0, min_samples - samples.shape[0]), "constant")

        with torch.no_grad():
            embedding = model(extract_fbank(samples, feature_config, device)).squeeze(0).cpu().numpy()
        norm = float(np.linalg.norm(embedding))
        if norm > 0:
            embedding = embedding / norm
        embeddings.append({
            "id": segment_id,
            "embedding": embedding.astype("float32").tolist(),
        })

    print(json.dumps({"embeddings": embeddings}, ensure_ascii=False))
    return 0


def main() -> int:
    args = parse_args()
    device = resolve_device(args.device)
    if not args.audio_path:
        print("usage: mect_voiceprint.py <audio_path> --checkpoint <path> --segments-json <json>", file=sys.stderr)
        return 2
    return extract_voiceprint_embeddings(args.audio_path, args.segments_json, args.checkpoint, device)


if __name__ == "__main__":
    raise SystemExit(main())
