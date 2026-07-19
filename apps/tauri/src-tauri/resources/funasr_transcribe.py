#!/usr/bin/env python3
import argparse
import json
import os
from pathlib import Path
import sys


if sys.platform == "darwin":
    os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("audio_path", nargs="?")
    parser.add_argument("--model-dir", default="")
    parser.add_argument("--download-models", action="store_true")
    parser.add_argument("--expected-speakers", type=int, default=0)
    parser.add_argument("--hotword", default="")
    parser.add_argument("--prompt", default="", help="Trailing prior context fed to the model as an initial prompt to reduce hallucination and keep专有名词 consistent.")
    parser.add_argument("--extract-voiceprint", action="store_true")
    parser.add_argument("--segments-json", default="[]")
    parser.add_argument("--device", default=os.environ.get("LYNSE_FUNASR_DEVICE", "auto"))
    return parser.parse_args()


def positive_int_env(name: str, default: int) -> int:
    try:
        return max(1, int(os.environ.get(name, str(default))))
    except ValueError:
        return default


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


def build_model(model_dir: str, device: str):
    if model_dir:
        Path(model_dir).mkdir(parents=True, exist_ok=True)
        os.environ["MODELSCOPE_CACHE"] = model_dir
    try:
        from funasr import AutoModel
    except Exception as exc:
        print(f"FunASR is not available: {exc}", file=sys.stderr)
        raise SystemExit(3) from exc

    return AutoModel(
        model="iic/speech_seaco_paraformer_large_asr_nat-zh-cn-16k-common-vocab8404-pytorch",
        vad_model="iic/speech_fsmn_vad_zh-cn-16k-common-pytorch",
        vad_kwargs={"max_single_segment_time": int(os.environ.get("LYNSE_FUNASR_VAD_MAX_SEGMENT_MS", "30000"))},
        punc_model="iic/punc_ct-transformer_cn-en-common-vocab471067-large",
        spk_model="iic/speech_campplus_sv_zh-cn_16k-common",
        device=resolve_device(device),
        ncpu=positive_int_env("LYNSE_FUNASR_NCPU", 4),
        disable_update=True,
    )


def mark_ready(model_dir: str) -> None:
    if model_dir:
        ready = Path(model_dir) / ".ready"
        ready.write_text("ok\n", encoding="utf-8")


def build_voiceprint_model(model_dir: str, device: str):
    try:
        import torch
        from funasr.models.campplus.model import CAMPPlus
    except Exception as exc:
        print(f"FunASR CAMPPlus is not available: {exc}", file=sys.stderr)
        raise SystemExit(3) from exc

    model_path = Path(model_dir) / "iic" / "speech_campplus_sv_zh-cn_16k-common" / "campplus_cn_common.bin"
    if not model_path.exists():
        print(f"CAMPPlus model is not installed: {model_path}", file=sys.stderr)
        raise SystemExit(4)

    model = CAMPPlus(feat_dim=80, embedding_size=192)
    model.load_state_dict(torch.load(str(model_path), map_location=device or "cpu"), strict=True)
    model.eval()
    model.to(device or "cpu")
    return model


def extract_voiceprint_embeddings(audio_path: str, segments_json: str, model_dir: str, device: str):
    try:
        import librosa
        import numpy as np
        import torch
        from funasr.models.campplus.utils import extract_feature
    except Exception as exc:
        print(f"Voiceprint dependencies are not available: {exc}", file=sys.stderr)
        raise SystemExit(3) from exc

    segments = json.loads(segments_json)
    if not isinstance(segments, list) or not segments:
        print("segments-json must be a non-empty JSON array", file=sys.stderr)
        raise SystemExit(2)

    model = build_voiceprint_model(model_dir, device)
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

        features, _lengths, _times = extract_feature([torch.from_numpy(samples)])
        with torch.no_grad():
            embedding = model(features.to(device or "cpu").float()).squeeze(0).cpu().numpy()
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
    if args.extract_voiceprint:
        if not args.audio_path:
            print("usage: funasr_transcribe.py <audio_path> --extract-voiceprint --segments-json <json>", file=sys.stderr)
            return 2
        return extract_voiceprint_embeddings(args.audio_path, args.segments_json, args.model_dir, device)

    model = build_model(args.model_dir, device)

    if args.download_models:
        mark_ready(args.model_dir)
        print(json.dumps({"status": "installed"}, ensure_ascii=False))
        return 0

    if not args.audio_path:
        print("usage: funasr_transcribe.py <audio_path> [--model-dir <path>]", file=sys.stderr)
        return 2

    audio_path = args.audio_path
    generate_kwargs = {
        "input": audio_path,
        "batch_size_s": positive_int_env("LYNSE_FUNASR_BATCH_SIZE_S", 300),
        "batch_size_threshold_s": positive_int_env("LYNSE_FUNASR_BATCH_SIZE_THRESHOLD_S", 60),
        "sentence_timestamp": True,
    }
    if args.expected_speakers > 0:
        generate_kwargs["preset_spk_num"] = args.expected_speakers
    if args.hotword.strip():
        generate_kwargs["hotword"] = args.hotword.strip()
    if args.prompt.strip():
        generate_kwargs["prompt"] = args.prompt.strip()

    result = model.generate(**generate_kwargs)
    print(json.dumps(result[0] if isinstance(result, list) else result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
