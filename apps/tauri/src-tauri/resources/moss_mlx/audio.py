"""Log-mel spectrogram, numerically mirroring transformers' WhisperFeatureExtractor.

The PyTorch reference path (what the baseline numbers were measured with) is
WhisperFeatureExtractor._torch_extract_fbank_features:
  torch.stft(n_fft=400, hop=160, hann periodic, center=True/reflect) -> |.|^2,
  drop last frame, mel_filters @ magnitudes, clamp 1e-10 -> log10, max-8, +4/4,
  trim/pad to 3000 frames (padding_value 0.0).
This module reproduces it with numpy so the MLX port consumes identical mels.
"""

from __future__ import annotations

import os

import numpy as np

N_FFT = 400
HOP_LENGTH = 160
N_SAMPLES = 480000  # 30 s at 16 kHz
N_FRAMES = 3000

_FILTERS_CACHE: dict[int, np.ndarray] = {}


def mel_filters(n_mels: int = 80) -> np.ndarray:
    """(n_mels, n_fft//2+1) filterbank from the OpenAI whisper asset."""
    if n_mels not in _FILTERS_CACHE:
        path = os.path.join(os.path.dirname(__file__), "assets", "mel_filters.npz")
        with np.load(path) as f:
            m = f["mel_80"] if n_mels == 80 else f[f"mel_{n_mels}"]
        # OpenAI asset is (n_mels, freq); HF stores (freq, n_mels). Normalize to (n_mels, freq).
        _FILTERS_CACHE[n_mels] = m if m.shape[0] == n_mels else m.T
    return _FILTERS_CACHE[n_mels]


def log_mel(audio: np.ndarray) -> np.ndarray:
    """Padded 16 kHz mono chunk (<= 480000 samples) -> log-mel [80, 3000], float32."""
    audio = np.asarray(audio, dtype=np.float32)
    if audio.shape[0] < N_SAMPLES:
        audio = np.pad(audio, (0, N_SAMPLES - audio.shape[0]))
    elif audio.shape[0] > N_SAMPLES:
        audio = audio[:N_SAMPLES]

    # torch.stft(center=True): reflect-pad by n_fft//2 on both sides.
    padded = np.pad(audio, (N_FFT // 2, N_FFT // 2), mode="reflect")
    # torch.hann_window(N) is periodic == np.hanning(N+1)[:-1].
    window = np.hanning(N_FFT + 1)[:-1].astype(np.float32)

    frames = np.lib.stride_tricks.sliding_window_view(padded, N_FFT)[::HOP_LENGTH]
    spec = np.abs(np.fft.rfft(frames * window, axis=1)) ** 2  # (n_frames+1, 201)
    spec = spec[:-1]  # stft[..., :-1]

    mel = mel_filters(80) @ spec.T  # (80, T)
    log_spec = np.log10(np.maximum(mel, 1e-10))
    log_spec = np.maximum(log_spec, log_spec.max() - 8.0)
    log_spec = (log_spec + 4.0) / 4.0

    if log_spec.shape[1] < N_FRAMES:
        log_spec = np.pad(log_spec, ((0, 0), (0, N_FRAMES - log_spec.shape[1])), constant_values=0.0)
    return log_spec[:, :N_FRAMES].astype(np.float32)


def chunk_waveform(audio: np.ndarray, merge_size: int = 4) -> tuple[list[np.ndarray], list[int]]:
    """Split into 30 s chunks; per chunk the merged-token count.

    Mirrors processing_moss_transcribe_diarize: token_len = ceil(samples / (hop
    * encoder_stride(2) * merge_size)) = 12.5 tokens per second.
    """
    stride = HOP_LENGTH * 2 * merge_size
    chunks, lengths = [], []
    for start in range(0, audio.shape[0], N_SAMPLES):
        chunk = audio[start : start + N_SAMPLES]
        lengths.append((chunk.shape[0] - 1) // stride + 1)
        chunks.append(chunk)
    return chunks, lengths
