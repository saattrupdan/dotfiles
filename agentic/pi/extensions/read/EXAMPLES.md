# `read` examples

These are real outputs produced by the `read` extension on representative
files of each supported type. Sample files are synthetic and padded past the
100-line threshold so outline mode kicks in; smaller files are returned
verbatim and don't need an outline.

Outline mode shows nested structure with line numbers so you can pick a
symbol and follow up with `read path symbol="<name>"` to get just that
section. Where useful, symbol-body calls are shown beneath each outline.

## Python

```
> read samples/orders.py
# outline of samples/orders.py (120 lines)
      """Order-processing pipeline used by the checkout service."""
   7  class Order  — A customer order.
  14    def apply_discount(self, pct: float) -> float  — Return the total after applying a percentage discount.
  18    def is_large(self) -> bool
  22  class OrderPipeline  — Coordinates validation, pricing, and dispatch.
  28    def validate(self) -> list[Order]  — Drop malformed orders and return the rest.
  32    def price(self, orders: list[Order]) -> list[Order]
  35    def dispatch(self, orders: list[Order]) -> None
  45  def total_revenue(orders: Iterable[Order]) -> float  — Sum order totals across an iterable.
# read again with symbol="<name>" to see a function/class body, symbol="__preamble__" for imports/constants, or use `search` to locate something specific.
```

```
> read samples/orders.py symbol="OrderPipeline.validate"
# samples/orders.py::OrderPipeline.validate  lines 28-30 (method)
    def validate(self) -> list[Order]:
        """Drop malformed orders and return the rest."""
        return [o for o in self._source if o.id > 0]
```

## TypeScript

```
> read samples/users.ts
# outline of samples/users.ts (120 lines)
      """User repository — wraps the auth backend."""
  11  class NotFoundError  — Thrown when a user lookup fails.
  13  class UserRepo
  14    def constructor(private readonly db: Database)
  16    def findById(id: number): Promise<User>
  22    def listActive(): Promise<User[]>
  28  def formatUser(u: User): string  — Format a user for display.
# read again with symbol="<name>" to see a function/class body, symbol="__preamble__" for imports/constants, or use `search` to locate something specific.
```

```
> read samples/users.ts symbol="UserRepo.findById"
# samples/users.ts::UserRepo.findById  lines 16-20 (method)
  async findById(id: number): Promise<User> {
    const row = await this.db.query("select * from users where id = ?", [id]);
    if (!row) throw new NotFoundError(String(id));
    return row as User;
  }
```

## Markdown

```
> read agentic/pi/README.md
# outline of agentic/pi/README.md (149 lines)
    1  # pi
   18    ## Extensions
   29      ### `read`
   49      ### `skill`
   63      ### `search`
   73      ### `code-tree`
   82      ### `web-fetch`
   91      ### `web-search`
   99      ### `web-browse`
  107      ### `subagent`
  124      ### `no-repeat`
  133      ### `_outliner` (library, not a tool)
# read again with symbol="<name>" to see a function/class body, symbol="__preamble__" for imports/constants, or use `search` to locate something specific.
```

```
> read agentic/pi/README.md symbol="Extensions.`read`"
# agentic/pi/README.md::Extensions.`read`  lines 28-46 (heading)
### `read`

Index-backed file reader with no pagination. Three modes:

1. Small file, no symbol → returned verbatim.
2. Large file, no symbol → outline (module doc + one line per symbol with
   signature and doc-first-line).
3. `symbol` set → body of that symbol via `line_start..line_end` from the
   shared index. Supports `Class.method`.

Outline + symbol ranges come from the SQLite index in
`~/.pi/index/<repo-id>/index.db` (shared with `search`). The target file is
incrementally refreshed on every call so edits are picked up without a full
rebuild. Includes a per-session dedupe cache and a MIME sniff that surfaces
images as image content rather than raw bytes.

See [`extensions/read/EXAMPLES.md`](extensions/read/EXAMPLES.md) for sample
outputs across all supported file types — Python, TypeScript, Lua, Rust, Go,
Shell, SQL, CSS, HTML, Markdown, JSON, JSONL, CSV, YAML, and TOML.

```
## Lua

```
> read samples/statusline.lua
# outline of samples/statusline.lua (120 lines)
      """Statusline configuration for nvim"""
   9  def build_sections(names)
  18    def setup(opts)  — - Configure the statusline.
  27    def theme()  — - Return the current theme name.
  31    def reload()
# read again with symbol="<name>" to see a function/class body, symbol="__preamble__" for imports/constants, or use `search` to locate something specific.
```

```
> read samples/statusline.lua symbol="M.setup"
# samples/statusline.lua::M.setup  lines 18-24 (method)
function M.setup(opts)
  opts = vim.tbl_deep_extend('force', defaults, opts or {})
  require('lualine').setup({
    options = { theme = opts.theme },
    sections = build_sections(opts.sections),
  })
end
```

## Rust

```
> read samples/widget.rs
# outline of samples/widget.rs (120 lines)
      """A widget renderer."""
   8  class Widget(struct)  — A renderable widget.
  13  class Widget(impl)
  24  class fmt::Display for Widget(impl)
  31  class Mode(enum)  — Widget rendering mode.
  33  class Render(trait)
  37  def render_all(widgets: &[Widget])
# read again with symbol="<name>" to see a function/class body, symbol="__preamble__" for imports/constants, or use `search` to locate something specific.
```

```
> read samples/widget.rs symbol="Widget"
# samples/widget.rs::Widget  lines 8-11 (class)
pub struct Widget {
    pub id: WidgetId,
    pub label: String,
}
```

## Go

```
> read samples/server.go
# outline of samples/server.go (120 lines)
      """Package server provides the HTTP entry point."""
  10  class Config(struct)  — Config bundles tunables.
  16  class Server(struct)  — Server wraps the listener.
  22  def New(cfg Config)  — New constructs a Server.
  27    def Start(ctx context.Context)  — Start begins listening.
  33    def Stop(ctx context.Context)  — Stop drains and shuts down.
# read again with symbol="<name>" to see a function/class body, symbol="__preamble__" for imports/constants, or use `search` to locate something specific.
```

```
> read samples/server.go symbol="Server.Start"
# samples/server.go::Server.Start  lines 27-30 (method)
func (s *Server) Start(ctx context.Context) error {
    s.srv = &http.Server{Addr: s.cfg.Addr}
    return s.srv.ListenAndServe()
}
```

## Shell

```
> read samples/deploy.sh
# outline of samples/deploy.sh (120 lines)
      """Deploy helpers used by CI"""
   7  def build_image()  — Build the docker image for the given tag.
  13  def push_image()  — Push the image to the registry.
  19  def deploy()  — Run the full deploy pipeline.
# read again with symbol="<name>" to see a function/class body, symbol="__preamble__" for imports/constants, or use `search` to locate something specific.
```

```
> read samples/deploy.sh symbol="deploy"
# samples/deploy.sh::deploy  lines 19-24 (function)
function deploy() {
    local tag="$1"
    build_image "$tag"
    push_image "$tag"
    kubectl set image deploy/myapp myapp="myapp:$tag"
}
```

## SQL

```
> read samples/schema.sql
# outline of samples/schema.sql (120 lines)
      """Customer-facing schema"""
   3  class users(table)  — Customer-facing schema
   9  class users_email_idx(index)
  11  class orders(table)
  18  class active_users(view)
  26  def user_total(function)
# read again with symbol="<name>" to see a function/class body, symbol="__preamble__" for imports/constants, or use `search` to locate something specific.
```

```
> read samples/schema.sql symbol="orders"
# samples/schema.sql::orders  lines 11-16 (class)
CREATE TABLE orders (
    id SERIAL PRIMARY KEY,
    user_id INT REFERENCES users(id),
    total NUMERIC(10, 2),
    placed_at TIMESTAMPTZ DEFAULT now()
);
```

## CSS

```
> read samples/theme.css
# outline of samples/theme.css (120 lines)
   3  :root
   8  body
  14  .btn, button.btn-primary
  21  .btn:hover
  26  @media (max-width: 768px)
  30  #site-header
# read again with symbol="<name>" to see a function/class body, symbol="__preamble__" for imports/constants, or use `search` to locate something specific.
```

```
> read samples/theme.css symbol=".btn:hover"
# samples/theme.css::.btn:hover  lines 21-24 (block)
.btn:hover {
  background: var(--primary);
  color: white;
}
```

## HTML

```
> read samples/article.html
# outline of samples/article.html (120 lines)
   7  #site-header(<header>)
   8  # My App — Release Notes
  11  #v0-2(<section>)
  12    ## v0.2 — 2026-05-01
  14      ### Breaking changes
  16      ### Bug fixes
  20  #v0-1(<section>)
  21    ## v0.1 — 2026-04-15
  25  #site-footer(<footer>)
# read again with symbol="<name>" to see a function/class body, symbol="__preamble__" for imports/constants, or use `search` to locate something specific.
```

## JSON

```
> read samples/package.json
# outline of samples/package.json (120 lines)
      """object (11 top-level keys)"""
   2  name: "my-app"
   3  version: "1.4.2"
   4  description: "A really cool app for doing app things really well"
   5  main: "dist/index.js"
   6  type: "module"
   7  scripts: object (4 keys)
  13  dependencies: object (3 keys)
  18  devDependencies: object (3 keys)
  23  engines: object (1 keys)
  26  private: true
  27  license: "MIT"
# read again with symbol="<name>" to see a function/class body, symbol="__preamble__" for imports/constants, or use `search` to locate something specific.
```

```
> read samples/package.json symbol="dependencies"
# samples/package.json::dependencies  lines 13-17 (block)
  "dependencies": {
    "express": "^4.19.0",
    "pg": "^8.11.0",
    "zod": "^3.22.0"
  },
```

## JSONL

```
> read samples/users.jsonl
# outline of samples/users.jsonl (200 lines)
       """200 records (sampled 50) — schema: id: number, name: string, email: string, active: boolean, score: number, premium: boolean, last_login: string"""
    1  head(first record)
    1  sample(first 5 records)
  200  tail(last record)
# read again with symbol="<name>" to see a function/class body, symbol="__preamble__" for imports/constants, or use `search` to locate something specific.
```

```
> read samples/users.jsonl symbol="head"
# samples/users.jsonl::head  lines 1-1 (block)
{"id":1,"name":"user-1","email":"u1@example.com","active":false,"score":0}
```

```
> read samples/users.jsonl symbol="sample"
# samples/users.jsonl::sample  lines 1-5 (block)
{"id":1,"name":"user-1","email":"u1@example.com","active":false,"score":0}
{"id":2,"name":"user-2","email":"u2@example.com","active":true,"score":13}
{"id":3,"name":"user-3","email":"u3@example.com","active":true,"score":26}
{"id":4,"name":"user-4","email":"u4@example.com","active":false,"score":39}
{"id":5,"name":"user-5","email":"u5@example.com","active":true,"score":52}
```

## CSV

```
> read samples/customers.csv
# outline of samples/customers.csv (201 lines)
     """200 rows × 5 cols (separator: comma)"""
  1  id(col 1)
  1  name(col 2)
  1  email(col 3)
  1  signup_date(col 4)
  1  plan(col 5)
# read again with symbol="<name>" to see a function/class body, symbol="__preamble__" for imports/constants, or use `search` to locate something specific.
```

## YAML

```
> read samples/ci.yml
# outline of samples/ci.yml (120 lines)
   2  name: ci
   3  on:
   9  env:
  13  jobs:
  32  permissions:
# read again with symbol="<name>" to see a function/class body, symbol="__preamble__" for imports/constants, or use `search` to locate something specific.
```

```
> read samples/ci.yml symbol="jobs"
# samples/ci.yml::jobs  lines 13-31 (block)
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npm ci
      - run: npm test

  build:
    runs-on: ubuntu-latest
    needs: test
    steps:
      - uses: actions/checkout@v4
      - run: npm ci
      - run: npm run build

```

## TOML

```
> read samples/pyproject.toml
# outline of samples/pyproject.toml (120 lines)
   3  # project[...]
   9  # project.dependencies[...]
  14  # tool.poetry[...]
  18  # tool.poetry.scripts[...]
  21  # tool.ruff[...]
  25  # tool.poetry.source[[...]]
  30  # build-system[...]
# read again with symbol="<name>" to see a function/class body, symbol="__preamble__" for imports/constants, or use `search` to locate something specific.
```

```
> read samples/pyproject.toml symbol="tool.poetry"
# samples/pyproject.toml::tool.poetry  lines 14-17 (heading)
[tool.poetry]
authors = ["Me <me@example.com>"]
readme = "README.md"

```

