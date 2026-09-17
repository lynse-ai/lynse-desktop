# MOSS-Transcribe-Diarize → MLX 权重映射表

Source: `~/Documents/lynse-app/moss-mlx/weights/` (ModelScope `OpenMOSS/MOSS-Transcribe-Diarize`, bf16, 683 tensors).
Gate 1: every rule below is pattern-exact; **683/683 covered, 0 unaccounted**.

## Architecture (from modeling_moss_transcribe_diarize.py, 369 lines of glue only)

```
log-mel [N_chunks, 80, 3000]          (HF WhisperFeatureExtractor, 30 s chunks)
  → WhisperEncoder (transformers 原版, 24 layers, d=1024, 16 heads, GELU)
  → per-chunk trim to token_len*4 frames → concat chunks (T, 1024)
  → time_merge: (T,1024) → (T/4, 4096)  [trim to multiple of 4, plain reshape]
  → VQAdaptor: Linear(4096→1024) → SiLU → Linear(1024→1024) → LayerNorm(eps=1e-6)
  → masked_scatter into embed at audio_token_id=151671
  → Qwen3-0.6B decoder (16 q-heads / 8 kv-heads, head_dim 128, tie embeddings)
```

Reuse plan: encoder ← mlx-whisper `WhisperEncoder`; LLM ← `mlx_lm.models.qwen3`;
only VQAdaptor + time_merge + audio-span expansion are hand-written.

## Weight layout facts (no transposes needed)

- Conv1d: torch `(out_ch, in_ch, k)` ≠ MLX `(out_ch, k, in_ch)` — **transpose(0,2,1) at conversion** (shape check in convert_weights.py catches this).
- Linear: torch `(out, in)` == MLX `nn.Linear` `(dims_in→dims_out)` same layout.
- `lm_head` is **tied** to `embed_tokens` (`tie_word_embeddings: true`) — no tensor; derive at runtime.
- Whisper attn: q/v proj have bias, k proj has **no bias**, out_proj has bias.
- Qwen3 attn: `attention_bias: false` → no bias on q/k/v/o proj anywhere.

## Mapping rules

### 1. whisper_encoder: `model.whisper_encoder.*` → `audio_tower.*` (367)

| source (count) | target | shape | notes |
|---|---|---|---|
| conv1.{weight,bias}, conv2.{weight,bias} (4) | `audio_tower.conv{1,2}.*` | [1024,80,3] / [1024,1024,3] | GELU after each; stride 1 then 2 |
| embed_positions.weight (1) | `audio_tower.embed_positions.weight` | [1500,1024] | sinusoidal, load as-is |
| layers.N.self_attn.{q,v,out}_proj.{weight,bias} (72+... ) | `audio_tower.layers.N.…` | q [1024,1024] | per layer: q,v,out biases exist |
| layers.N.self_attn.k_proj.weight (24) | `audio_tower.layers.N.self_attn.k_proj.weight` | [1024,1024] | **no k bias** |
| layers.N.{fc1,fc2}.{weight,bias} (96) | same names | fc1 [4096,1024] | GELU between |
| layers.N.{self_attn_layer_norm,final_layer_norm}.{weight,bias} (96) | same names | [1024] | **eps=1e-5** (WhisperConfig default) |
| layer_norm.{weight,bias} (2) | `audio_tower.layer_norm.*` | [1024] | final LN, eps=1e-5 |
| layer subtotal (24×15+7) | | | **367** ✓ |

Encoder attention: full (non-causal), scale = d^-0.5, no cache.

### 2. vq_adaptor: `model.vq_adaptor.layers.*` → `adaptor.layers.*` (6)

| source | target | shape | notes |
|---|---|---|---|
| layers.0.{weight,bias} | `adaptor.layers.0.*` | [1024,4096] | Linear, then SiLU |
| layers.2.{weight,bias} | `adaptor.layers.2.*` | [1024,1024] | Linear (layers.1 = SiLU, no params) |
| layers.3.{weight,bias} | `adaptor.layers.3.*` | [1024] | **LayerNorm eps=1e-6** (uses text rms_norm_eps) |

### 3. language_model: `model.language_model.*` → `lm.*` (310)

| source (count) | target | shape | notes |
|---|---|---|---|
| embed_tokens.weight (1) | `lm.embed_tokens.weight` | [151936,1024] | lm_head tied to this |
| norm.weight (1) | `lm.norm.weight` | [1024] | RMSNorm **eps=1e-6** |
| layers.N.input_layernorm.weight (28) | `lm.layers.N.input_layernorm.weight` | [1024] | RMSNorm 1e-6 |
| layers.N.post_attention_layernorm.weight (28) | same name | [1024] | |
| layers.N.self_attn.{q,k,v,o}_proj.weight (112) | same names | q [2048,1024], k/v [1024,1024], o [1024,2048] | 16 q / 8 kv heads, head_dim 128 |
| layers.N.self_attn.{q,k}_norm.weight (56) | same names | [128] | QK-RMSNorm eps 1e-6 |
| layers.N.mlp.{gate,up,down}_proj.weight (84) | same names | gate/up [3072,1024], down [1024,3072] | SiLU gate |
| layer subtotal (28×11) | | | 308; +2 = **310** ✓ |

RoPE: theta **1e6**, head_dim 128; mlx-lm qwen3 default. No bos (`bos_token_id: null`), pad=151643, EOS=151645 (`<|im_end|>`).

**Total: 367 + 6 + 310 = 683 ✓**

## Audio-span expansion (processor port must replicate exactly)

1. Waveform (16 kHz mono) → chunks of `n_samples=480000` (30 s); per chunk
   `token_len = ceil(chunk_samples / 1280)` (= hop 160 × encoder stride 2 × merge 4; **12.5 tokens/s**);
   pad chunk to 480000 → log-mel [80, 3000].
2. log-mel: HF WhisperFeatureExtractor — STFT n_fft 400 / hop 160 / center padding,
   `log_spec = max(log10(clamp(mel,1e-10)), max-8); (log_spec+4)/4`, pad right with 0.0.
3. Encoder frames kept per chunk: `token_len * 4` (≈ ceil(samples/320)); chunks concatenated
   before merge — **not** encoded independently end-to-end.
4. Chat template (Qwen3 im_start/im_end) renders audio as `<|audio_start|><|audio_pad|><|audio_end|>\n`;
   split text at the single `<|audio_pad|>`, tokenize before/after, insert span ids between.
5. Span ids: `audio_token_id=151671` repeated, with **digit tokens inserted every 25 tokens (2 s)**
   as absolute-time markers ("2","4",…"0","1","0" for 100…; each digit = single token).
   `enable_time_marker=True`, 12.5 tok/s anchor rate.
6. Prompt: `DEFAULT_PROMPT` (Chinese SATS instruction, see inference_utils.py).
   Generation: greedy, stop at EOS 151645, max_new_tokens 16384 (baseline parity).

## Gate-2 parity checklist (failure points ranked)

1. log-mel normalization differences (HF vs OpenAI/mlx-whisper) → compare mel arrays first.
2. Audio-span digit markers (off-by-one consumes alignment).
3. per-chunk frame trim `token_len*4` before concat.
4. Whisper encoder LN eps 1e-5 vs Qwen3 RMS eps 1e-6 (don't unify).
5. Tied lm_head (must not double-load / must scale like torch).
6. Conv1d/Linear layouts (verified same; sanity-check with shape asserts at convert time).
