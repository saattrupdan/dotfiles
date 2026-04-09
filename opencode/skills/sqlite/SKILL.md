---
name: sqlite
description: Conventions when working with SQLite databases
license: MIT
compatibility: opencode
---

## SQLite Conventions

- Use the Python package `sqlmodel` to work with the SQLite database:
  <https://sqlmodel.tiangolo.com/>
- Store all database models in `src/<project_name>/db_models.py`
- Database should by default be stored in `database.db` in the root of the project
- Satisfy the general Python conventions
