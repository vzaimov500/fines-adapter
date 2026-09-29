# fines-adapter

Converts the [Fines Charging public locations feed](https://finescharging.com/en/public-api)
into the [osm-charge-review](https://github.com/vzaimov500/osm-charge-review)
interchange format, so that a human can review each station against
OpenStreetMap.

This tool **does not edit OpenStreetMap.** It writes one file. The tag mapping
is documented in [MAPPING.md](MAPPING.md).

## Usage

Requires Node 24 (it runs TypeScript directly; no build step).

```sh
pnpm install
pnpm start                 # fetch (politely) and write out/fines-charging-bg.geojson
pnpm start --offline       # use the cached feed only
pnpm start --help
```

## Being a good API citizen

- One request per run at most, and none while the cached copy is fresh
  (`Cache-Control: max-age`). Never more than one request per 5 minutes, even
  with `--force`.
- Conditional requests (`If-None-Match` / `If-Modified-Since`): an unchanged
  feed costs the server a 304.
- An honest, identifying `User-Agent`: `fines-adapter/<version> (+<repo url>)`.
  Add a contact with `--contact` or `FINES_ADAPTER_CONTACT`.
- 60 s timeout. At most 3 attempts, only for network errors, 429 and 5xx, with
  10 s / 30 s backoff that honours `Retry-After`. Client errors are never retried.
- On persistent failure, the last good copy is used (as the Fines docs
  request) and the output records when it was fetched.

The cache (`.cache/`) and output (`out/`) are not committed: the provider's
data is not ours to redistribute. Tests use synthetic records.

## Development

```sh
pnpm verify    # lint + typecheck + tests
```

## Licence

GPL-3.0-or-later.
