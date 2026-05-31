#!/usr/bin/env python3
"""CLI for KultuNaut.dk -- Denmark's electronic cultural events guide.

KultuNaut is a Perl CGI application with no JSON API: every endpoint is a
``GET`` that returns HTML (the documented "RSS" feed redirects to an HTML
widget). This CLI fetches those pages and best-effort extracts a readable,
machine-friendly list of events; pass ``--raw`` to get the unparsed upstream
body instead. Parsing is defensive -- if the expected markup is not found, the
raw body is printed with a one-line note on stderr.

Subcommands:

- ``kultunaut events ...``  -- /perl/arrlist  (event calendar search)
- ``kultunaut event <n>``   -- /perl/arrmore  (single event detail)
- ``kultunaut films ...``   -- /perl/searchlist (cinema films now showing)
- ``kultunaut rss ...``     -- /perl/mini/type-rss (popular events feed)

Standard library only. See ./SKILL.md for the full endpoint reference.
"""

from __future__ import annotations

import argparse
import html
import json
import re
import sys
import typing as t
import urllib.error
import urllib.parse
import urllib.request
from html.parser import HTMLParser

BASE = "https://www.kultunaut.dk"

# KultuNaut pages are served as ISO-8859-1.
ENCODING = "iso-8859-1"

# A realistic browser UA -- the Perl backend is lenient, but mirror the sibling
# CLIs' habit of presenting a browser-ish agent.
UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 "
    "Safari/537.36 (kultunaut-dk-api-cli)"
)

# --lang code -> path segment inserted right after ``type-nynaut``.
# Per SKILL.md: language codes go between the type prefix and page name.
LANG_SEGMENT: dict[str, str] = {"da": "", "sv": "S", "uk": "UK", "de": "D"}


# ---------------------------------------------------------------------------
# Shared helpers
# ---------------------------------------------------------------------------


def _emit(obj: t.Any, raw: bool = False) -> None:
    """Print a JSON object; indented when ``raw`` is set, else compact."""
    if raw:
        print(json.dumps(obj, ensure_ascii=False, indent=2))
    else:
        print(json.dumps(obj, ensure_ascii=False))


def _type_path(page: str, lang: str) -> str:
    """Build a ``/perl/<page>/type-nynaut[/<LANG>]`` path.

    The language code (if any) is appended directly after ``type-nynaut``,
    e.g. ``/perl/arrlist/type-nynaut/UK``.
    """
    seg = LANG_SEGMENT.get(lang, "")
    base = f"/perl/{page}/type-nynaut"
    return f"{base}/{seg}" if seg else base


def _request(path: str, params: dict[str, str] | None = None) -> str:
    """GET a KultuNaut page and return its decoded body text.

    Args:
        path: Absolute URL or a ``/perl/...`` path.
        params: Optional query parameters.

    Exits with status 2 on an HTTP error, writing the reason to stderr.
    """
    url = path if path.startswith("http") else BASE + path
    if params:
        sep = "&" if "?" in url else "?"
        url += sep + urllib.parse.urlencode(params)
    req = urllib.request.Request(
        url, headers={"User-Agent": UA, "Accept": "text/html,application/xml"}
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.read().decode(ENCODING, errors="replace")
    except urllib.error.HTTPError as e:
        body = e.read() if e.fp else b""
        sys.stderr.write(f"HTTP {e.code} {e.reason} on GET {url}\n")
        if body:
            sys.stderr.write(
                body.decode(ENCODING, errors="replace").rstrip()[:500] + "\n"
            )
        sys.exit(2)
    except urllib.error.URLError as e:
        sys.stderr.write(f"Network error on GET {url}: {e.reason}\n")
        sys.exit(2)


def _clean(text: str) -> str:
    """Strip tags, unescape HTML entities, and collapse whitespace."""
    text = re.sub(r"<[^>]+>", " ", text)
    text = html.unescape(text)
    return re.sub(r"\s+", " ", text).strip()


# ---------------------------------------------------------------------------
# Event-list parsing (/perl/arrlist)
# ---------------------------------------------------------------------------


class _EventListParser(HTMLParser):
    """Extract event cards from an arrlist page.

    Each event is a ``<div data-arrnr="N" class="product ...">`` block holding
    a ``.genre_cat`` span (genre), an ``<h3><strong>`` (title), an
    ``.arr-description`` span, and a ``<time>...<b>venue</b></time>`` element.
    The parser is forgiving: missing fields are simply left blank.
    """

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.events: list[dict[str, str]] = []
        self._cur: dict[str, str] | None = None
        self._depth = 0  # div nesting depth inside the current product
        self._capture: str | None = None  # which field we are accumulating
        self._buf: list[str] = []

    def handle_starttag(
        self, tag: str, attrs: list[tuple[str, str | None]]
    ) -> None:
        a = dict(attrs)
        cls = a.get("class") or ""
        if tag == "div" and a.get("data-arrnr"):
            # Flush any in-progress card, then start a fresh one.
            self._finish()
            self._cur = {"arrnr": a["data-arrnr"] or ""}
            self._depth = 1
            return
        if self._cur is None:
            return
        if tag == "div":
            self._depth += 1
        if tag == "a" and "href" in a and "url" not in self._cur:
            href = a.get("href") or ""
            if "arrmore" in href:
                self._cur["url"] = href
        if tag == "span" and "genre_cat" in cls:
            self._begin("genre")
        elif tag == "h3":
            self._begin("title")
        elif tag == "time":
            self._begin("when")

    def handle_endtag(self, tag: str) -> None:
        if self._cur is None:
            return
        if tag in ("span", "h3", "time") and self._capture:
            self._flush_field()
        if tag == "div":
            self._depth -= 1
            if self._depth <= 0:
                self._finish()

    def handle_data(self, data: str) -> None:
        if self._capture:
            self._buf.append(data)

    def _begin(self, field: str) -> None:
        # Only capture the first occurrence of each field per card.
        if self._cur is not None and field not in self._cur:
            self._capture = field
            self._buf = []

    def _flush_field(self) -> None:
        if self._cur is None or not self._capture:
            return
        text = _clean("".join(self._buf))
        self._cur[self._capture] = text
        self._capture = None
        self._buf = []

    def _finish(self) -> None:
        if self._cur is not None and (
            self._cur.get("title") or self._cur.get("arrnr")
        ):
            self.events.append(self._cur)
        self._cur = None
        self._capture = None
        self._buf = []
        self._depth = 0

    def close(self) -> None:  # noqa: D102
        super().close()
        self._finish()


def _split_when(when: str) -> tuple[str, str]:
    """Split a ``<time>`` string like 'Søn. 31. maj 2026, Byens Hus' into
    (datetime, venue) on the last comma. Returns ('', when) if no comma."""
    if "," in when:
        dt, venue = when.rsplit(",", 1)
        return dt.strip(), venue.strip()
    return when.strip(), ""


def _parse_events(body: str) -> list[dict[str, str]]:
    """Parse an arrlist page into a list of event dicts."""
    p = _EventListParser()
    p.feed(body)
    p.close()
    out: list[dict[str, str]] = []
    for ev in p.events:
        dt, venue = _split_when(ev.get("when", ""))
        url = ev.get("url", "")
        if url and not url.startswith("http"):
            url = BASE + url
        out.append(
            {
                "arrnr": ev.get("arrnr", ""),
                "title": ev.get("title", ""),
                "genre": ev.get("genre", ""),
                "datetime": dt,
                "venue": venue,
                "url": url
                or (
                    f"{BASE}/perl/arrmore/type-nynaut?ArrNr={ev['arrnr']}"
                    if ev.get("arrnr")
                    else ""
                ),
            }
        )
    return out


# ---------------------------------------------------------------------------
# Subcommands
# ---------------------------------------------------------------------------


def cmd_events(args: argparse.Namespace) -> None:
    """Search the event calendar (/perl/arrlist)."""
    params: dict[str, str] = {}
    if args.area:
        params["Area"] = args.area
    if args.periode:
        params["periode"] = args.periode
    if args.genre:
        params["Genre"] = args.genre
    if args.order:
        params["Order"] = args.order
    body = _request(_type_path("arrlist", args.lang), params)
    if args.raw:
        print(body)
        return
    events = _parse_events(body)
    if not events:
        sys.stderr.write(
            "No events parsed from the page; printing raw HTML. "
            "Re-run with --raw to suppress this note.\n"
        )
        print(body)
        return
    _emit(events)


def cmd_event(args: argparse.Namespace) -> None:
    """Fetch a single event's detail page (/perl/arrmore?ArrNr=N)."""
    body = _request(
        _type_path("arrmore", args.lang), {"ArrNr": str(args.arrnr)}
    )
    if args.raw:
        print(body)
        return
    detail = _parse_event_detail(body)
    if not detail.get("title"):
        sys.stderr.write(
            "Could not parse event detail; printing raw HTML. "
            "Re-run with --raw to suppress this note.\n"
        )
        print(body)
        return
    detail["arrnr"] = str(args.arrnr)
    detail["url"] = f"{BASE}/perl/arrmore/type-nynaut?ArrNr={args.arrnr}"
    _emit(detail)


def _parse_event_detail(body: str) -> dict[str, str]:
    """Best-effort extraction of title/description from an arrmore page.

    The ``<title>`` tag carries the event name + venue (e.g. "Last Sunday
    Skakturnering, Byens Hus - Find det på KultuNaut"); we strip the trailing
    site suffix. A non-empty ``og:title`` is preferred when present.
    """
    detail: dict[str, str] = {}
    title = ""
    m = re.search(
        r'<meta[^>]+property="og:title"[^>]+content="([^"]*)"', body
    )
    if m and _clean(m.group(1)):
        title = _clean(m.group(1))
    if not title:
        m = re.search(r"<title[^>]*>(.*?)</title>", body, re.S | re.I)
        if m:
            title = _clean(m.group(1))
            # Drop the " - Find det på KultuNaut" style suffix.
            title = re.split(r"\s*[-–]\s*Find det", title)[0].strip()
    if title:
        detail["title"] = title
    for prop in ('property="og:description"', 'name="description"'):
        md = re.search(
            rf"<meta[^>]+{prop}[^>]+content=\"([^\"]*)\"", body
        )
        if md and _clean(md.group(1)):
            detail["description"] = _clean(md.group(1))
            break
    return detail


# Film result links carry the title in DefaultTitel and the cinema/series id
# in DefaultStedNr.
_FILM_LINK_RE = re.compile(
    r"(?:href|window\.open\()\s*=?\s*['\"]"
    r"https://www\.kultunaut\.dk/perl/searchlist/type-nynaut[^'\"]*"
    r"DefaultStedNr=(\d+)[^'\"]*DefaultTitel=([^'\"&]+)",
)


def cmd_films(args: argparse.Namespace) -> None:
    """List cinema films now showing (/perl/searchlist, Genre=Film)."""
    params: dict[str, str] = {"Genre": "Film", "Area": args.area or ""}
    if args.periode:
        params["periode"] = args.periode
    body = _request(_type_path("searchlist", args.lang), params)
    if args.raw:
        print(body)
        return
    seen: set[str] = set()
    films: list[dict[str, str]] = []
    for sted, titel in _FILM_LINK_RE.findall(body):
        title = _clean(
            html.unescape(urllib.parse.unquote(titel, encoding=ENCODING))
        )
        key = title.lower()
        if not title or key in seen:
            continue
        seen.add(key)
        films.append({"title": title, "stednr": sted})
    if not films:
        sys.stderr.write(
            "No films parsed from the page; printing raw HTML. "
            "Re-run with --raw to suppress this note.\n"
        )
        print(body)
        return
    _emit(films)


def cmd_rss(args: argparse.Namespace) -> None:
    """Fetch the popular-events feed (/perl/mini/type-rss).

    The endpoint is documented as RSS but currently redirects to an HTML
    widget. We try true RSS ``<item>`` parsing first and fall back to the
    arrlist event parser, then to the raw body.
    """
    params: dict[str, str] = {}
    if args.order:
        params["Order"] = args.order
    if args.periode:
        params["periode"] = args.periode
    # mini/type-rss has no language code segment (it is not a type-nynaut page).
    body = _request("/perl/mini/type-rss", params)
    if args.raw:
        print(body)
        return
    items = _parse_rss(body)
    if items:
        _emit(items)
        return
    # Fall back to event-card parsing (the widget reuses arrlist markup).
    events = _parse_events(body)
    if events:
        _emit(events)
        return
    sys.stderr.write(
        "Feed contained no <item> elements or event cards; printing raw body. "
        "Re-run with --raw to suppress this note.\n"
    )
    print(body)


def _parse_rss(body: str) -> list[dict[str, str]]:
    """Parse RSS ``<item>`` elements (title/link/description), if present."""
    items: list[dict[str, str]] = []
    for chunk in re.findall(r"<item\b[^>]*>(.*?)</item>", body, re.S | re.I):

        def field(name: str) -> str:
            m = re.search(
                rf"<{name}\b[^>]*>(.*?)</{name}>", chunk, re.S | re.I
            )
            return _clean(m.group(1)) if m else ""

        title = field("title")
        if not title:
            continue
        items.append(
            {
                "title": title,
                "link": field("link"),
                "description": field("description"),
            }
        )
    return items


# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------


def _add_global(p: argparse.ArgumentParser) -> None:
    """Add the ``--raw`` and ``--lang`` options shared by every subcommand."""
    p.add_argument(
        "--raw",
        action="store_true",
        help="print the raw upstream HTML/XML instead of parsed JSON",
    )
    p.add_argument(
        "--lang",
        choices=["da", "sv", "uk", "de"],
        default="da",
        help="page language (da=Danish default, sv=Swedish, uk=English, "
        "de=German); inserts the code after type-nynaut",
    )


def main() -> None:
    """Entry point: parse arguments and dispatch to the selected command."""
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("events", help="search the event calendar (arrlist)")
    p.add_argument(
        "--area",
        help='geography filter, e.g. "8000 Aarhus C", '
        '"Region Hovedstaden", "Hele Danmark"',
    )
    p.add_argument(
        "--periode", help="time period, e.g. 1=today, 30=upcoming month"
    )
    p.add_argument(
        "--genre", help="event genre, e.g. Musik, Jazz, Udstilling"
    )
    p.add_argument("--order", help='sort, e.g. "Rating" for most popular')
    _add_global(p)
    p.set_defaults(func=cmd_events)

    p = sub.add_parser("event", help="fetch a single event's detail (arrmore)")
    p.add_argument("arrnr", help="event number (ArrNr), e.g. 19896575")
    _add_global(p)
    p.set_defaults(func=cmd_event)

    p = sub.add_parser("films", help="cinema films now showing (searchlist)")
    p.add_argument("--area", help="geography filter (blank = all of Denmark)")
    p.add_argument("--periode", help="time period, e.g. 1=today")
    _add_global(p)
    p.set_defaults(func=cmd_films)

    p = sub.add_parser("rss", help="popular-events feed (mini/type-rss)")
    p.add_argument("--order", help='sort, e.g. "Rating" for most popular')
    p.add_argument("--periode", help="time period")
    _add_global(p)
    p.set_defaults(func=cmd_rss)

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
