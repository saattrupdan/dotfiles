# Private SearXNG

This is Pi's local search service. It publishes SearXNG only on
`127.0.0.1:8888` and is not reachable from the LAN. JSON is enabled for the
Pi extension; autocomplete, the public-instance features, and image proxying
are disabled. General web searches use Google, Seznam, and Yep; blocked engines
are suspended for at least an hour. The Brave, DuckDuckGo, Google CSE, and
Startpage families are removed because their anonymous endpoints persistently
return CAPTCHAs, parser errors, or traffic blocks. Search requests still go to
the configured upstream engines, so this is a private interface, not an
anonymity guarantee for those engines. Initial quality and latency results are
recorded in [`VALIDATION.md`](VALIDATION.md).

## Operations

From any directory, run these scripts (or use their absolute paths):

```sh
./agentic/pi/services/searxng/setup.sh   # create the secret and validate Docker
./agentic/pi/services/searxng/start.sh   # start and wait for HTTP readiness
./agentic/pi/services/searxng/smoke.sh   # verify loopback binding and JSON search
```

The immutable image is pinned in `compose.yml` to
`2026.9.8-3fdc6d753@sha256:`
`3547509b419cd6a67333d6d68bd1ffad8d46d3669d82e7a7bd538f7b45827432`.
The secret lives at `~/.pi/agent/secrets/searxng-secret` with mode `0600` and
is injected only through the process environment; scripts never print or
replace it. Stop it with
`SEARXNG_SECRET="$(cat "$HOME/.pi/agent/secrets/searxng-secret")" docker compose
--project-name searxng-local -f agentic/pi/services/searxng/compose.yml down`.

## Troubleshooting

- Missing Docker/Compose: install Docker Desktop (or a compatible Docker
  daemon), then rerun `setup.sh` and `start.sh`.
- Port occupied: stop the process using `127.0.0.1:8888`, or change the
  service deliberately together with the extension URL and smoke checks.
- Startup timeout: inspect logs with the same secret prefix, for example
  `SEARXNG_SECRET="$(cat "$HOME/.pi/agent/secrets/searxng-secret")" docker
  compose --project-name searxng-local -f agentic/pi/services/searxng/compose.yml
  logs searxng`.
- Malformed or empty JSON: run `smoke.sh`; the extension reports malformed,
  empty, unavailable, non-2xx, timeout, and partial-engine failures
  separately.
- Upstream CAPTCHA/rate-limit warnings: affected engines remain suspended for
  one hour (24 hours for CAPTCHA/access denial). Pi serializes concurrent search
  tool calls so one model turn cannot send an upstream burst.
