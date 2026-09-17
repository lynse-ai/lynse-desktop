"""Model construction + safetensors loading (bf16 and quantized variants)."""

from __future__ import annotations

import json
from pathlib import Path

import mlx.core as mx
import mlx.nn as nn

from .model import MossModel


def _quantize_predicate(prefix: str, bits):
    """nn.quantize class_predicate for one subtree at a given bit width.

    Called once per prefix; already-quantized modules (QuantizedLinear) fail
    the isinstance check so repeated passes leave them untouched. The tied
    embedding table (doubles as lm_head) is never quantized.
    """
    def predicate(path: str, module: nn.Module) -> bool:
        if not path.startswith(prefix):
            return False
        if path in ("lm.model.embed_tokens", "audio_tower.embed_positions"):
            return False
        return bits is not None and isinstance(module, (nn.Linear, nn.Embedding))

    return predicate


def apply_quantization(model: MossModel, quant: dict) -> None:
    group_size = int(quant.get("group_size", 64))
    # config keys are bits_lm / bits_audio (see convert_weights.py)
    for prefix_key, bits_key in (("lm", "bits_lm"), ("audio_tower", "bits_audio")):
        bits = quant.get(bits_key)
        if bits:
            nn.quantize(
                model, group_size=group_size, bits=int(bits),
                class_predicate=_quantize_predicate(prefix_key + ".", bits),
            )


def load_model(model_dir: str | Path) -> tuple[MossModel, dict]:
    """Build MossModel from a converted model dir and load its weights."""
    model_dir = Path(model_dir)
    config = json.loads((model_dir / "config.json").read_text())
    model = MossModel(config)

    quant = config.get("quantization")
    if quant:
        apply_quantization(model, quant)

    weights = mx.load(str(model_dir / "weights.safetensors"))
    model.load_weights(list(weights.items()), strict=True)
    mx.eval(model.parameters())
    return model, config


def load_processor(model_dir: str | Path):
    from .processor import MossProcessor

    return MossProcessor(model_dir)
