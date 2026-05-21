# sqlmodel

Reference for using SQLModel — a Python package for interacting with SQL databases, combining SQLAlchemy and Pydantic.

## Requirements

- Python 3.12+
- PostgreSQL or SQLite database
- Related skills: `python`, `fastapi`

## Quick Start

```bash
# Add dependencies
uv add sqlmodel sqlalchemy psycopg2-binary

# Create a simple model
cat > src/models.py << 'EOF'
from sqlmodel import SQLModel, Field

class Hero(SQLModel, table=True):
    id: int | None = Field(default=None, primary_key=True)
    name: str
    secret_name: str
    age: int | None = None
EOF
```

## Tutorial Reference

### Creating Tables

Create the database tables from your models:

<https://sqlmodel.tiangolo.com/tutorial/create-db-and-table>

### Inserting Data

Use a session to create new rows:

<https://sqlmodel.tiangolo.com/tutorial/insert>

### Reading Data

Query rows with filter, limit, and offset:

| Operation | Docs |
|---|---|
| SELECT | <https://sqlmodel.tiangolo.com/tutorial/select> |
| WHERE (filter) | <https://sqlmodel.tiangolo.com/tutorial/where> |
| One row | <https://sqlmodel.tiangolo.com/tutorial/one> |
| LIMIT / OFFSET | <https://sqlmodel.tiangolo.com/tutorial/limit-and-offset> |

### Updating and Deleting

| Operation | Docs |
|---|---|
| UPDATE | <https://sqlmodel.tiangolo.com/tutorial/update> |
| DELETE | <https://sqlmodel.tiangolo.com/tutorial/delete> |

### Indexes

Optimise queries with indexes:

<https://sqlmodel.tiangolo.com/tutorial/indexes>

### Relationships

#### Connecting Tables

| Topic | Docs |
|---|---|
| Intro | <https://sqlmodel.tiangolo.com/tutorial/connect> |
| Create connected tables | <https://sqlmodel.tiangolo.com/tutorial/connect/create-connected-tables> |
| Create connected rows | <https://sqlmodel.tiangolo.com/tutorial/connect/create-connected-rows> |
| Read connected data | <https://sqlmodel.tiangolo.com/tutorial/connect/read-connected-data> |
| Update connections | <https://sqlmodel.tiangolo.com/tutorial/connect/update-data-connections> |
| Remove connections | <https://sqlmodel.tiangolo.com/tutorial/connect/remove-data-connections> |

#### Relationship Attributes

| Topic | Docs |
|---|---|
| Intro | <https://sqlmodel.tiangolo.com/tutorial/relationship-attributes> |
| Define relationships | <https://sqlmodel.tiangolo.com/tutorial/relationship-attributes/define-relationships-attributes> |
| Create and update | <https://sqlmodel.tiangolo.com/tutorial/relationship-attributes/create-and-update-relationships> |
| Read relationships | <https://sqlmodel.tiangolo.com/tutorial/relationship-attributes/read-relationships> |
| Remove relationships | <https://sqlmodel.tiangolo.com/tutorial/relationship-attributes/remove-relationships> |
| back_populates | <https://sqlmodel.tiangolo.com/tutorial/relationship-attributes/back-populates> |
| Cascade delete | <https://sqlmodel.tiangolo.com/tutorial/relationship-attributes/cascade-delete-relationships> |
| Type annotation strings | <https://sqlmodel.tiangolo.com/tutorial/relationship-attributes/type-annotation-strings> |

### Many-to-Many Relationships

| Topic | Docs |
|---|---|
| Intro | <https://sqlmodel.tiangolo.com/tutorial/many-to-many> |
| Create models with link | <https://sqlmodel.tiangolo.com/tutorial/many-to-many/create-models-with-link> |
| Create data | <https://sqlmodel.tiangolo.com/tutorial/many-to-many/create-data> |
| Update and remove | <https://sqlmodel.tiangolo.com/tutorial/many-to-many/update-remove-relationships> |
| Link model with extra fields | <https://sqlmodel.tiangolo.com/tutorial/many-to-many/link-with-extra-fields> |

### FastAPI Integration

| Topic | Docs |
|---|---|
| Intro | <https://sqlmodel.tiangolo.com/tutorial/fastapi> |
| Simple API | <https://sqlmodel.tiangolo.com/tutorial/fastapi/simple-hero-api> |
| Response model | <https://sqlmodel.tiangolo.com/tutorial/fastapi/response-model> |
| Multiple models | <https://sqlmodel.tiangolo.com/tutorial/fastapi/multiple-models> |
| Read one | <https://sqlmodel.tiangolo.com/tutorial/fastapi/read-one> |
| Limit and offset | <https://sqlmodel.tiangolo.com/tutorial/fastapi/limit-and-offset> |
| Update | <https://sqlmodel.tiangolo.com/tutorial/fastapi/update> |
| Update with extra data | <https://sqlmodel.tiangolo.com/tutorial/fastapi/update-extra-data> |
| Delete | <https://sqlmodel.tiangolo.com/tutorial/fastapi/delete> |
| Session dependency | <https://sqlmodel.tiangolo.com/tutorial/fastapi/session-with-dependency> |
| Teams (other models) | <https://sqlmodel.tiangolo.com/tutorial/fastapi/teams> |
| Relationships | <https://sqlmodel.tiangolo.com/tutorial/fastapi/relationships> |
| Tests | <https://sqlmodel.tiangolo.com/tutorial/fastapi/tests> |

### Code Structure

Organise models across multiple files:

<https://sqlmodel.tiangolo.com/tutorial/code-structure>
