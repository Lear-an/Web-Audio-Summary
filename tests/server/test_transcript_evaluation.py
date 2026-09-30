from __future__ import annotations

import importlib.util
import json
from pathlib import Path


def test_evaluation_counts_boundary_errors_and_empty_speech(tmp_path: Path) -> None:
    script = Path(__file__).resolve().parents[2] / "tools" / "evaluate_transcripts.py"
    spec = importlib.util.spec_from_file_location("evaluate_transcripts", script)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    sample = tmp_path / "captions.jsonl"
    sample.write_text("\n".join(json.dumps(row, ensure_ascii=False) for row in [
        {"reference": "안녕하세요.", "hypothesis": "안녕하세요", "category": "speech"},
        {"reference": "다음 단계입니다", "hypothesis": "...", "category": "boundary"},
    ]), encoding="utf-8")
    result = module.evaluate(sample)
    assert result["all"]["samples"] == 2
    assert result["all"]["empty_with_speech"] == 1
    assert result["speech"]["cer"] == 0
    assert result["boundary"]["cer"] == 1
