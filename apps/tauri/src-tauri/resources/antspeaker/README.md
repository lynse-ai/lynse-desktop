# antspeaker (vendored)

Vendored from [ant-research/AntSpeaker](https://github.com/ant-research/AntSpeaker)
(main, 2026-09) — the model-definition package for **MECT** (Mixture of Experts
with CNN-Transformer Network for Speaker Verification, arXiv 2609.24061).

- **Code license:** Apache-2.0 (per-file headers by Ant Group). Files are kept
  verbatim except for `__pycache__` removal; do not modify them in place —
  prefer upstream-first changes.
- **Weights license:** the pretrained checkpoints on HuggingFace
  (`AntResearch/AntSpeaker`, e.g. `mect_b2_vb2.pt`) are **CC BY-NC-SA 4.0
  (non-commercial)**. This package contains no weights; checkpoints are
  downloaded on demand to the app data dir and are **not** redistributed in
  app bundles. Shipping them inside a commercial release needs explicit
  permission from the licensor.
- Inference entry point used by the app: `resources/mect_voiceprint.py`.
