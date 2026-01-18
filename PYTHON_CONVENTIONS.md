# Python Project Conventions

## Development Workflow

### Tool Execution

- Use `uv run` for all script and command execution
- Always run formatters and linters after making any changes:

  ```bash
  uv run ruff format
  uv run ruff check --fix
  ```

- If formatters or linters report issues, fix them, and run them again, and repeat
  until there are no issues

## Code Style

### Documentation

- Use Google-style docstrings for all public functions, classes, and modules.
- Always include a newline after the name of each argument and exception in the
  docstring.
- Avoid tutorial-style `#` comments that explain what code does.
- Comments should explain **why**, not **what** (the code itself should be
  self-explanatory)
- Example:

  ```python
  def process_items(items: list[Item]) -> list[Result]:
      """Process items and return results.

      Args:
          items:
            List of items to process.

      Returns:
          List of processed results.

      Raises:
          ValueError:
            If items list is empty.
      """
      return await batch_process(items)
  ```

### Type Annotations

- Fully type-annotate all functions, methods, and variables
- Target Python 3.12+ syntax:
  - Use `list[T]`, `dict[K, V]`, `set[T]` (not `List`, `Dict`, `Set` from typing)
  - Use `X | Y` for unions (not `Union[X, Y]`)
  - Use `X | None` for optional types (not `Optional[X]`)
- Always use `import typing as t` and use the `t.` prefix for types from the typing
  module, such as `t.Any`, `t.Callable`, `t.TypeVar`, etc.
- Example:

  ```python
  def fetch_data(url: str, timeout: float = 30.0) -> dict[str, t.Any] | None:
      ...
  ```

## Testing

### Test Execution

- Run tests with `uv run pytest`
- All tests must pass before pushing code
- Fix broken tests immediately—do not commit failing tests

### Test Style

- Follow the same conventions as production code
- Use descriptive test names that explain the scenario
- Example:

  ```python
  def test_fetch_data_returns_valid_json() -> None:
      """Test that fetch_data returns properly formatted JSON."""
      result = await fetch_data("https://api.example.com/data")
      assert isinstance(result, dict)
      assert "id" in result
  ```

## Code Organisation

- Keep modules focused and cohesive
- Prefer many small modules over few large ones
- We normally use the following structure (some of the following might not be present
  in all projects):

  ```text
    .
  ├── .devcontainer
  │   └── devcontainer.json
  ├── .editorconfig
  ├── .github
  │   └── workflows
  │       └── ci.yaml
  ├── .gitignore
  ├── .markdownlint.jsonc
  ├── .pre-commit-config.yaml
  ├── CODE_OF_CONDUCT.md
  ├── config
  │   ├── __init__.py
  │   ├── config.yaml
  │   └── hydra
  │       └── job_logging
  │           └── custom.yaml
  ├── CONTRIBUTING.md
  ├── data
  │   ├── final
  │   │   └── .gitkeep
  │   ├── processed
  │   │   └── .gitkeep
  │   └── raw
  │       └── .gitkeep
  ├── dependabot.yaml
  ├── Dockerfile
  ├── docs
  │   └── index.md
  ├── LICENSE
  ├── makefile
  ├── mkdocs.yaml
  ├── models
  │   └── .gitkeep
  ├── notebooks
  │   └── .gitkeep
  ├── pyproject.toml
  ├── README.md
  ├── src
  │   ├── scripts
  │   │   ├── fix_dot_env_file.py
  │   │   └── <script_name>.py
  │   └── <project_name>
  │       ├── __init__.py
  │       └── <module_name>.py
  ├── tests
  │   ├── __init__.py
  │   └── <test_module_name>.py
  └── uv.lock
  ```

  Here `<project_name>` is the name of the project (if there is already a project
  directory in `src/` then use that), and `<module_name>` and `<test_module_name>` are
  just placeholders for the actual module names.
