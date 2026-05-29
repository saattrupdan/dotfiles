# python

Reference for Python coding conventions used across all projects.

## Requirements

- Python 3.12+
- `uv` for dependency management and script execution

## Quick Start

```bash
# Create a new project
uv init myproject
cd myproject

# Add a dependency
uv add requests

# Add a dev dependency
uv add --group=dev pytest ruff ty

# Run a script
uv run src/scripts/my_script.py

# Run quality checks (formatting, linting, type checking)
make check

# Run tests
make test
```

## Project Structure

```
myproject/
├── pyproject.toml
├── config/                   # Configuration files (if present)
├── src/
│   ├── scripts/              # Executable scripts (run with uv run)
│   └── <project_name>/       # Importable modules
├── tests/                    # Test suite
└── Makefile
```

## Core Conventions

### Natural Language

- Write in **British English**, never American English. This applies to comments, docstrings, and documentation.

### Code Organisation

- Keep modules focused and cohesive; prefer many small modules over few large ones
- Modules go in `src/<project_name>/`; scripts go in `src/scripts/`
- Order functions from most high-level to most low-level (main at top, helpers below)
- Use `uv add <package>` to add dependencies — never edit `pyproject.toml` manually
- Use `uv add --group=dev <package>` for development dependencies

### Code Quality

All code must fit within **88 characters**. Run `make check` to apply formatters, linters, and type checkers.

| Tool | Command |
|---|---|
| Formatter | `uv run ruff format` |
| Linter | `uv run ruff check --fix` |
| Type checker | `uv run ty check` |
| Tests | `uv run pytest` |

Never ignore linting errors — fix them.

### Type Hints

- Fully type-annotate all functions, methods, and variables
- Use modern Python 3.12+ syntax: `list[T]`, `dict[K, V]`, `X | Y`, `X | None`
- Import typing as `import typing as t` and use `t.` prefix for `t.Literal`, `t.TypeAlias`, `t.TYPE_CHECKING`
- Import `collections.abc` as `c` and use `c.Iterable`, `c.Generator`, `c.Callable`
- Never use `Any` — prefer `TypeVar` with meaningful names or `TypedDict`
- Use `None` as return type for functions that don't return anything (never `NoReturn`)

### Imports

- Module imports use **relative imports**: `from .another_module import something`
- Script imports use **absolute imports**: `from mypackage.module import something`
- All imports at the top of each file (except circular import exceptions noted with comments)

### Strings and Logging

- Never use `%`-style formatting — use **f-strings**
- Never use `print()` — use a **logger** instead
- Use `pathlib.Path` objects over strings for file paths

### Functions

- Single leading underscore (`_`) for protected members
- Always prefer **keyword arguments** over positional arguments

```python
process_items(items=items)
```

### Documentation

- Comments explain **why**, not **what**
- Use Google-style docstrings for all public functions, classes, and modules
- Always prefer ASCII characters over Unicode

```python
def process_items(items: list[Item], log: bool = False) -> list[Result]:
    """Process items and return results.

    Args:
        items:
          List of items to process.
        log (optional):
          Whether to log progress. Defaults to False.

    Returns:
        List of processed results.
    """
```
