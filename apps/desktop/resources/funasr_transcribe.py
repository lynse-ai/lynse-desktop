#!/usr/bin/env python3
import argparse
import json
import os
from pathlib import Path
import sys


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("audio_path", nargs="?")
    parser.add_argument("--model-dir", default="")
    parser.add_argument("--download-models", action="store_true")
    parser.add_argument("--expected-speakers", type=int, default=0)
    parser.add_argument("--hotword", default="")
    parser.add_argument("--device", default=os.environ.get("LYNSE_FUNASR_DEVICE", "cpu"))
    return parser.parse_args()


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
        device=device or "cpu",
        disable_update=True,
    )


def mark_ready(model_dir: str) -> None:
    if model_dir:
        ready = Path(model_dir) / ".ready"
        ready.write_text("ok\n", encoding="utf-8")


def main() -> int:
    args = parse_args()
    model = build_model(args.model_dir, args.device)

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
        "batch_size_s": 300,
        "sentence_timestamp": True,
    }
    if args.expected_speakers > 0:
        generate_kwargs["preset_spk_num"] = args.expected_speakers
    if args.hotword.strip():
        generate_kwargs["hotword"] = args.hotword.strip()

    result = model.generate(**generate_kwargs)
    print(json.dumps(result[0] if isinstance(result, list) else result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
