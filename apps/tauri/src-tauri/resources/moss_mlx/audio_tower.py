"""Whisper audio encoder (transformers.models.whisper.WhisperEncoder port).

Module/weight names intentionally match the checkpoint's HF naming so converted
weights load 1:1 after the `model.whisper_encoder.` -> `audio_tower.` prefix
swap: conv1/conv2, embed_positions, layers.N.self_attn.{q,k,v,out}_proj,
layers.N.{self_attn_layer_norm,fc1,fc2,final_layer_norm}, final layer_norm.
k_proj has no bias (HF whisper convention); q/v/out do.
"""

from __future__ import annotations

import math

import mlx.core as mx
import mlx.nn as nn

LN_EPS = 1e-5  # WhisperConfig.layer_norm_eps default


class EncoderAttention(nn.Module):
    def __init__(self, d_model: int, n_heads: int):
        super().__init__()
        self.n_heads = n_heads
        self.head_dim = d_model // n_heads
        self.scale = self.head_dim**-0.5
        self.q_proj = nn.Linear(d_model, d_model, bias=True)
        self.k_proj = nn.Linear(d_model, d_model, bias=False)
        self.v_proj = nn.Linear(d_model, d_model, bias=True)
        self.out_proj = nn.Linear(d_model, d_model, bias=True)

    def __call__(self, x: mx.array) -> mx.array:
        B, L, D = x.shape
        q = self.q_proj(x).reshape(B, L, self.n_heads, self.head_dim).transpose(0, 2, 1, 3)
        k = self.k_proj(x).reshape(B, L, self.n_heads, self.head_dim).transpose(0, 2, 1, 3)
        v = self.v_proj(x).reshape(B, L, self.n_heads, self.head_dim).transpose(0, 2, 1, 3)
        o = mx.fast.scaled_dot_product_attention(q, k, v, scale=self.scale)
        o = o.transpose(0, 2, 1, 3).reshape(B, L, D)
        return self.out_proj(o)


class EncoderLayer(nn.Module):
    def __init__(self, d_model: int, n_heads: int, ffn_dim: int):
        super().__init__()
        self.self_attn = EncoderAttention(d_model, n_heads)
        self.self_attn_layer_norm = nn.LayerNorm(d_model, eps=LN_EPS)
        self.fc1 = nn.Linear(d_model, ffn_dim, bias=True)
        self.fc2 = nn.Linear(ffn_dim, d_model, bias=True)
        self.final_layer_norm = nn.LayerNorm(d_model, eps=LN_EPS)

    def __call__(self, x: mx.array) -> mx.array:
        x = x + self.self_attn(self.self_attn_layer_norm(x))
        x = x + self.fc2(nn.GELU()(self.fc1(self.final_layer_norm(x))))
        return x


class AudioTower(nn.Module):
    def __init__(
        self,
        n_mels: int = 80,
        d_model: int = 1024,
        encoder_layers: int = 24,
        encoder_attention_heads: int = 16,
        encoder_ffn_dim: int = 4096,
        max_source_positions: int = 1500,
    ):
        super().__init__()
        # MLX conv1d is channels-last: input (B, T, C), weight (out, in, k).
        self.conv1 = nn.Conv1d(n_mels, d_model, kernel_size=3, padding=1)
        self.conv2 = nn.Conv1d(d_model, d_model, kernel_size=3, stride=2, padding=1)
        self.embed_positions = nn.Embedding(max_source_positions, d_model)
        self.layers = [
            EncoderLayer(d_model, encoder_attention_heads, encoder_ffn_dim)
            for _ in range(encoder_layers)
        ]
        self.layer_norm = nn.LayerNorm(d_model, eps=LN_EPS)

    def __call__(self, mel: mx.array) -> mx.array:
        """mel (B, 80, 3000) -> hidden states (B, 1500, d_model)."""
        x = mx.array.transpose(mel, 0, 2, 1)
        x = nn.GELU()(self.conv1(x))
        x = nn.GELU()(self.conv2(x))
        x = x + self.embed_positions(mx.arange(x.shape[1]))
        for layer in self.layers:
            x = layer(x)
        return self.layer_norm(x)
