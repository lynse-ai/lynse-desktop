"""MLX port of MOSS-Transcribe-Diarize (0.9B).

Port of the reference PyTorch implementation (OpenMOSS, Apache-2.0) to Apple
MLX. Layout mirrors the checkpoint module tree so converted weights load with
a pure prefix rename (see scripts/moss-mlx/MAPPING.md):

    model.whisper_encoder.* -> audio_tower.*
    model.vq_adaptor.*      -> adaptor.*
    model.language_model.*  -> lm.model.*   (mlx-lm qwen3.Model)

The audio encoder is hand-written to keep checkpoint naming 1:1; the LM reuses
mlx-lm's qwen3.Model (identical architecture, tied-head aware, KV-cache API).
"""

__version__ = "0.1.0"
