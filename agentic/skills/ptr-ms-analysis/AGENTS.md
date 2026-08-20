# PTR-MS analysis

This skill is an agent-driven, open-source replacement for PTR-MS Viewer. It ships a
Python CLI that reads IONICON IoniTOF `.h5` files, detects and quantifies ion peaks,
proposes time segments, and serves a browser-based expert review.

Read `SKILL.md` before changing behaviour. It defines the intended analysis workflow,
scientific caveats, and agent-facing contract; `README.md` is the shorter user-facing
CLI reference.

## Stack

- Python 3.9 or newer, packaged with setuptools through `pyproject.toml`.
- Runtime dependencies: NumPy and h5py.
- The `ptr` console entry point resolves to `analyze:main`.
- The review UI is generated and served by Python; there is no separate frontend build.

## Layout

| Path | Purpose |
| --- | --- |
| `scripts/analyze.py` | CLI parsing, command handlers, CSV output, and orchestration. |
| `scripts/ptrms.py` | HDF5 loading, extraction, segmentation, and quantification. |
| `scripts/formula_id.py` | Formula enumeration and candidate scoring. |
| `scripts/viz.py` | Self-contained browser review UI and localhost server. |
| `scripts/gen_rate_constants.py` | Rebuilds the bundled rate-constant JSON. |
| `reference/` | Scientific references and package data shipped with the CLI. |

## Running it

Install the checkout in an isolated environment so its deliberately flat module names
do not collide with other packages:

```bash
pipx install --editable .
ptr --help
ptr rates water
```

For development without a persistent installation, run commands from this directory:

```bash
uvx --from . ptr --help
uvx --from . ptr rates water
```

Use real IoniTOF data only when exercising file-dependent commands. `.h5` files can be
about 1 GB, and a full analysis commonly takes about a minute.

## Validation

There is currently no automated test, lint, or type-check suite. At minimum, run these
smoke checks after a change (the deterministic `viz` browser regression is especially
relevant when changing identification display). The browser check requires the
`agent-browser` CLI (`npm i -g agent-browser` and `agent-browser install`) in addition
to the package's normal Python dependencies:

```bash
python3 scripts/smoke_viz.py
uvx --from . ptr --help
uvx --from . ptr inspect --help
uvx --from . ptr peaks --help
uvx --from . ptr segments --help
uvx --from . ptr analyze --help
uvx --from . ptr viz --help
uvx --from . ptr calibrate --help
uvx --from . ptr compare --help
uvx --from . ptr rates water
uv build
```

For scientific or HDF5-processing changes, also run the affected command on a suitable
local fixture and inspect its JSON diagnostics or CSV output. Do not commit measurement
files, generated review HTML, configs, or result CSVs.

## Conventions

- Keep compatibility with Python 3.9; do not introduce Python 3.10+ syntax without first
  raising `requires-python` deliberately.
- Write documentation and new prose in British English, wrapped at 88 characters.
- Preserve JSON on stdout for discovery commands and send progress logs to stderr.
- Keep the CLI deterministic. Chemistry assignment and segment curation remain explicit
  agent decisions; do not add a one-shot automatic workflow.
- Update `SKILL.md` and `README.md` when flags, output fields, workflow, or scientific
  interpretation change.
- Use Conventional Commits, following the parent dotfiles repository.

## Gotchas

- `scripts/` contains installable top-level modules, not disposable helper scripts.
  `pyproject.toml` maps that directory directly into the package. Do not move it to a
  conventional `src/` layout or change its absolute imports casually.
- Install with `pipx --editable` or another isolated environment. Names such as
  `analyze`, `ptrms`, and `viz` are intentionally flat and can collide globally.
- `reference/rate_constants.json` is generated from `reference/ptrlibrary.csv` by
  `scripts/gen_rate_constants.py`. Change the source or generator, regenerate the JSON,
  and review both files together rather than hand-editing generated entries.
- Reference Markdown, CSV, and JSON files are package data. Keep `pyproject.toml` in
  sync when adding a new bundled file type.
- `viz` reviews an already curated config; it must not silently perform peak or segment
  detection. The delivered CSV is always produced by the analysis path.
- Preserve 1-based, inclusive cycle ranges and deterministic chronological labels:
  `sample_01`, `sample_02`, and `background_01`, `background_02`, numbered separately.
- Do not replace missing calibration or transmission data with plausible-looking values.
  Surface degraded accuracy through the existing diagnostics and NaN behaviour.
- Do not weaken noise, overlap, apex, humidity, blank-file, or sample/background checks
  merely to produce more populated output. These are scientific safeguards.
- The skill replaces proprietary PTR-MS Viewer. Documentation must not instruct users to
  generate, validate, or repair results in that tool; an existing reference CSV may only
  be used for calibration or comparison.
