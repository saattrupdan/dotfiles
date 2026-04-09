---
name: full-stack
description: Conventions when creating full-stack applications.
license: MIT
compatibility: opencode
---

## Full-stack Conventions

### Stack

- Vue.js for frontend
- FastAPI (Python) for backend
- SQLite for database
- NGINX for reverse proxy
- Docker Compose for deployment

### Docker Compose

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

```yaml title="docker-compose.yaml"
name: jobbot

services:
  api:
    env_file:
      - .env
    build:
      context: .
      dockerfile: Dockerfile.api
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
