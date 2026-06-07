---
name: recipes
description: CLI for Valdemarsro.dk recipes — search and view Danish recipes
tagline: Search and view Danish recipes from valdemarsro.dk
last-updated: 2026-06-07
---

# recipes-dk

## What

CLI wrapper for **Valdemarsro.dk** recipes, Denmark's popular recipe site. Search for
recipes by keyword and view full recipe details including ingredients, instructions, and
nutrition info. Defaults to vegetarian meals only.

## Usage

```bash
recipes <command> [options]
```

### Prerequisites

```bash
cd /Users/dansmart/.pi/agent/skills/recipes
uv pip install -e .   # Install CLI with dependencies (beautifulsoup4)
```

Standard library + BeautifulSoup4 only. All commands support `--json` for
machine-readable output.

## Commands

| Command                          | What it does                               |
| -------------------------------- | ------------------------------------------ |
| `recipes search QUERY [filters]` | Search with filters (veggie on by default) |
| `recipes view URL`               | View a single recipe with full details     |

### Search

```bash
# Search vegetarian recipes (default)
recipes search "curry"

# Search all recipes (disable veggie filter)
recipes search "pasta" --no-veggie

# Filter by cooking time (under 20 min)
recipes search "salat" --time 0_20

# Combine filters: asian + vegan + under 30 min
recipes search "wok" --theme asian --vegan --time 21_30

# Search for Christmas desserts
recipes search "kage" --season christmas --meal-type dessert

# JSON output
recipes search "pasta" --json
```

### Available filters

**Dietary:**

- `--vegan` — Vegan recipes
- `--no-veggie` — Disable default vegetarian filter

**Meal type** (`--meal-type`): `dinner`, `breakfast`, `lunch`, `dessert`, `snack`,
`starter`, `cocktail`, ...

**Season** (`--season`): `spring`, `summer`, `autumn`, `winter`, `christmas`, `easter`,
`halloween`, ...

**Time** (`--time`): `0_20` (0-20 min), `21_30`, `31_45`, `45_plus`

**Theme** (`--theme`): `asian`, `indian`, `mexican`, `pasta`, `pizza`, `soup`, `grill`,
`seafood`, ...

Filters can be combined and are passed to Valdemarsro.dk's built-in search API.

### View

```bash
# View a recipe by full URL
recipes view https://www.valdemarsro.dk/halloumi-curry/

# View by path (base URL added automatically)
recipes view /halloumi-curry/

# JSON output
recipes view https://www.valdemarsro.dk/halloumi-curry/ --json
```

## Output format

### Human-readable (default)

Search/list output:

```
Vegetarian recipes:

1. Halloumi Curry
   https://www.valdemarsro.dk/halloumi-curry/

2. Vegetarisk Lasagnesuppe
   https://www.valdemarsro.dk/vegetarisk-lasagnesuppe/
```

View output:

```
============================================================
Halloumi Curry
============================================================

Lækker cremet curry med stegt halloumi...

INGREDIENTS
----------------------------------------
  • 2 pakker halloumi
  • 1 løg
  • 2 fed hvidløg
  ...

INSTRUCTIONS
----------------------------------------
  1. Skær halloumi i tern
  2. Svits løg og hvidløg
  ...

TIPS
----------------------------------------
  • Serveres gerne med ris eller naanbrød

NUTRITION
----------------------------------------
  Energi: 450 kcal
  Protein: 25 g
  ...

Source: https://www.valdemarsro.dk/halloumi-curry/
```

### JSON (`--json`)

Search/list JSON:

```json
[
  {
    "title": "Halloumi Curry",
    "url": "https://www.valdemarsro.dk/halloumi-curry/"
  }
]
```

View JSON:

```json
{
  "title": "Halloumi Curry",
  "description": "Lækker cremet curry...",
  "ingredients": ["2 pakker halloumi", "..."],
  "instructions": ["Skær halloumi i tern", "..."],
  "nutrition": { "Energi": "450 kcal", "...": "..." },
  "tips": ["Serveres gerne med ris..."],
  "servings": null,
  "time": null
}
```

## Gotchas

- **Vegetarian default:** Search and list default to vegetarian-only mode. Use `--all`
  to include meat and fish recipes.
- **Site scraping:** This CLI scrapes the public Valdemarsro.dk website. If the site
  structure changes, parsing may break.
- **Rate limiting:** Be respectful — don't hammer the site. The CLI is intended for
  interactive use, not bulk scraping.
- **Danish content:** All recipes are in Danish. The CLI does not translate.
- **Premium recipes:** Some recipes may be marked as "Premium" and require a
  subscription on the website — the CLI can still fetch them if they're publicly
  accessible.

## Implementation notes

### How it works

The CLI uses Python's standard library (`urllib`, `html.parser`) plus BeautifulSoup4 for
HTML parsing. No official API exists — this reverse-engineers the public HTML structure.

### How filters work

The CLI uses Valdemarsro.dk's built-in search API at `/soeg/` with filter term IDs.
Filters are combined using comma-separated term IDs (e.g. `terms=3745,duration_0,3821`
for vegetarian + under 20 min + Asian).

The vegetarian filter (`--veggie`) is enabled by default. Disable it with `--no-veggie`
to search all recipes including meat and fish.

## Testing

Test the CLI:

```bash
cd /Users/dansmart/.pi/agent/skills/recipes

# Install dependencies
uv pip install -e .

# Test vegetarian search
uv run recipes search "curry"

# Test vegetarian list
uv run recipes veggie

# Test view (known recipe)
uv run recipes view https://www.valdemarsro.dk/halloumi-curry/

# Test JSON output
uv run recipes search "pasta" --json | head -20
```

## Related

- [bolig-dk](../bolig-dk/) — Another Danish site CLI (housing listings)
- [citizen-dk](../citizen-dk/) — Danish citizen services CLI
- [dmi-dk](../dmi-dk/) — Danish weather CLI
