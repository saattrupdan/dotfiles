---
name: fastapi
description: Conventions when building FastAPI apps
license: MIT
compatibility: opencode
---

## FastAPI Conventions

- Use the Python package `fastapi` to build the API: <https://fastapi.tiangolo.com/>
- Use the `lifespan` when building the `FastAPI` object
- Use FastAPI routers to organise the API
- General structure:
  ```bash
  src/<project_name>/
  ├── __init__.py
  ├── api.py
  ├── lifespan.py
  ├── routers/
  │   ├── __init__.py
  │   ├── <router_name>.py
  │   └── ...
  └── ...
  ```
- Satisfy the general Python conventions
