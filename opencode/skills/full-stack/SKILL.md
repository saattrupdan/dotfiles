---
name: full-stack
description: Conventions when creating full-stack applications. Use when you have to build a full-stack app, i.e., one with both frontend and backend.
metadata:
  triggers: full-stack, fullstack, full stack
  related-skills: fastapi, vue
---

## Full-stack Conventions

### Stack

- Vue.js for frontend - use the `vue` skill for more info
- FastAPI (Python) for backend - use the `fastapi` skill for more info
- A PostgreSQL database with the Python package `sqlmodel` to interact with it from the
  API - docs are available at <https://sqlmodel.tiangolo.com/>.
- NGINX for reverse proxy
- Docker Compose for deployment
