---
name: full-stack
description: Conventions when creating full-stack applications. Use when you have to build a full-stack app, i.e., one with both frontend and backend.
metadata:
  triggers: full-stack, fullstack, full stack
  related-skills: fastapi, vue
---

## Full-stack Conventions

### Stack

- Vue.js for frontend - use the vue skill for more info
- FastAPI (Python) for backend - use the fastapi skill for more info
- A SQLite or PostgreSQL database, both with the Python package `sqlmodel` to interact
  with it from the API - docs are available at <https://sqlmodel.tiangolo.com/>.
- NGINX for reverse proxy
- Docker Compose for deployment

### User Questions

You should ask the user if they expect to have several concurrent users or not. If they
do, you should use a PostgreSQL database. If they don't, you can use SQLite.

### Project Structure

In full stack apps, use the following structure:

```bash
.
├── .dockerignore
├── .editorconfig
├── .github
│   └── workflows
│       └── ci.yaml
├── .gitignore
├── .markdownlint.jsonc
├── .pre-commit-config.yaml
├── .prettier.config.js
├── docker-compose.nginx.conf
├── docker-compose.yaml
├── Dockerfile.api
├── Dockerfile.frontend
├── eslint.config.js
├── index.html
├── makefile
├── package-lock.json
├── package.json
├── tsconfig.json
├── tsconfig.node.json
├── uv.lock
├── vite.config.ts
├── pyproject.toml
├── README.md
├── data
│   └── (...)
├── public
│   └── (...)
├── src
│   ├── <project_name>
│   │   ├── __init__.py
│   │   ├── api.py
│   │   ├── lifespan.py
│   │   ├── (...)
│   │   └── routers
│   │       ├── __init__.py
│   │       └── (...)
│   ├── frontend
│   │   ├── App.vue
│   │   ├── main.ts
│   │   ├── vite-env.d.ts
│   │   ├── assets
│   │   │   ├── main.css
│   │   │   └── (...)
│   │   ├── components
│   │   │   └── (...)
│   │   ├── main.ts
│   │   ├── routes
│   │   │   ├── index.ts
│   │   │   └── (...)
│   │   ├── stores
│   │   │   └── (...)
│   │   ├── types
│   │   │   └── (...)
│   │   └── views
│   │       └── (...)
│   └── scripts
│       ├── start_api.py
│       ├── ping_api.py
│       └── (...)
└── tests
    ├── __init__.py
    └── (...)
```

### NGINX config

```nginx title="docker-compose.nginx.conf"
upstream frontend {
  server frontend:5173;
}

upstream api {
  server api:8000;
}

server {
  listen 80;
  server_name localhost;

  location / {
    proxy_pass http://frontend;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_intercept_errors on;
    error_page 404 = @fallback;
  }

  location @fallback {
    try_files $uri $uri/ /index.html //index.html;
  }

  location /api/ {
    proxy_pass http://api/;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }

  location /docs {
    proxy_pass http://api/docs;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }

  location /openapi.json {
    proxy_pass http://api/openapi.json;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
```

### Docker Compose

If using a SQLite database, use the following Docker Compose file:

```yaml title="docker-compose.yaml"
services:
  api:
    env_file:
      - .env
    build:
      context: .
      dockerfile: Dockerfile.api
    volumes:
      - ./data:/project/data
    restart: unless-stopped

  frontend:
    env_file:
      - .env
    build:
      context: .
      dockerfile: Dockerfile.frontend
    restart: unless-stopped
    depends_on:
      - api

  proxy:
    image: nginx:alpine
    ports:
      - 80:80
    volumes:
      - ./docker-compose.nginx.conf:/etc/nginx/conf.d/default.conf:ro
    restart: unless-stopped
    depends_on:
      - frontend
      - api
```

If using a PostgreSQL database, we instead use the following:

```yaml title="docker-compose.yaml"
services:
  api:
    env_file:
      - .env
    build:
      context: .
      dockerfile: Dockerfile.api
    restart: unless-stopped
    depends_on:
      - db

  frontend:
    env_file:
      - .env
    build:
      context: .
      dockerfile: Dockerfile.frontend
    restart: unless-stopped
    depends_on:
      - api

  db:
    attach: false
    env_file:
      - .env
    volumes:
      - ./data/pgdata/:/var/lib/postgresql/data
    image: <postgres-image>
    restart: unless-stopped

  proxy:
    image: nginx:alpine
    ports:
      - 80:80
    volumes:
      - ./docker-compose.nginx.conf:/etc/nginx/conf.d/default.conf:ro
    restart: unless-stopped
    depends_on:
      - frontend
      - api
```

You should replace the `<postgres-image>` string with one of the following:

- `postgres:X.X-trixie`, where you replace `X.X` with the newest version, which can be
  found at the [postgres image on Docker
  Hub](https://hub.docker.com/_/postgres#supported-tags-and-respective-dockerfile-links)
- `pgvector/pgvector:X.X.X-pgY-trixie`, where you replace `X.X.X` with the newest
  version, which can be found at the [pgvector image on Docker
  Hub](https://hub.docker.com/r/pgvector/pgvector/tags) and `Y` with the version of
  PostgreSQL on that last.


