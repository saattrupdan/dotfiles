# full-stack

Reference for building full-stack applications following the established conventions.

## Requirements

- Node.js and npm for frontend tooling
- Python 3.12+ with `uv` for backend tooling
- PostgreSQL database
- Docker Compose for deployment
- NGINX for reverse proxy

## Stack

| Layer | Technology |
|---|---|
| Frontend | Vue.js (Composition API, TypeScript) |
| Backend | FastAPI (Python) |
| Database | PostgreSQL |
| ORM | SQLModel |
| Reverse Proxy | NGINX |
| Deployment | Docker Compose |

## Project Structure

```
myproject/
├── docker-compose.yml
├── nginx/
│   └── default.conf
├── src/
│   ├── backend/              # FastAPI application
│   │   ├── pyproject.toml
│   │   └── src/
│   │       └── backend/
│   │           ├── __init__.py
│   │           └── main.py
│   └── frontend/             # Vue.js application
│       ├── package.json
│       └── src/
│           └── ...
└── tests/
```

## Quick Start

```bash
# Start all services via Docker Compose
docker compose up --build

# Run backend development server
cd src/backend
uv run uvicorn src.backend.main:app --reload

# Run frontend development server
cd src/frontend
npm run dev
```

## Development Workflow

1. **Backend**: Use the `fastapi` skill for API conventions
2. **Frontend**: Use the `vue` skill for frontend conventions
3. **Database**: Use the `sqlmodel` skill for ORM operations
4. **Code Quality**: Run `make check` in each layer to validate formatting, linting, and type checking
5. **Tests**: Run `make test` to execute the test suites

## Deployment

- NGINX serves the frontend static files and proxies API requests to the FastAPI backend
- Docker Compose orchestrates all services (frontend, backend, database, proxy)

## Related Skills

- `fastapi` — Backend API conventions
- `vue` — Frontend conventions
- `python` — General Python conventions
- `sqlmodel` — Database ORM conventions
