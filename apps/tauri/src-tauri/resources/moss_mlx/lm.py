"""Qwen3 decoder backbone, reusing mlx-lm's implementation.

The checkpoint's text_config is stock Qwen3-0.6B (16 q-heads / 8 kv-heads,
head_dim 128, rope theta 1e6, tied embeddings). mlx-lm's qwen3.Model names its
weights exactly like the checkpoint (`model.embed_tokens`, `model.layers.N.*`,
`model.norm`), handles the tied lm_head via embed_tokens.as_linear, and
accepts `input_embeddings` directly — which is how audio embeds enter without
any placeholder token ever being embedded.
"""

from __future__ import annotations

from mlx_lm.models import qwen3


def build_lm(text_config: dict) -> qwen3.Model:
    return qwen3.Model(qwen3.ModelArgs.from_dict(text_config))
