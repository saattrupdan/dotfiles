---
name: tv2-dk
description: TV 2 Denmark — browse news, articles, sports, weather, TV schedules, and streaming on tv2.dk and its subdomains. Extract article lists via the internal decks API. Use when researching Danish news, sports, weather, or TV content.
last-updated: 2026-05-09
---

# tv2.dk — Danish commercial broadcaster

Denmark's largest commercial broadcaster and news portal. Five subdomains cover different content. All content in Danish. No paywall for news; some Play content requires TV 2 Login.

## Subdomains

| Subdomain | Purpose |
|---|---|
| **tv2.dk** | Front page / aggregator |
| **nyheder.tv2.dk** | News — politics, crime, society, international, business |
| **sport.tv2.dk** | Sports news, live scores, schedules |
| **vejr.tv2.dk** | Weather forecasts, radar, warnings |
| **tv.tv2.dk** | TV programs, schedules, episodes |
| **play.tv2.dk** | Streaming — on-demand series, documentaries, live TV |

## Article URLs

Pattern: `https://{nyheder|sport}.tv2.dk/YYYY-MM-DD-slug`
Example: `https://nyheder.tv2.dk/2026-05-08-navn-pa-artikel`
Dates use hyphens; slugs are Danish headlines with special chars removed.

Short-form videos (reels) are at `https://tv2.dk/nyheder/reels` and `https://tv2.dk/sport/reels`.

## Mit TV 2 — user accounts

Login: `https://mit.tv2.dk/?login` · Signup: `https://mit.tv2.dk/?signup`

Required for: personalized recommendations, saved content, comments, some Play content. Anonymous browsing works for all news and free content.

## Common tasks

- Latest news: `https://nyheder.tv2.dk/seneste`
- Category news: `https://nyheder.tv2.dk/politik`, `…/krimi`, `…/udland`, etc.
- Specific article: construct URL from slug found via search or section listing
- Watch video: navigate to article page; Brightcove player auto-loads
- Weather: `https://vejr.tv2.dk/`
- TV schedules: `https://tv.tv2.dk/`
- Stream content: `https://play.tv2.dk/`
- Live sports scores: `https://sport.tv2.dk/livescore-og-resultater`
- Cycling coverage: `https://sport.tv2.dk/cykling`
- Submit a tip: "Tip os" page on tv2.dk

## Internal APIs

Endpoints are undocumented, unsupported, and may change without notice. Prefer the website UI.

### Decks API — `https://decks.services.tv2.dk/`

Returns HTML fragments (not JSON) representing content cards used throughout the site — the primary programmatic interface for fetching article lists.

```
GET https://decks.services.tv2.dk/deck/<deck-type>?site=<site>&[other-params]
```

| Deck type | Params | Returns |
|---|---|---|
| `cross_promo_site` | `site=nyheder`, `section=<section>` | "Mest sete" / "Seneste" teasers |
| `cross_promo_tv2dk` | — | Cross-promotion teasers on tv2.dk |
| `play_deck` | `site=nyheder`, `title`, `titleLink`, `ctaButtonUrl` | TV 2 Play promoted content |

**Example:**
```
GET https://decks.services.tv2.dk/deck/cross_promo_site?site=nyheder&section=nyheder
```

**Response:** HTML fragment wrapped in JSON:
```json
{
  "head": ["<style>...</style>"],
  "body": "<section class=\"tc_deck\">...</section>",
  "bodyAppend": ["<link ...>"]
}
```

Each teaser in `body` uses `<article class="tc_teaser">` containing: `<a href>` (URL), `<h4>` (headline), `<span>` (category), `<figure>` (thumbnail), `<div>` (timestamp/summary).

Images served from `cdn-free.tv2i.dk` or `cdn-play.tv2i.dk` with crop/resize params.

Send a browser `User-Agent`. No auth required. May return `403` without one.

## Limits and caveats

- No public REST API for articles. Decks API returns HTML fragments.
- TV 2 Play content may require authentication and is geo-blocked to Denmark.
- Weather data pulls from DMI — DMI cookie banner may appear.
- Heavily JS-dependent. Headless crawling misses most content.
- No RSS feeds on main pages.

## Feedback channels

| Channel | Details |
|---|---|
| **Tip os på 1234** | Anonymous tip line |
