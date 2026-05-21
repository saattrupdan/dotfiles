---
name: full-stack
description: Conventions for building full-stack applications with Vue.js frontend, FastAPI backend, PostgreSQL database, and Docker Compose deployment. Use when building full-stack apps.
tagline: Full-stack: Vue, FastAPI, PostgreSQL, Docker Compose
last-updated: 2026-05-09
---

## Full-stack Conventions

### Stack

- Vue.js for frontend - use the `vue` skill for more info
- FastAPI (Python) for backend - use the `fastapi` skill for more info
- A PostgreSQL database with the Python package `sqlmodel` to interact with it from the
  API - docs are available at <https://sqlmodel.tiangolo.com/>.
- NGINX for reverse proxy
- Docker Compose for deployment
