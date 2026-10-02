# Fines Charging → OpenStreetMap tag mapping

This document is the translation step the OSM import guidelines ask to be
published. Every rule is implemented in [`src/mapping.ts`](src/mapping.ts) and
covered by [`test/mapping.test.ts`](test/mapping.test.ts).

**Status: proposed for community review.** Items marked _open_ are settled in
that review before any live upload.

Sources: `https://public.finescharging.com/v1/locations.geojson` (locations) and
`https://public.finescharging.com/v1/live.json` (connectors: charger, plug type,
power), schema_version 1, documented at <https://finescharging.com/en/public-api>.

## Principle

Map only what is certain. When a field cannot be mapped confidently, the tag is
left out and the reason goes into the candidate's `notes`, which the reviewer
sees next to the row. Nothing is guessed.

## Licence

Fines Charging has given written permission to use the data in OpenStreetMap.
Until that permission is published on the import wiki page, the adapter emits
`licence: "LicenseRef-pending"`, and osm-charge-review refuses live uploads.
Once it is published:
`--licence LicenseRef-permission --permission-url <wiki page>`.

## Dataset

| Interchange field | Value                                                               |
| ----------------- | ------------------------------------------------------------------- |
| `dataset_id`      | `fines-charging-bg`                                                 |
| `ref_key`         | `ref:fines` (_open_: confirm the namespace in the community review) |
| `default_tags`    | `amenity=charging_station`, plus the brand tags (see Brand)         |

## Per location

| Feed field    | OSM                                             | Rule                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `id`          | `ref:fines=<id>`                                | Stable numeric location id, written as a string. Also `source_id`.                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| geometry      | node position                                   | `[lon, lat]`, unchanged. Existing OSM positions are never moved without an explicit reviewer decision.                                                                                                                                                                                                                                                                                                                                                                                                 |
| `name`        | —                                               | Display label only, not `name=*` (_open_: community review). Feed names are internal site labels ("FINES Petrol Tserovo"), not names signed on the ground, although many mapped stations in Bulgaria carry them. Existing `name` values in OSM are always kept.                                                                                                                                                                                                                                        |
| `address`     | —                                               | Display only, to orient the reviewer.                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `connectors`  | `socket:<type>=<count>`                         | Counted connector by connector from `live.json`. A connector _named_ "MCS" is `socket:mcs` (the feed lists it under a CCS plug type), with a note. A DC plug on a connector named "AC …" is a contradiction: not tagged, with a note. Zero counts skipped.                                                                                                                                                                                                                                             |
| power         | `socket:<type>:output="<n> kW"`                 | Per socket type from each connector's `max_power_kw`. Several powers are listed highest first, as local mappers write them (`600 kW;480 kW;120 kW`). Left out, with a note, when a power is missing or implausible: over 43 kW on AC Type 2, over 1000 kW on other DC plugs, over 3750 kW on MCS. If the connector list does not match the location's summary, only the summary is used: its single `max_power_kw` is tagged only for a location with exactly one socket type, and never above 500 kW. |
| `restricted`  | `access=yes` when `false`                       | Documented as "true when access is restricted or conditional". `true` is ambiguous (customers? residents? private?), so no `access` tag, and a note asks the reviewer to check.                                                                                                                                                                                                                                                                                                                        |
| `price_range` | `fee=yes` if max > 0; `fee=no` if min = max = 0 | Prices themselves (`charge=*`) are not mapped: they change too often for OSM.                                                                                                                                                                                                                                                                                                                                                                                                                          |

### Sockets

Keys verified against <https://wiki.openstreetmap.org/wiki/Key:socket>.

| Feed plug type                    | OSM key                                                                                      |
| --------------------------------- | -------------------------------------------------------------------------------------------- |
| CCS Combo 2 Plug (Cable Attached) | `socket:type2_combo`                                                                         |
| CCS Combo 1 Plug (Cable Attached) | `socket:type1_combo`                                                                         |
| Type 2 Outlet                     | `socket:type2` (no cable attached)                                                           |
| Type 2 Connector (Cable Attached) | `socket:type2_cable`                                                                         |
| CHAdeMO                           | `socket:chademo`                                                                             |
| a connector _named_ "MCS"         | `socket:mcs` (Megawatt Charging System). Fines lists it under a CCS plug type; note added.   |
| Type 3 Outlet                     | **not mapped**: OSM needs `type3a` or `type3c`, and the feed does not say which. Note added. |
| Small Paddle Inductive            | **not mapped**: obsolete Magne Charge, almost certainly a data-entry error. Note added.      |
| anything else                     | **not mapped**, note added.                                                                  |

## Not mapped (deliberately)

| OSM key                                          | Why not                                                                                                                                 |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| `name`                                           | See above.                                                                                                                              |
| `capacity`                                       | The number of vehicles that can charge at once is not the connector count (a dual-cable charger often serves one car). Not in the feed. |
| `operator`, `network`                            | See Brand.                                                                                                                              |
| `charge`                                         | Volatile.                                                                                                                               |
| `opening_hours`, `authentication:*`, `payment:*` | Not in the feed. Existing values in OSM are always kept.                                                                                |
| `source`                                         | Belongs on the changeset, never on objects.                                                                                             |

## Brand

Every station gets `brand=Fines Charging` and `brand:wikidata=Q128904354`,
copied verbatim from the [Name Suggestion Index](https://nsi.guide/) entry
for Fines Charging, so the values match what editors suggest.

`operator` and `network` are not mapped: the Name Suggestion Index has no entry
for them, and they are not invented. Existing values in OSM are kept. Other
values can be passed with `--config` (`{"defaultTags": {"operator": "…"}}`).

## Not used from the API

- From `/v1/live.json`: connector status and availability. They are transient
  and do not belong in OSM; only the charger, plug type and power are read.
- `/v1/live/:id.json`: the same data per location; one network-wide request is
  enough.
