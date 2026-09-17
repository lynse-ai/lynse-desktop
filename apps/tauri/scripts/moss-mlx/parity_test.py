#!/usr/bin/env python3
"""Gate-2 parity tests: torch reference (transformers, MPS) vs moss_mlx (MLX).

Levels:
  0  mel:          our numpy log-mel vs HF WhisperFeatureExtractor
  1  encoder:      MLX AudioTower vs torch WhisperEncoder (same mel)
  2  audio embeds: MLX trim+concat+merge+adaptor vs torch get_audio_features
  3  prompt ids:   our span expansion vs reference processor expansion
  4  generation:   greedy token streams (N tokens) on smoke audio

Run with the moss-mlx venv (torch + transformers + mlx coinstalled):
  venv/bin/python parity_test.py --level all \
      --model ~/Documents/lynse-app/moss-mlx/models/moss-td-bf16 \
      --audio ~/Documents/lynse-app/moss-mlx/fixtures/smoke-1min.wav
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import mlx.core as mx
import numpy as np
import soundfile as sf

REPO_ROOT = Path(__file__).resolve().parents[4]  # apps/tauri/scripts/moss-mlx -> repo root
sys.path.insert(0, str(REPO_ROOT / "apps" / "tauri" / "src-tauri" / "resources"))

MOSS_HOME = Path("~/Documents/lynse-app/moss-mlx").expanduser()
BF16 = mx.bfloat16

results: list[dict] = []


def record(level: int, name: str, ok: bool, detail: str) -> None:
    results.append({"level": level, "name": name, "ok": ok, "detail": detail})
    print(f"[{'PASS' if ok else 'FAIL'}] L{level} {name}: {detail}", flush=True)


def cos(a: np.ndarray, b: np.ndarray) -> float:
    a, b = a.astype(np.float64).ravel(), b.astype(np.float64).ravel()
    return float(a @ b / (np.linalg.norm(a) * np.linalg.norm(b)))


def load_torch(weights_dir: Path):
    import torch
    from transformers import AutoModelForCausalLM, AutoProcessor

    model = AutoModelForCausalLM.from_pretrained(
        str(weights_dir), trust_remote_code=True, dtype="auto", attn_implementation="sdpa"
    ).to(torch.device("mps"))
    processor = AutoProcessor.from_pretrained(str(weights_dir), trust_remote_code=True)
    return torch, model, processor


def to32(p):
    if isinstance(p, mx.array):
        return p.astype(mx.float32)
    if isinstance(p, dict):
        return {k: to32(v) for k, v in p.items()}
    if isinstance(p, list):
        return [to32(v) for v in p]
    return p


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--model", type=Path, default=MOSS_HOME / "models" / "moss-td-bf16")
    p.add_argument("--torch-weights", type=Path, default=MOSS_HOME / "weights")
    p.add_argument("--audio", type=Path, default=MOSS_HOME / "fixtures" / "smoke-1min.wav")
    p.add_argument("--level", default="all", help="all | comma list like 0,1,2")
    p.add_argument("--gen-tokens", type=int, default=64)
    p.add_argument("--dtype", choices=["bf16", "fp32"], default="bf16",
                   help="fp32 casts both engines to fp32 (strict token-equality gate)")
    args = p.parse_args()
    levels = set(range(5)) if args.level == "all" else {int(x) for x in args.level.split(",")}

    import torch
    from transformers import AutoFeatureExtractor

    from moss_mlx.weights import load_model, load_processor
    import moss_mlx.audio as m_audio

    audio_path = args.audio.expanduser()
    waveform, sr = sf.read(str(audio_path), dtype="float32")
    assert sr == 16000 and waveform.ndim == 1

    need_torch = bool(levels & {0, 1, 2, 3, 4})
    if need_torch:
        torch, t_model, t_processor = load_torch(args.torch_weights.expanduser())
        if args.dtype == "fp32":
            t_model = t_model.float()
    mlx_model, mlx_cfg = load_model(args.model.expanduser())
    mlx_proc = load_processor(args.model.expanduser())
    if args.dtype == "fp32":
        mlx_model.update(to32(mlx_model.parameters()))
    device = torch.device("mps")

    # ---- level 0: mel ------------------------------------------------------
    if 0 in levels:
        chunk = waveform[: m_audio.N_SAMPLES]
        ours = m_audio.log_mel(chunk)
        fe = AutoFeatureExtractor.from_pretrained(str(args.torch_weights.expanduser()))
        hf = fe(chunk, sampling_rate=16000, padding="max_length", return_tensors="np")["input_features"][0]
        d = float(np.abs(ours - hf).max())
        record(0, "mel", d < 1e-3, f"max|diff|={d:.2e} cos={cos(ours, hf):.6f}")

    # ---- level 1: encoder (fp32 both sides — math-equality gate) -----------
    if 1 in levels:
        from safetensors.torch import load_file as load_torch_st
        from transformers.models.whisper.modeling_whisper import WhisperEncoder

        chunk = waveform[: m_audio.N_SAMPLES]
        fe = AutoFeatureExtractor.from_pretrained(str(args.torch_weights.expanduser()))
        mel_np = fe(chunk, sampling_rate=16000, padding="max_length", return_tensors="np")[
            "input_features"
        ]  # (1, 80, 3000) float32

        enc = WhisperEncoder(t_model.config.audio_config).eval().float()
        sd_all = load_torch_st(str(args.torch_weights.expanduser() / "model-00000-of-00001.safetensors"))
        enc.load_state_dict(
            {k[len("model.whisper_encoder."):]: v.float()
             for k, v in sd_all.items() if k.startswith("model.whisper_encoder.")},
            strict=True,
        )
        with torch.no_grad():
            ref = enc(torch.from_numpy(mel_np)).last_hidden_state[0].numpy()

        # cast the loaded MLX tower up to fp32 for the math-equality gate
        tower = mlx_model.audio_tower
        tower.update(to32(tower.parameters()))

        got = np.array(tower(mx.array(mel_np))[0])
        c1 = cos(got, ref)
        record(1, "encoder@hf-mel(fp32)", c1 >= 0.9999, f"cos={c1:.8f}")

        ours_mel = m_audio.log_mel(chunk)
        got2 = np.array(tower(mx.array(ours_mel[None]))[0])
        c2 = cos(got2, ref)
        record(1, "encoder@our-mel(fp32)", c2 >= 0.9999, f"cos={c2:.8f}")

    # ---- level 2: audio embeds (through each side's real processor) --------
    if 2 in levels:
        from moss_transcribe_diarize.inference_utils import (
            build_transcription_messages,
            prepare_inputs,
        )

        feats, lengths = mlx_proc.features(waveform)
        ours = np.array(mlx_model.audio_embeds(feats, lengths).astype(mx.float32))

        messages = build_transcription_messages(str(audio_path))
        inputs = prepare_inputs(t_processor, messages, device=device)
        with torch.no_grad():
            ref = t_model.get_audio_features(
                inputs["input_features"].to(device, t_model.dtype),
                inputs["audio_feature_lengths"].to(device),
                inputs["audio_chunk_mapping"].to(device),
            )[0][0].float().cpu().numpy()
        c = cos(ours, ref)
        record(2, "audio_embeds", c >= 0.999, f"cos={c:.6f} shape={ours.shape} vs {ref.shape}")

    # ---- level 3: prompt ids ----------------------------------------------
    if 3 in levels:
        from moss_mlx.processor import DEFAULT_PROMPT as OUR_PROMPT
        from moss_transcribe_diarize.inference_utils import DEFAULT_PROMPT as REF_PROMPT

        record(3, "default_prompt_text", OUR_PROMPT == REF_PROMPT, "verbatim" if OUR_PROMPT == REF_PROMPT else "DIFFERS")

        n_tokens = 375  # one full 30 s chunk
        before, span, after = mlx_proc.encode_prompt_split(n_tokens)
        ref_span = t_processor._audio_span_ids(n_tokens)
        ok_s = span == ref_span

        text = t_processor.apply_chat_template(
            [{"role": "user", "content": [
                {"type": "audio", "audio": "x"},
                {"type": "text", "text": REF_PROMPT},
            ]}],
            tokenize=False, add_generation_prompt=True,
        )
        ref_full = t_processor._expand_audio_token(text, n_tokens, 131072)
        k = ref_full.index(mlx_cfg["audio_token_id"])
        # span is expanded (375 -> 386 with 5 s digit markers); slice accordingly
        ok_b, ok_a = before == ref_full[:k], after == ref_full[k + len(ref_span):]
        record(3, "prompt_ids", ok_s and ok_b and ok_a,
               f"before={ok_b} span={ok_s}(len {len(span)} vs {len(ref_span)}) after={ok_a}")

    # ---- level 4: generation ----------------------------------------------
    if 4 in levels:
        from mlx_lm.models.cache import make_prompt_cache

        from moss_mlx.generate import generate
        from moss_transcribe_diarize.inference_utils import (
            build_transcription_messages,
            generate_transcription,
        )
        from moss_transcribe_diarize.transcript_parser import parse_transcript

        feats, lengths = mlx_proc.features(waveform)
        before, span, after = mlx_proc.encode_prompt_split(sum(lengths))
        audio_embeds = mlx_model.audio_embeds(feats, lengths)
        our_ids = generate(
            mlx_model, mlx_proc.tokenizer, before, span, audio_embeds, after,
            eos_id=mlx_cfg["eos_token_id"], max_new_tokens=args.gen_tokens,
        )
        our_text = mlx_proc.tokenizer.decode(our_ids)

        messages = build_transcription_messages(str(audio_path))
        out = generate_transcription(
            t_model, t_processor, messages, device=device,
            max_new_tokens=args.gen_tokens, do_sample=False,
        )
        ref_text = out["text"]
        our_segs = [(s.start, s.end, s.speaker, s.text) for s in parse_transcript(our_text)]
        ref_segs = [(s.start, s.end, s.speaker, s.text) for s in parse_transcript(ref_text)]
        segs_ok = our_segs == ref_segs
        if args.dtype == "fp32":
            # identical math -> identical tokens, no bf16 rounding excuse
            record(4, f"greedy_{args.gen_tokens}_tokens(fp32-strict)", our_text == ref_text,
                   f"identical={our_text == ref_text} segments={segs_ok}")
        else:
            record(4, f"greedy_{args.gen_tokens}_tokens(bf16)", segs_ok,
                   f"segments_equal={segs_ok} text_identical={our_text == ref_text} "
                   f"segments={len(our_segs)} vs {len(ref_segs)}")
        if our_text != ref_text:
            print(f"  ref : {ref_text[:200]!r}")
            print(f"  ours: {our_text[:200]!r}")

        # ---- divergence probe: teacher-force common prefix, compare top-3 logits
        import torch as _torch

        messages_out = t_processor.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
        from moss_transcribe_diarize.inference_utils import prepare_inputs as _prep

        ref_gen = t_model.generate(
            **{k: v.to(device) for k, v in _prep(t_processor, messages, device=device).items()
               if k in ("input_ids", "attention_mask", "input_features", "audio_feature_lengths", "audio_chunk_mapping")},
            generation_config=None, do_sample=False, max_new_tokens=args.gen_tokens,
            return_dict_in_generate=True, output_scores=True,
        )
        prompt_len = ref_gen.sequences.shape[1] - len(ref_gen.scores)
        ref_ids = ref_gen.sequences[0, prompt_len:].tolist()
        i = next((j for j, (a, b) in enumerate(zip(ref_ids, our_ids)) if a != b), None)
        if i is None:
            print("  probe: token streams identical (no divergence)")
        else:
            n = args.gen_tokens
            # torch side: top-3 at divergence step
            scores = ref_gen.scores[i][0].float().cpu()
            top3_t = _torch.topk(scores, 3)
            # mlx side: teacher-force ref_ids[:i], inspect logits at step i
            cache = make_prompt_cache(mlx_model.lm)
            prompt = mx.concatenate(
                [
                    mlx_model.embed_tokens(mx.array(before))[None],
                    audio_embeds[None],
                    mlx_model.embed_tokens(mx.array(after))[None],
                ],
                axis=1,
            )
            logits = mlx_model.lm(None, cache=cache, input_embeddings=prompt)
            tok = int(mx.argmax(logits[:, -1, :], axis=-1).item())
            mlx_top_at = None
            for step in range(i):
                forced = ref_ids[step] if step < i else tok
                logits = mlx_model.lm(mx.array([[forced]]), cache=cache)
                tok = int(mx.argmax(logits[:, -1, :], axis=-1).item())
                if step == i - 1:
                    mlx_top_at = logits[0, -1]
            top3_m = mx.topk(mlx_top_at, 3) if mlx_top_at is not None else None
            print(f"  probe step {i}: ref top3 ids {top3_t.indices.tolist()} "
                  f"gaps {[round(float(g),4) for g in (top3_t.values - top3_t.values[0]).tolist()]}")
            print(f"            mlx top3 ids {mx.flatten(top3_m).tolist()} "
                  f"(ref chose {ref_ids[i]}, ours chose {our_ids[i]})")
            in_top = ref_ids[i] in mx.flatten(top3_m).tolist() and our_ids[i] in top3_t.indices.tolist()
            gap = float(scores.max() - scores[our_ids[i]]) if our_ids[i] < scores.shape[0] else float("nan")
            print(f"            cross-in-top3={in_top} torch logit gap to our-choice={gap:.4f}")

    n_fail = sum(1 for r in results if not r["ok"])
    print(f"\n{len(results) - n_fail}/{len(results)} checks passed")
    return 1 if n_fail else 0


if __name__ == "__main__":
    sys.exit(main())
