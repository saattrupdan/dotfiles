# KultuNaut.dk

Agent skill for interacting with **KultuNaut.dk** — Denmark's electronic cultural guide.

## What It Is

KultuNaut is a centralized Danish cultural calendar covering:
- Music concerts (jazz, classical, rock/pop, folk, etc.)
- Theater (ballet, dance, musical, opera, comedy, children's theater)
- Exhibitions (art, architecture, photography, historical, sculpture)
- Sports competitions (football, handball, ice hockey, cycling, golf)
- Fitness classes and activities
- Cinema films
- Adult education courses
- Community activities (scouts, chess, dogs, literature, crafts)
- Online events and webinars

## CLI

All interaction goes through the `kultunaut` CLI — standard library only, no
extra dependencies. KultuNaut has no JSON API, so the CLI scrapes the Perl CGI
HTML pages and emits compact JSON; pass `--raw` for the unparsed body.

```bash
pipx install -e .          # from this skill directory
```

```bash
kultunaut events --area "8000 Aarhus C" --periode 1   # event calendar
kultunaut event 19896575                              # one event's detail
kultunaut films --periode 1                           # cinema films now showing
kultunaut rss --order Rating                          # popular-events feed
```

Every command accepts `--raw` (raw upstream HTML/XML) and
`--lang {da,sv,uk,de}` (Danish default, Swedish, English, German).

## Files

- `SKILL.md` — Complete reference with endpoints, parameters, and navigation guide.
- `kultunaut_dk/main.py` — the `kultunaut` CLI implementation.
