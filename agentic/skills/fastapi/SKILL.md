---
name: fastapi
description: Conventions for building FastAPI applications in Python. Use when building or reviewing FastAPI backends.
tagline: FastAPI backend application development conventions in Python
last-updated: 2026-05-09
autoload:
  tools:
    - read
    - write
    - edit
  paths:
    - "**/api/**/*.py"
    - "**/routers/**/*.py"
    - "**/routes/**/*.py"
    - "**/api.py"
    - "**/router.py"
    - "**/routes.py"
---

## FastAPI Conventions

- Use the Python package `fastapi` to build the API: <https://fastapi.tiangolo.com/>
- Use the `lifespan` when building the `FastAPI` object
- Use FastAPI routers to organise the API
- Satisfy the general Python conventions
