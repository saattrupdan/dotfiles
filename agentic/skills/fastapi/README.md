# fastapi

Reference for building FastAPI apps following established conventions.

## Requirements

- Python 3.12+
- `uv` for dependency management and script execution
- Related skills: `python` (general Python conventions)

## Quick Start

```bash
# Create a new FastAPI project (src layout)
uv init --lib myproject
cd myproject
uv add fastapi uvicorn[standard]

# Run the development server
uv run uvicorn myproject.main:app --reload
```

## Project Structure

```
myproject/
├── pyproject.toml
├── src/
│   └── myproject/
│       ├── __init__.py
│       ├── main.py          # FastAPI app entry point
│       └── routers/          # Organised API routes
│           ├── __init__.py
│           └── users.py
└── tests/
```

## Conventions

### Application Setup

- Use the `lifespan` context manager when building the `FastAPI` object (instead of deprecated `on_event` handlers)
- Use FastAPI `Router` objects to organise the API into logical groups

### Example main.py

```python
from contextlib import asynccontextmanager
from fastapi import FastAPI

@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup logic
    yield
    # Shutdown logic

app = FastAPI(lifespan=lifespan)
```

### Routing

- Group related endpoints into separate router files under a `routers/` directory
- Apply routers to the main app with `app.include_router()`

```python
from fastapi import APIRouter
from .users import router as users_router
from .items import router as items_router

app.include_router(users_router, prefix="/users", tags=["users"])
app.include_router(items_router, prefix="/items", tags=["items"])
```

### Dependencies

- Use `uv add <package>` to add dependencies, never edit `pyproject.toml` manually
- Use `uv add --group=dev <package>` for development dependencies

## Documentation

- Full documentation: <https://fastapi.tiangolo.com/>

## Related Skills

- `python` — General Python conventions (type hints, code organisation, etc.)
