# Fines Charging → OpenStreetMap tag mapping

This document is the translation step the OSM import guidelines ask to be
published. Every rule is implemented in [`src/mapping.ts`](src/mapping.ts) and
covered by [`test/mapping.test.ts`](test/mapping.test.ts).

**Status: draft — not yet reviewed by the OSM community or confirmed by Fines.**
Items marked _open_ must be settled before any live upload.

Source: `https://public.finescharging.com/v1/locations.geojson`, schema_version 1,
documented at <https://finescharging.com/en/public-api>.

## Principle

Map only what is certain. When a field cannot be mapped confidently, the tag is
left out and the reason goes into the candidate's `notes`, which the reviewer
sees next to the row. Nothing is guessed.

## Licence — _open, blocking_

Until permission to use the data in OpenStreetMap is documented, the adapter
emits `licence: "LicenseRef-pending"`, and osm-charge-review refuses live
uploads. Once permission exists:
`--licence LicenseRef-permission --permission-url <wiki page>`.

## Dataset

| Interchange field | Value                                                               |
| ----------------- | ------------------------------------------------------------------- |
| `dataset_id`      | `fines-charging-bg`                                                 |
| `ref_key`         | `ref:fines` (_open_: confirm the namespace in the community review) |
| `default_tags`    | `amenity=charging_station` only (see Operator, network, brand)      |

## Per location

| Feed field     | OSM                                             | Rule                                                                                                                                                                                                                                                              |
| -------------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`           | `ref:fines=<id>`                                | Stable numeric location id, written as a string. Also `source_id`.                                                                                                                                                                                                |
| geometry       | node position                                   | `[lon, lat]`, unchanged. Existing OSM positions are never moved without an explicit reviewer decision.                                                                                                                                                            |
| `name`         | —                                               | **Display label only, never `name=*`.** Feed names are internal site labels ("FINES Petrol Tserovo"), not names signed on the ground.                                                                                                                             |
| `address`      | —                                               | Display only, to orient the reviewer.                                                                                                                                                                                                                             |
| `connectors`   | `socket:<type>=<count>`                         | See the socket table. Zero counts skipped.                                                                                                                                                                                                                        |
| `max_power_kw` | `socket:<type>:output="<n> kW"`                 | Only when the location has exactly one socket type and no unmapped plugs, since the feed gives one maximum for the whole location. Otherwise left out, with a note. Values > 500 kW, or > 43 kW on an AC Type 2 socket, are left out as implausible, with a note. |
| `restricted`   | `access=yes` when `false`                       | Documented as "true when access is restricted or conditional". `true` is ambiguous (customers? residents? private?), so no `access` tag, and a note asks the reviewer to check.                                                                                   |
| `price_range`  | `fee=yes` if max > 0; `fee=no` if min = max = 0 | Prices themselves (`charge=*`) are not mapped: they change too often for OSM.                                                                                                                                                                                     |

### Sockets

Keys verified against <https://wiki.openstreetmap.org/wiki/Key:socket>.

| Feed plug type                    | OSM key                                                                                      |
| --------------------------------- | -------------------------------------------------------------------------------------------- |
| CCS Combo 2 Plug (Cable Attached) | `socket:type2_combo`                                                                         |
| CCS Combo 1 Plug (Cable Attached) | `socket:type1_combo`                                                                         |
| Type 2 Outlet                     | `socket:type2` (no cable attached)                                                           |
| Type 2 Connector (Cable Attached) | `socket:type2_cable`                                                                         |
| CHAdeMO                           | `socket:chademo`                                                                             |
| Type 3 Outlet                     | **not mapped**: OSM needs `type3a` or `type3c`, and the feed does not say which. Note added. |
| Small Paddle Inductive            | **not mapped**: obsolete Magne Charge, almost certainly a data-entry error. Note added.      |
| anything else                     | **not mapped**, note added.                                                                  |

## Not mapped (deliberately)

| OSM key                                          | Why not                                                                                                                                 |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| `name`                                           | See above.                                                                                                                              |
| `capacity`                                       | The number of vehicles that can charge at once is not the connector count (a dual-cable charger often serves one car). Not in the feed. |
| `operator`, `network`, `brand`                   | _Open._ See below.                                                                                                                      |
| `charge`                                         | Volatile.                                                                                                                               |
| `opening_hours`, `authentication:*`, `payment:*` | Not in the feed. Existing values in OSM are always kept.                                                                                |
| `source`                                         | Belongs on the changeset, never on objects.                                                                                             |

## Operator, network, brand — _open, blocking_

These are not mapped until the correct values are confirmed. Values are copied
from the [Name Suggestion Index](https://nsi.guide/) where Fines has an entry,
never invented. Until then, `default_tags` contains only
`amenity=charging_station`. Pass confirmed values with `--config`
(`{"defaultTags": {"network": "…"}}`).

The Name Suggestion Index has a _brand_ entry for Fines
(`brand=Fines Charging`, `brand:wikidata=Q128904354`), ready to use as
[`config/nsi-brand.json`](config/nsi-brand.json).

## Not used from the API

- `/v1/live.json`, `/v1/live/:id.json`: live connector status is transient and
  does not belong in OSM.
