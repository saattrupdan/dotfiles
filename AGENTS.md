# Conventions

## Natural language

Speak either English or Danish, nothing else. Use the same language of the user.

## Python

### Development Workflow

- Use `uv run` for all script and command execution
- Make a todo list of all the things that need to be done, and always add running
  formatters and linters to the list (and ensure that they pass before continuing):

  ```bash
  uv run ruff format
  uv run ruff check --fix
  ```
- Finish all todos on the todo list without asking for permission to continue to the
  next task

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
      return batch_process(items=items)
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

### Testing

- Run tests with `uv run pytest`
- All tests must pass before pushing code
- Fix broken tests immediately - do not commit failing tests

### Code Organisation

- Keep modules focused and cohesive
- Prefer many small modules over few large ones
- All code is in the `src/<project_name>` directory
- All tests are in the `tests/` directory
- Configs are sometimes available and if so, they are in the `config/` directory
- There will always be a `pyproject.toml` file in the root directory
- Use the `tree -a --gitignore -I .git .` command to see the directory structure
