#!/usr/bin/env python3
"""Convert MOSS-Transcribe-Diarize torch weights to the MLX port layout.

Mapping (see MAPPING.md; 683/683 covered, shapes unchanged — MLX Linear/Conv1d
share torch's layouts):
    model.whisper_encoder.*  -> audio_tower.*
    model.vq_adaptor.*       -> adaptor.*
    model.language_model.*   -> lm.model.*

Quantization (affine, per mx.quantize) is opt-in:
    --quantize --bits-lm 4 --bits-audio 8 --group-size 64
Embeddings/lm_head/norms stay at source precision always.

Examples:
  convert_weights.py --weights ~/Documents/lynse-app/moss-mlx/weights \
      --out ~/Documents/lynse-app/moss-mlx/models/moss-td-bf16
  convert_weights.py ... --out .../moss-td-4bit-lm --quantize --bits-lm 4 --bits-audio 8
"""

from __future__ import annotations

import argparse
import json
import shutil
import sys
from pathlib import Path

import mlx.core as mx

MOSS_HOME = Path("~/Documents/lynse-app/moss-mlx").expanduser()

# source-shape sanity keyed on prefix (first mismatch aborts)
SHAPE_CHECKS = {
    "audio_tower.conv1.weight": (1024, 3, 80),  # MLX layout (out, k, in)
    "audio_tower.conv2.weight": (1024, 3, 1024),
    "audio_tower.embed_positions.weight": (1500, 1024),
    "lm.model.embed_tokens.weight": (151936, 1024),
    "lm.model.norm.weight": (1024,),
}


def map_name(src: str) -> str | None:
    if src.startswith("model.whisper_encoder."):
        return "audio_tower." + src[len("model.whisper_encoder.") :]
    if src.startswith("model.vq_adaptor."):
        return "adaptor." + src[len("model.vq_adaptor.") :]
    if src.startswith("model.language_model."):
        return "lm.model." + src[len("model.language_model.") :]
    return None  # anything else (e.g. lm_head.weight) is dropped on purpose


def quantize_tensor(w: mx.array, bits: int, group_size: int):
    q, scales, biases = mx.quantize(w, group_size=group_size, bits=bits)
    return q, scales, biases


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--weights", type=Path, default=MOSS_HOME / "weights")
    p.add_argument("--out", type=Path, required=True)
    p.add_argument("--quantize", action="store_true")
    p.add_argument("--bits-lm", type=int, default=None)
    p.add_argument("--bits-audio", type=int, default=None)
    p.add_argument("--group-size", type=int, default=64)
    args = p.parse_args()

    src = Path(args.weights).expanduser()
    cfg = json.loads((src / "config.json").read_text())
    tensors_in = mx.load(str(src / "model-00000-of-00001.safetensors"))

    out: dict[str, mx.array] = {}
    dropped = []
    for name, arr in tensors_in.items():
        dst = map_name(name)
        if dst is None:
            dropped.append(name)
            continue
        # MLX Conv1d weight is (out, kernel, in); torch is (out, in, kernel).
        if dst in ("audio_tower.conv1.weight", "audio_tower.conv2.weight"):
            arr = arr.transpose(0, 2, 1)
        if dst in SHAPE_CHECKS and tuple(arr.shape) != SHAPE_CHECKS[dst]:
            print(f"shape mismatch {name}: {arr.shape} != {SHAPE_CHECKS[dst]}", file=sys.stderr)
            return 1
        if args.quantize:
            # only 2-D linear weights are quantized; 1-D norms stay at source precision.
            # dst ends in ".weight": keep it (packed uint32) and hang scales/biases
            # off the module path — mlx-lm convention (P.weight / P.scales / P.biases).
            mod = dst[: -len(".weight")]
            if dst.startswith("lm.model.layers.") and args.bits_lm and arr.ndim == 2:
                out[dst], out[mod + ".scales"], out[mod + ".biases"] = quantize_tensor(
                    arr, args.bits_lm, args.group_size
                )
                continue
            if dst.startswith("audio_tower.layers.") and args.bits_audio and arr.ndim == 2:
                out[dst], out[mod + ".scales"], out[mod + ".biases"] = quantize_tensor(
                    arr, args.bits_audio, args.group_size
                )
                continue
        out[dst] = arr

    out_dir = Path(args.out).expanduser()
    out_dir.mkdir(parents=True, exist_ok=True)
    mx.save_safetensors(str(out_dir / "weights.safetensors"), out)
    shutil.copy2(src / "tokenizer.json", out_dir / "tokenizer.json")

    quant = None
    if args.quantize:
        quant = {"bits_lm": args.bits_lm, "bits_audio": args.bits_audio, "group_size": args.group_size}
    # audio-span params live in processor_config.json and OVERRIDE the class
    # defaults (e.g. this checkpoint uses a 5 s marker interval, not 2 s).
    pcfg = json.loads((src / "processor_config.json").read_text())
    port_config = {
        "format": "moss-mlx-port/1",
        "text": {k: v for k, v in cfg["text_config"].items() if not k.startswith("_")},
        "audio": {k: v for k, v in cfg["audio_config"].items() if not k.startswith("_")},
        "adaptor_input_dim": cfg["adaptor_input_dim"],
        "audio_merge_size": pcfg.get("audio_merge_size", cfg["audio_merge_size"]),
        "audio_token_id": cfg["audio_token_id"],
        "eos_token_id": 151645,
        "pad_token_id": 151643,
        "tokens_per_second": pcfg.get("audio_tokens_per_second", 12.5),
        "marker_every_seconds": pcfg.get("time_marker_every_seconds", 2),
        "enable_time_marker": pcfg.get("enable_time_marker", True),
        "quantization": quant,
    }
    (out_dir / "config.json").write_text(json.dumps(port_config, ensure_ascii=False, indent=2))

    total = sum(int(a.nbytes) if hasattr(a, "nbytes") else 0 for a in out.values())
    print(f"converted {len(tensors_in)} tensors -> {len(out)} keys ({total / 1e6:.0f} MB) -> {out_dir}")
    if dropped:
        print(f"dropped (expected: tied/unrelated): {dropped}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
