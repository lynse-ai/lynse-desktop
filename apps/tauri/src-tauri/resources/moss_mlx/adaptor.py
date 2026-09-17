"""VQ adaptor: 4x time merge + Linear->SiLU->Linear->LayerNorm.

Names match the checkpoint (`model.vq_adaptor.layers.{0,2,3}.*`): layer 1 is
the parameterless SiLU, layer 3 is a LayerNorm (note: plain LayerNorm with
eps=text_config.rms_norm_eps=1e-6, not RMSNorm).
"""

from __future__ import annotations

import mlx.core as mx
import mlx.nn as nn


def time_merge(features: mx.array, merge_size: int = 4) -> mx.array:
    """(T, D) -> (T//merge_size, D*merge_size); T trimmed to a multiple."""
    T, D = features.shape
    t_trim = (T // merge_size) * merge_size
    return features[:t_trim].reshape(t_trim // merge_size, D * merge_size)


class VQAdaptor(nn.Module):
    def __init__(self, input_dim: int = 4096, hidden_size: int = 1024, norm_eps: float = 1e-6):
        super().__init__()
        # plain list (not nn.Sequential) so weight paths stay layers.{0,2,3}.*
        self.layers = [
            nn.Linear(input_dim, hidden_size, bias=True),
            nn.SiLU(),
            nn.Linear(hidden_size, hidden_size, bias=True),
            nn.LayerNorm(hidden_size, eps=norm_eps),
        ]

    def __call__(self, x: mx.array) -> mx.array:
        lin0, silu, lin2, ln3 = self.layers
        return ln3(lin2(silu(lin0(x))))
