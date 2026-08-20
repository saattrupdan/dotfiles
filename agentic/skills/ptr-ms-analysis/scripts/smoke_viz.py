#!/usr/bin/env python3
"""Deterministic source smoke check for the embedded review UI.

The package has no browser test harness. Keep the key identification-display
invariants here so a refactor cannot silently restore confidence wording or
remove candidate-click assignment without making this check fail.
"""
from pathlib import Path


SOURCE = Path(__file__).with_name("viz.py").read_text(encoding="utf-8")

assert "top confidence" not in SOURCE
assert "p.candidates.length===1" in SOURCE
assert "only generated formula candidate — not a confidence estimate" in SOURCE
assert "% share" in SOURCE
assert "relative candidate score/share (not identification confidence)" in SOURCE
assert "formula ranking cannot determine structural isomers" in SOURCE
assert 'const status=assigned' in SOURCE
assert "row.onclick=()=>assignCandidate(p,c)" in SOURCE

print("viz identification display smoke check: OK")
