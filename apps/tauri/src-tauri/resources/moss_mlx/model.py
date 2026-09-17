"""Full MossTranscribeDiarize model: audio_tower + vq_adaptor + qwen3 LM.

Mirrors the reference forward path: whisper encoder -> per-chunk frame trim ->
chunk concat -> 4x time merge -> adaptor -> (in generate.py) concatenated into
text embeddings between the prompt halves at the audio span position.
"""

from __future__ import annotations

import mlx.core as mx
import mlx.nn as nn

from .adaptor import VQAdaptor, time_merge
from .audio_tower import AudioTower
from .lm import build_lm


class MossModel(nn.Module):
    def __init__(self, config: dict):
        super().__init__()
        self.config = config
        audio_cfg = config["audio"]
        text_cfg = config["text"]
        self.audio_tower = AudioTower(
            n_mels=audio_cfg["num_mel_bins"],
            d_model=audio_cfg["d_model"],
            encoder_layers=audio_cfg["encoder_layers"],
            encoder_attention_heads=audio_cfg["encoder_attention_heads"],
            encoder_ffn_dim=audio_cfg["encoder_ffn_dim"],
            max_source_positions=audio_cfg["max_source_positions"],
        )
        self.adaptor = VQAdaptor(
            input_dim=config["adaptor_input_dim"],
            hidden_size=text_cfg["hidden_size"],
            norm_eps=text_cfg["rms_norm_eps"],
        )
        self.lm = build_lm(text_cfg)

    def audio_embeds(self, mel: mx.array, token_lengths: list[int]) -> mx.array:
        """mel (C, 80, 3000) + per-chunk merged-token counts -> (N_tokens, D).

        Per-chunk trim is token_lengths[i] * 4 encoder frames; chunks are
        concatenated BEFORE the merge, exactly like the reference
        (each chunk contributes token_lengths[i] merged tokens).
        """
        feats = self.audio_tower(mel.astype(self.audio_tower.conv1.weight.dtype))
        parts = [feats[i, : token_lengths[i] * 4] for i in range(feats.shape[0])]
        merged = time_merge(mx.concatenate(parts, axis=0), int(self.config["audio_merge_size"]))
        return self.adaptor(merged)

    def embed_tokens(self, ids: mx.array) -> mx.array:
        return self.lm.model.embed_tokens(ids)
