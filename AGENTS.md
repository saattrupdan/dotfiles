# Conventions

## Natural language

Speak either English or Danish, nothing else. Use the same language of the user.

## Python

### Development Workflow

- Use `uv run` for all script and command execution
- Make a todo list of all the things that need to be done, and always add running
  formatters and linters to the list
- Finish all todos on the todo list without asking for permission to continue to the
  next task

### Code Organisation

- Keep modules focused and cohesive
- Prefer many small modules over few large ones
- All code modules are in the `src/<project_name>` directory. These are not executed but
  are imported by the scripts
- All scripts are in the `src/scripts` directory. These are executed with `uv run`
- All tests are in the `tests/` directory
- Configs are sometimes available and if so, they are in the `config/` directory
- There will always be a `pyproject.toml` file in the root directory
- Use the `tree -a --gitignore -I .git .` command to see the directory structure

### Code Formatting and Linting

- Run code formatters with `uv run ruff format`
- Run linters with `uv run ruff check`
- Code should always fit within 88 characters
- When we import things in modules from other modules in the package, we always do it
  using relative imports:
  ```python title="src/mypackage/module.py"
  from .another_module import some_function
  ```
- When we import things in scripts from other modules or other scripts, we always do it
  using absolute imports:
  ```python title="src/scripts/script.py"
  from mypackage.module import some_function
  from another_script import some_other_function
  ```

### Testing

- Run tests with `uv run pytest`
- All tests must pass before pushing code
- Fix broken tests immediately - do not commit failing tests

### Comments

- Avoid tutorial-style `#` comments that explain what code does.
- Comments should explain **why**, not **what** (the code itself should be
  self-explanatory)

### Docstrings

- Use Google-style docstrings for all public functions, classes, and modules.
- Always include a newline after the name of each argument and exception in the
  docstring.
- Always prefer ascii characters over unicode (e.g., arrows as -> over →)
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
  module, such as `t.Literal`, `t.TypeAlias` or `t.TYPE_CHECKING`
- For `Iterable`, `Generator` and `Callable`, use these from the `collections.abc`
  module, not from `typing`. Import this as `import collections.abc as c` and refer to
  the types as `c.Iterable`, `c.Generator` and `c.Callable`, etc.
- Never use the `Any` type. Use `t.TypeVar` instead, but always give such type variables
  meaningful names, and not just single letter names like `T`.
- Example:

  ```python
  def fetch_data(
      url: str, timeout: float = 30.0
  ) -> dict[str, t.Literal["success", "error"]]:
      ...
  ```

### Functions

- Never use protected names for functions. I.e., function names should never start with
  a single underscore (`_`). Protected names for methods are completely fine, and
  indicates that the method is only intended for use within the class.
- Always use keyword arguments when calling functions, never positional arguments
- Example:

  ```python
  def process_items(items: list[Item]) -> list[Result]:
      ...

  process_items(items=items)
  ```
