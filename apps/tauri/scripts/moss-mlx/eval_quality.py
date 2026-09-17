#!/usr/bin/env python3
"""Quality evaluation: candidate transcript vs reference (CER + SATS structure).

Compares a bench_moss.py report (or segments.json) against a reference report:
  * CER over the concatenated transcript text (jiwer)
  * speaker count / segment count deltas
  * per-segment timestamp drift (|start_cand - start_ref| matched greedily)
  * (speaker, text) exact segment match rate

Usage:
  venv/bin/python eval_quality.py --ref results/baseline-torch.json \
      --cand results/mlx-bf16-meeting5min.json
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


def load_segments(path: Path) -> list[dict]:
    data = json.loads(path.read_text())
    if isinstance(data, dict) and "runs" in data:  # bench report
        return data["runs"][0]["segments"]
    if isinstance(data, dict) and "segments" in data:  # single run
        return data["segments"]
    return data  # raw segments.json list


def cer(ref: str, cand: str) -> float:
    import jiwer

    return float(jiwer.cer(ref, cand))


def segment_drift(ref: list[dict], cand: list[dict]) -> tuple[float, int, int]:
    """Timestamp drift over difflib-aligned segments (valid even when counts differ).

    Returns (p95_drift_seconds, n_paired, n_unpaired_cand).
    """
    import difflib

    ref_texts = [s["text"] for s in ref]
    cand_texts = [s["text"] for s in cand]
    matcher = difflib.SequenceMatcher(a=ref_texts, b=cand_texts, autojunk=False)
    drifts = []
    for block in matcher.get_matching_blocks():
        for k in range(block.size):
            r = ref[block.a + k]
            c = cand[block.b + k]
            drifts.append(abs(r["start"] - c["start"]))
    drifts.sort()
    p95 = drifts[int(0.95 * (len(drifts) - 1))] if drifts else float("nan")
    return p95, len(drifts), len(cand) - len(drifts)


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--ref", required=True, type=Path)
    p.add_argument("--cand", required=True, type=Path)
    p.add_argument("--max-ts-drift", type=float, default=0.5, help="p95 drift gate (s)")
    args = p.parse_args()

    ref = load_segments(args.ref.expanduser())
    cand = load_segments(args.cand.expanduser())

    ref_text = "".join(s["text"] for s in ref)
    cand_text = "".join(s["text"] for s in cand)
    c = cer(ref_text, cand_text)

    ref_spk = sorted({s["speaker"] for s in ref})
    cand_spk = sorted({s["speaker"] for s in cand})

    exact = sum(
        1 for a, b in zip(ref, cand) if (a["speaker"], a["text"]) == (b["speaker"], b["text"])
    )
    n_paired = min(len(ref), len(cand))

    p95, n_aligned, n_unpaired = segment_drift(ref, cand)

    checks = {
        "cer_pp": round(c * 100, 3),
        "speaker_count_ref": len(ref_spk),
        "speaker_count_cand": len(cand_spk),
        "speakers_exact_match": ref_spk == cand_spk,
        "segments_ref": len(ref),
        "segments_cand": len(cand),
        "segment_exact_rate": round(exact / n_paired, 4) if n_paired else 0.0,
        "ts_drift_p95_s": round(p95, 3),
        "ts_aligned_segments": n_aligned,
        "ts_unpaired_cand": n_unpaired,
    }
    print(json.dumps(checks, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
