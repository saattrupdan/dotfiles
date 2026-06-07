#!/usr/bin/env python3
"""CLI for Valdemarsro.dk recipes.

Search and view Danish recipes from valdemarsro.dk. Defaults to vegetarian
recipes only.

Commands:
    recipes search QUERY   — Search for recipes by keyword (veggie by default)
    recipes view URL       — View a single recipe by URL
"""

from __future__ import annotations

import argparse
import collections.abc as c
import html
import json
import sys
import typing as t
import urllib.error
import urllib.parse
import urllib.request
from bs4 import BeautifulSoup

BASE_URL = "https://www.valdemarsro.dk"
SEARCH_URL = f"{BASE_URL}/soeg/"

# Filter term IDs from Valdemarsro.dk
FILTERS = {
    # Dietary
    "veggie": "3745",
    "vegan": "100500",
    "freezable": "100100",
    # Meal types
    "dinner": "3705",
    "side": "3706",
    "bread": "3716",
    "breakfast": "3709",
    "lunch": "3710",
    "lunchbox": "3713",
    "drinks": "3714",
    "cakes": "3717",
    "dessert": "3708",
    "sweets": "3740",
    "tea": "3711",
    "snack": "3712",
    "cocktail": "3715",
    "starter": "3707",
    # Seasons
    "spring": "3721",
    "summer": "3722",
    "autumn": "3723",
    "winter": "3724",
    "party": "3766",
    "christmas": "3726",
    "newyear": "3727",
    "easter": "3729",
    "halloween": "3730",
    "fastelavn": "3728",
    # Time (duration)
    "time_0_20": "duration_0",
    "time_21_30": "duration_21",
    "time_31_45": "duration_31",
    "time_45_plus": "duration_45",
    # Themes
    "asian": "3821",
    "indian": "3822",
    "middle_eastern": "3823",
    "mexican": "3824",
    "family": "3836",
    "seafood": "3827",
    "grill": "3835",
    "pie": "3833",
    "pasta": "3828",
    "pizza": "3829",
    "salad": "3830",
    "slowcook": "3831",
    "soup": "3832",
    "sandwich": "4333",
    "appetizer": "4336",
    "budget": "4224",
    "leftovers": "3970",
    "icecream": "4007",
}

UA = "Mozilla/5.0 (recipes-dk-cli)"


def fetch_page(url: str) -> str:
    """Fetch a page and return its HTML content."""
    req = urllib.request.Request(
        url,
        headers={"User-Agent": UA},
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as response:
            return response.read().decode("utf-8")
    except urllib.error.HTTPError as e:
        print(f"Error: HTTP {e.code} fetching {url}", file=sys.stderr)
        sys.exit(1)
    except urllib.error.URLError as e:
        print(f"Error: Failed to fetch {url}: {e.reason}", file=sys.stderr)
        sys.exit(1)


def parse_recipe_links(soup: BeautifulSoup, limit: int | None = None) -> list[dict]:
    """Extract recipe links from a listing page."""
    recipes = []
    seen_urls = set()

    # Strategy 1: Check for div.gallery-item (used on some category pages)
    for gallery_item in soup.find_all("div", class_="gallery-item"):
        link = gallery_item.find("a", href=True)
        if link:
            href = link.get("href", "")
            if href.startswith("https://www.valdemarsro.dk/") and href not in seen_urls:
                seen_urls.add(href)
                title = link.get_text(strip=True)
                if title and len(title) > 5:
                    recipes.append({
                        "title": html.unescape(title),
                        "url": href,
                    })
                    if limit and len(recipes) >= limit:
                        return recipes

    # Strategy 2: Check for div.post-list-item (used on search results)
    if not recipes:
        for post_item in soup.find_all("div", class_="post-list-item"):
            link = post_item.find("a", href=True)
            title_span = post_item.find("span", class_="post-list-item-title")
            if link and title_span:
                href = link.get("href", "")
                title = title_span.get_text(strip=True)
                if (href.startswith("https://www.valdemarsro.dk/") and 
                    href.count("/") == 4 and 
                    "/tag/" not in href and
                    href not in seen_urls):
                    seen_urls.add(href)
                    if title and len(title) > 5:
                        recipes.append({
                            "title": html.unescape(title),
                            "url": href,
                        })
                        if limit and len(recipes) >= limit:
                            return recipes

    # Strategy 3: Check for div.swiper (used on main recipe page)
    if not recipes:
        for swiper in soup.find_all("div", class_="swiper"):
            for link in swiper.find_all("a", href=True):
                href = link.get("href", "")
                # Only accept individual recipe pages: 4 slashes in full URL
                # (https: + www.valdemarsro.dk + slug + /), exclude tag/category pages
                skip_category_urls = [
                    "/nem-hverdagsmad", "/mad-budget", "/hverdagsfavoritter",
                    "/familiefavoritter", "/simremad", "/tilbehoer", "/fisk-",
                    "/salat", "/dip-", "/asiatisk", "/indisk", "/mellemoestens",
                    "/mexicansk", "/graesk", "/spansk", "/italiensk", "/fransk",
                    "/efter", "/bagning", "/broed", "/kage", "/dessert", "/is",
                    "/saft", "/smoothie", "/chokolade", "/karamel", "/kiks",
                    "/knas", "/kranse", "/lakrids", "/marengs", "/noedde",
                    "/ost", "/pandekage", "/sauce", "/scones", "/sukker",
                    "/vafler", "/sylte", "/smoer", "/forret", "/festmad",
                    "/cocktail", "/grill", "/buffet", "/konfekt", "/slik",
                    "/lagkage", "/opskrifter", "/vegetar", "/ovnretter",
                    "/madtaerter", "/p", "madpandekager", "brunch", "billeder",
                    "/afternoon", "/cupcakes", "/natmad", "/aftensmad", "/madpakke"
                ]
                if (href.startswith("https://www.valdemarsro.dk/") and 
                    href.count("/") == 4 and 
                    "/tag/" not in href and
                    not any(x in href.lower() for x in skip_category_urls) and
                    href not in seen_urls):
                    seen_urls.add(href)
                    title = link.get_text(strip=True)
                    # Skip obvious category pages by title
                    if title and len(title) > 5:
                        title_lower = title.lower()
                        # Skip generic category titles
                        skip_patterns = [
                            " opskrifter", " retter", " mad", " kager", " desserter",
                            "- opskrifter", " på budget", "favoritter", "madtærter",
                            "madpandekager", "morgen", "brunch", "bagning", "kage",
                            "is ", "saft", "smoothie", "chokolad", "karamel", "kiks",
                            "knas", "kranse", "lakrids", "marengs", "nødde", "ost",
                            "pandekage", "sauce", "scones", "sukker", "vafler",
                            "syltet", "smøb", "forret", "fest", "cocktail", "appetizer",
                            "grill ", "buffet", "konfekt", "slik", "lagkage"
                        ]
                        if any(p in title_lower for p in skip_patterns):
                            continue
                        recipes.append({
                            "title": html.unescape(title),
                            "url": href,
                        })
                        if limit and len(recipes) >= limit:
                            return recipes

    return recipes


def parse_recipe_detail(soup: BeautifulSoup) -> dict:
    """Parse a single recipe page."""
    recipe = {
        "title": "",
        "description": "",
        "ingredients": [],
        "instructions": [],
        "nutrition": {},
        "tips": [],
        "servings": None,
        "time": None,
    }

    # Title - look for h1 or h2 with print-hide class
    title_el = soup.find("h1") or soup.find("h2")
    if title_el:
        recipe["title"] = html.unescape(title_el.get_text(strip=True))

    # Description - look for intro paragraph
    for p in soup.find_all("p"):
        text = p.get_text(strip=True)
        if text and len(text) > 20 and len(text) < 300:
            recipe["description"] = html.unescape(text)
            break

    # Ingredients - Valdemarsro uses div.subtitle followed by ul.ingredientlist
    for subtitle in soup.find_all("div", class_="subtitle"):
        if "Ingredienser" in subtitle.get_text():
            ul = subtitle.find_next_sibling("ul", class_="ingredientlist")
            if not ul:
                ul = subtitle.find_next("ul", class_="ingredientlist")
            if ul:
                for li in ul.find_all("li"):
                    text = li.get_text(strip=True)
                    if text:
                        recipe["ingredients"].append(html.unescape(text))
            break

    # Instructions - div.subtitle followed by div with recipeInstructions
    for subtitle in soup.find_all("div", class_="subtitle"):
        if "Fremgangsmåde" in subtitle.get_text():
            instr_div = subtitle.find_next_sibling("div", class_=True)
            if not instr_div:
                instr_div = subtitle.find_next("div", itemprop="recipeInstructions")
            if instr_div:
                # Extract paragraphs as steps
                for p in instr_div.find_all("p"):
                    text = p.get_text(strip=True)
                    if text:
                        recipe["instructions"].append(html.unescape(text))
                # If no paragraphs, try list items
                if not recipe["instructions"]:
                    for li in instr_div.find_all("li"):
                        text = li.get_text(strip=True)
                        if text:
                            recipe["instructions"].append(html.unescape(text))
            break

    # Nutrition info - look for table after Næringsindhold subtitle
    for subtitle in soup.find_all("div", class_="subtitle"):
        if "Næringsindhold" in subtitle.get_text():
            table = subtitle.find_next("table")
            if table:
                for row in table.find_all("tr"):
                    cells = row.find_all("td")
                    if len(cells) >= 2:
                        key = cells[0].get_text(strip=True)
                        value = cells[1].get_text(strip=True)
                        if key and value:
                            recipe["nutrition"][html.unescape(key)] = html.unescape(value)
            break

    # Tips - look for UL after "Tip til opskriften"
    for subtitle in soup.find_all("div", class_="subtitle"):
        if "Tip" in subtitle.get_text():
            ul = subtitle.find_next("ul")
            if ul:
                for li in ul.find_all("li"):
                    text = li.get_text(strip=True)
                    if text:
                        recipe["tips"].append(html.unescape(text))
            break

    return recipe


def search_recipes(
    query: str,
    filters: list[str] | None = None,
    limit: int = 20,
) -> list[dict]:
    """Search for recipes by keyword with optional filters.
    
    Args:
        query:
            Search query (keyword).
        filters:
            List of filter names (e.g. ['veggie', 'asian', 'time_0_20']).
            See FILTERS dict for available options.
        limit:
            Max number of results to return.
    
    Returns:
        List of recipe dicts with 'title' and 'url' keys.
    """
    # Build terms parameter from filter names
    terms = []
    if filters:
        for f in filters:
            if f in FILTERS:
                terms.append(FILTERS[f])
    
    # Build URL
    if terms:
        terms_str = ",".join(terms)
        search_url = f"{SEARCH_URL}?terms={terms_str}&q={urllib.parse.quote(query)}"
    else:
        search_url = f"{SEARCH_URL}?q={urllib.parse.quote(query)}"
    
    html_content = fetch_page(search_url)
    soup = BeautifulSoup(html_content, "html.parser")
    return parse_recipe_links(soup, limit=limit)


def view_recipe(url: str) -> dict:
    """View a single recipe."""
    if not url.startswith("http"):
        url = f"{BASE_URL}{url}"
    html_content = fetch_page(url)
    soup = BeautifulSoup(html_content, "html.parser")
    return parse_recipe_detail(soup)


def cmd_search(args: argparse.Namespace) -> None:
    """Handle the search command."""
    # Collect filters from args
    filters = list(args.filters) if args.filters else []
    
    # Remove veggie if --no-veggie is set
    if args.no_veggie and "veggie" in filters:
        filters.remove("veggie")
    
    # Add additional filters
    if args.vegan:
        filters.extend(args.vegan)
    if args.meal_type:
        filters.extend(args.meal_type)
    if args.season:
        filters.extend(args.season)
    if args.time:
        # Convert time arg to filter key
        filters.append(f"time_{args.time}")
    if args.theme:
        filters.extend(args.theme)
    
    recipes = search_recipes(
        query=args.query,
        filters=filters,
        limit=args.limit,
    )

    if args.json:
        print(json.dumps(recipes, indent=2, ensure_ascii=False))
    else:
        if not recipes:
            print("No recipes found.")
            return

        prefix = f"[Filters: {', '.join(filters)}] " if filters else ""
        print(f"{prefix}Found {len(recipes)} recipes:\n")

        for i, recipe in enumerate(recipes, 1):
            print(f"{i}. {recipe['title']}")
            print(f"   {recipe['url']}\n")


def cmd_view(args: argparse.Namespace) -> None:
    """Handle the view command."""
    recipe = view_recipe(args.url)

    if args.json:
        print(json.dumps(recipe, indent=2, ensure_ascii=False))
    else:
        print(f"\n{'=' * 60}")
        print(f"{recipe['title']}")
        print(f"{'=' * 60}\n")

        if recipe["description"]:
            print(f"{recipe['description']}\n")

        if recipe.get("servings"):
            print(f"Servings: {recipe['servings']}")
        if recipe.get("time"):
            print(f"Time: {recipe['time']}")
        print()

        if recipe["ingredients"]:
            print("INGREDIENTS")
            print("-" * 40)
            for ing in recipe["ingredients"]:
                print(f"  • {ing}")
            print()

        if recipe["instructions"]:
            print("INSTRUCTIONS")
            print("-" * 40)
            for i, step in enumerate(recipe["instructions"], 1):
                print(f"  {i}. {step}")
            print()

        if recipe["tips"]:
            print("TIPS")
            print("-" * 40)
            for tip in recipe["tips"]:
                print(f"  • {tip}")
            print()

        if recipe["nutrition"]:
            print("NUTRITION")
            print("-" * 40)
            for key, value in recipe["nutrition"].items():
                print(f"  {key}: {value}")
            print()

        print(f"Source: {args.url}\n")


def main() -> None:
    """Main entry point."""
    parser = argparse.ArgumentParser(
        prog="recipes",
        description="CLI for Valdemarsro.dk recipes",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="Output in JSON format",
    )
    parser.add_argument(
        "-n",
        "--limit",
        type=int,
        default=20,
        help="Number of recipes to show (default: 20)",
    )

    subparsers = parser.add_subparsers(dest="command", required=True)

    # Search command
    search_parser = subparsers.add_parser(
        "search",
        help="Search for recipes with optional filters",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        description="""Search Valdemarsro.dk recipes.
        
Filter options (can be combined):
  Dietary:      --vegan, --veggie (default), --no-veggie
  Meal type:    --meal-type dinner|breakfast|lunch|dessert|snack|...
  Season:       --season summer|winter|christmas|easter|...
  Time:         --time 0_20|21_30|31_45|45_plus (minutes)
  Theme:        --theme asian|indian|italian|pasta|soup|grill|...

Example:
  recipes search "pasta" --time 0_20 --theme italian --veggie
""",
    )
    search_parser.add_argument("query", help="Search query (keyword)")
    search_parser.add_argument(
        "--json",
        action="store_true",
        help="Output in JSON format",
    )
    search_parser.add_argument(
        "-n",
        "--limit",
        type=int,
        default=20,
        help="Number of recipes to show (default: 20)",
    )
    # Dietary filters
    search_parser.add_argument(
        "--vegan",
        action="append_const",
        const="vegan",
        dest="filters",
        help="Vegan recipes only",
    )
    search_parser.add_argument(
        "--no-veggie",
        action="store_true",
        help="Disable default vegetarian filter",
    )
    # Meal type (can specify multiple)
    search_parser.add_argument(
        "--meal-type",
        action="append",
        choices=["dinner", "side", "bread", "breakfast", "lunch", "lunchbox",
                 "drinks", "cakes", "dessert", "sweets", "tea", "snack",
                 "cocktail", "starter"],
        help="Filter by meal type (can be repeated)",
    )
    # Season (can specify multiple)
    search_parser.add_argument(
        "--season",
        action="append",
        choices=["spring", "summer", "autumn", "winter", "party",
                 "christmas", "newyear", "easter", "halloween", "fastelavn"],
        help="Filter by season/occasion (can be repeated)",
    )
    # Time (single choice)
    search_parser.add_argument(
        "--time",
        choices=["0_20", "21_30", "31_45", "45_plus"],
        help="Filter by cooking time in minutes",
    )
    # Theme (can specify multiple)
    search_parser.add_argument(
        "--theme",
        action="append",
        choices=["asian", "indian", "middle_eastern", "mexican", "family",
                 "seafood", "grill", "pie", "pasta", "pizza", "salad",
                 "slowcook", "soup", "sandwich", "appetizer", "budget",
                 "leftovers", "icecream"],
        help="Filter by theme/cuisine (can be repeated)",
    )
    search_parser.set_defaults(
        func=cmd_search,
        filters=["veggie"],
        vegan=None,
        meal_type=None,
        season=None,
        time=None,
        theme=None,
    )

    # View command
    view_parser = subparsers.add_parser("view", help="View a single recipe")
    view_parser.add_argument(
        "--json",
        action="store_true",
        help="Output in JSON format",
    )
    view_parser.add_argument("url", help="Recipe URL or path")
    view_parser.set_defaults(func=cmd_view)

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
