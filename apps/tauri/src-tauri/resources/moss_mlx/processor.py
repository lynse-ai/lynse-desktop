"""Prompt construction + audio feature packing for the MLX port.

Replicates MossTranscribeDiarizeProcessor: chat template rendering (hardcoded
for the single-audio transcription case), <|audio_pad|> expansion with
absolute-time digit markers every 2 s inside the audio span, and 30 s chunking
into log-mel batches. Uses the `tokenizers` library (tokenizer.json) directly
— no transformers dependency at runtime.
"""

from __future__ import annotations

from pathlib import Path

import mlx.core as mx
import numpy as np
from tokenizers import Tokenizer

from .audio import chunk_waveform, log_mel

# Copied verbatim from moss_transcribe_diarize.inference_utils.DEFAULT_PROMPT.
DEFAULT_PROMPT = (
    "请将音频转写为文本，每一段需以起始时间戳和说话人编号"
    "（[S01]、[S02]、[S03]…）开头，正文为对应的语音内容，"
    "并在段末标注结束时间戳，以清晰标明该段语音范围。"
)

# chat_template.jinja rendered for messages=[user: [audio, text]] +
# add_generation_prompt=True; the audio content becomes the three-token span.
PROMPT_TEMPLATE = (
    "<|im_start|>system\nYou are a helpful assistant.<|im_end|>\n"
    "<|im_start|>user\n<|audio_start|><|audio_pad|><|audio_end|>\n{prompt}<|im_end|>\n"
    "<|im_start|>assistant\n"
)


class MossProcessor:
    def __init__(self, model_dir: Path):
        self.config = _load_json(Path(model_dir) / "config.json")
        self.tokenizer = Tokenizer.from_file(str(Path(model_dir) / "tokenizer.json"))
        cfg = self.config
        self.audio_pad_id = cfg["audio_token_id"]
        self.eos_id = cfg["eos_token_id"]
        self.tokens_per_second = cfg.get("tokens_per_second", 12.5)
        self.marker_every_seconds = cfg.get("marker_every_seconds", 2)
        self.enable_time_marker = cfg.get("enable_time_marker", True)
        self.merge_size = cfg.get("audio_merge_size", 4)
        self.digit_ids = {}
        for d in "0123456789":
            ids = self.tokenizer.encode(d, add_special_tokens=False).ids
            if len(ids) != 1:
                raise ValueError(f"digit {d!r} is not a single token: {ids}")
            self.digit_ids[d] = ids[0]

    def audio_span_ids(self, num_audio_tokens: int) -> list[int]:
        """audio_pad ids with digit tokens inserted every marker_every_seconds.

        Verbatim port of _audio_span_ids: 12.5 tokens/s * 2 s = 25-token cells;
        the digit sequence of the elapsed second count replaces nothing but is
        inserted after each full cell (so digits consume span length).
        """
        n = int(num_audio_tokens)
        if not self.enable_time_marker or n <= 0 or self.marker_every_seconds <= 0:
            return [self.audio_pad_id] * max(n, 0)
        tokens_per_marker = int(self.tokens_per_second * self.marker_every_seconds)
        if tokens_per_marker <= 0:
            return [self.audio_pad_id] * n

        duration = n / float(self.tokens_per_second)
        out: list[int] = []
        consumed = 0
        for sec in range(self.marker_every_seconds, int(duration) + 1, self.marker_every_seconds):
            pos = (sec // self.marker_every_seconds) * tokens_per_marker
            segment_len = pos - consumed
            if segment_len > 0:
                out.extend([self.audio_pad_id] * segment_len)
                consumed += segment_len
            out.extend(self.digit_ids[d] for d in str(sec))
        remainder = n - consumed
        if remainder > 0:
            out.extend([self.audio_pad_id] * remainder)
        return out

    def encode_prompt_split(self, num_audio_tokens: int, prompt: str = DEFAULT_PROMPT):
        """(before_ids, span_ids, after_ids) around the expanded audio span.

        Splits the template at the literal <|audio_pad|> and encodes the two
        halves separately — byte-for-byte mirroring _expand_audio_token so BPE
        boundary merges behave identically.
        """
        text = PROMPT_TEMPLATE.format(prompt=prompt)
        parts = text.split("<|audio_pad|>")
        if len(parts) != 2:
            raise ValueError("expected exactly one <|audio_pad|> in the prompt")
        before = self.tokenizer.encode(parts[0], add_special_tokens=False).ids
        after = self.tokenizer.encode(parts[1], add_special_tokens=False).ids
        return before, self.audio_span_ids(num_audio_tokens), after

    def features(self, waveform: np.ndarray) -> tuple[mx.array, list[int]]:
        """16 kHz mono waveform -> (mel [C, 80, 3000], merged-token lengths)."""
        chunks, lengths = chunk_waveform(np.asarray(waveform, dtype=np.float32), self.merge_size)
        mel = np.stack([log_mel(c) for c in chunks])
        return mx.array(mel), lengths


def _load_json(path: Path) -> dict:
    import json

    return json.loads(Path(path).read_text())
