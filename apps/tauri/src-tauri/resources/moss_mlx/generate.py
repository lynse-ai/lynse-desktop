"""Greedy generation with streaming segment parsing.

Prefill takes full prompt embeddings (text-before + audio-span + text-after)
so audio never passes through the token embedding table. It runs through
mlx-lm's ``generate_step``, which feeds the prompt to the KV cache in 2048-
token slices and computes logits only for the final position — a naive
whole-sequence forward would materialize a (seq_len x vocab) logits tensor
(tens of GB for a 90-minute session). Decode is a plain argmax loop over the
mlx-lm KV cache, stopping at <|im_end|>.
"""

from __future__ import annotations

import mlx.core as mx

from .transcript_parser import TranscriptStreamParser, TranscriptSegment

HOLDBACK_CHARS = 8  # never stream-parse the tail: byte-level decode may lag


class SegmentStreamer:
    """Feeds incrementally decoded text into the vendored stream parser."""

    def __init__(self, tokenizer, emit):
        self._tokenizer = tokenizer
        self._emit = emit
        self._parser = TranscriptStreamParser()
        self._consumed = 0
        self._ids: list[int] = []

    def feed(self, token_id: int) -> list[TranscriptSegment]:
        self._ids.append(token_id)
        text = self._tokenizer.decode(self._ids)
        safe_end = max(0, len(text) - HOLDBACK_CHARS)
        segments: list[TranscriptSegment] = []
        if safe_end > self._consumed:
            self._parser.feed_into(text[self._consumed : safe_end], segments.append)
            self._consumed = safe_end
        for seg in segments:
            self._emit(seg)
        return segments

    def close(self) -> list[TranscriptSegment]:
        text = self._tokenizer.decode(self._ids)
        segments: list[TranscriptSegment] = []
        if len(text) > self._consumed:
            self._parser.feed_into(text[self._consumed :], segments.append)
            self._consumed = len(text)
        self._parser.close_into(segments.append)
        for seg in segments:
            self._emit(seg)
        return segments


def build_prompt_embeds(model, before_ids, span_ids, audio_embeds, after_ids):
    """Full prefill sequence: text + span with audio rows scattered into pads.

    The span contains <|audio_pad|> positions (consume audio_embeds rows in
    order) AND digit-marker tokens (regular embeddings) — mirroring the
    reference's masked_scatter over the expanded placeholder.
    """
    import mlx.core as mx

    pad_id = model.config["audio_token_id"]
    parts = [model.embed_tokens(mx.array(before_ids))[None]]
    span_rows = []
    ai = 0
    for tid in span_ids:
        if tid == pad_id:
            span_rows.append(audio_embeds[ai])
            ai += 1
        else:
            span_rows.append(model.embed_tokens(mx.array([tid]))[0])
    if ai != audio_embeds.shape[0]:
        raise ValueError(
            f"audio embed count {audio_embeds.shape[0]} != pad positions {ai} in span"
        )
    parts.append(mx.stack(span_rows)[None])
    parts.append(model.embed_tokens(mx.array(after_ids))[None])
    return mx.concatenate(parts, axis=1)


def generate(
    model,
    tokenizer,
    before_ids: list[int],
    span_ids: list[int],
    audio_embeds,
    after_ids: list[int],
    *,
    eos_id: int,
    max_new_tokens: int = 16384,
    on_segment=None,
    prefill_progress=None,
    progress=None,
) -> list[int]:
    """Greedy decode. Returns generated token ids (excluding EOS).

    ``prefill_progress(processed, total)`` fires per prefill slice,
    ``progress(step, max_new_tokens)`` fires per decoded token.
    """
    from mlx_lm.generate import generate_step
    from mlx_lm.models.cache import make_prompt_cache

    prompt = build_prompt_embeds(model, before_ids, span_ids, audio_embeds, after_ids)
    cache = make_prompt_cache(model.lm)

    generated: list[int] = []
    streamer = SegmentStreamer(tokenizer, on_segment) if on_segment is not None else None
    steps = generate_step(
        mx.array([], mx.int32),  # token ids unused; embeddings carry the prompt
        model.lm,
        max_tokens=max_new_tokens,
        prompt_cache=cache,
        input_embeddings=prompt[0],
        prompt_progress_callback=prefill_progress,
    )
    for token, _ in steps:
        token = int(token)
        if token == eos_id:
            break
        generated.append(token)
        if streamer is not None:
            streamer.feed(token)
        if progress is not None:
            progress(len(generated), max_new_tokens)
    if streamer is not None:
        streamer.close()
    return generated
