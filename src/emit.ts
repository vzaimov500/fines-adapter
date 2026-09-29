/** Builds and validates the interchange document (osm-charge-review FORMAT.md v1). */
import { Ajv2020 } from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import { readFileSync } from 'node:fs'
import { FINES_LOCATIONS_URL, type FinesConnector, type FinesFeed } from './fines.ts'
import { mapLocation } from './mapping.ts'
import { ADAPTER_NAME, ADAPTER_URL, ADAPTER_VERSION } from './version.ts'

export interface EmitOptions {
  /** When the feed was fetched (ISO 8601). */
  retrievedAt: string
  /**
   * SPDX id or LicenseRef-*. Defaults to LicenseRef-pending: the feed publishes
   * no licence, so no compatible licence may be claimed until permission exists.
   */
  licence?: string
  permissionUrl?: string
  /** OSM key for the Fines location id (provisional). */
  refKey?: string
  /** Merged into every feature. Operator/network/brand come from NSI + Fines confirmation, never invented. */
  defaultTags?: Record<string, string>
}

export const DATASET_ID = 'fines-charging-bg'
export const DEFAULT_REF_KEY = 'ref:fines'
export const DEFAULT_LICENCE = 'LicenseRef-pending'

/**
 * `connectors` is the per-connector list from /v1/live.json, by location id.
 * Without it, sockets and power come from each location's summary only.
 */
export function buildCollection(
  feed: FinesFeed,
  opts: EmitOptions,
  connectors?: ReadonlyMap<number, readonly FinesConnector[]>,
): Record<string, unknown> {
  const metadata: Record<string, unknown> = {
    format_version: '1',
    dataset_id: DATASET_ID,
    dataset_name: 'Fines Charging locations, Bulgaria',
    source_url: FINES_LOCATIONS_URL,
    licence: opts.licence ?? DEFAULT_LICENCE,
    retrieved_at: opts.retrievedAt,
    adapter: { name: ADAPTER_NAME, version: ADAPTER_VERSION, url: ADAPTER_URL },
    ref_key: opts.refKey ?? DEFAULT_REF_KEY,
    default_tags: { amenity: 'charging_station', ...opts.defaultTags },
  }
  if (opts.permissionUrl !== undefined) metadata.permission_url = opts.permissionUrl

  const features = [...feed.locations]
    .sort((a, b) => a.id - b.id)
    .map((loc) => {
      const own = connectors?.get(loc.id)
      const { tags, notes } = mapLocation(loc, own)
      if (connectors !== undefined && own === undefined)
        notes.unshift('location missing from the per-connector list — per-connector power not used')
      const properties: Record<string, unknown> = {
        source_id: String(loc.id),
        ref: String(loc.id),
        tags,
        source_raw: loc.raw,
      }
      if (loc.name !== null) properties.label = loc.name
      if (loc.address !== null) properties.address = loc.address
      if (notes.length > 0) properties.notes = notes.join('\n')
      return {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [loc.lon, loc.lat] },
        properties,
      }
    })

  return { type: 'FeatureCollection', metadata, features }
}

let validator: ReturnType<Ajv2020['compile']> | undefined

/** Validate against the vendored schema/candidates.schema.json. Returns error strings. */
export function validateCollection(doc: unknown): string[] {
  if (!validator) {
    const schema = JSON.parse(
      readFileSync(new URL('../schema/candidates.schema.json', import.meta.url), 'utf8'),
    )
    const ajv = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true })
    addFormats.default(ajv, ['uri', 'date-time'])
    ajv.addKeyword({ keyword: 'tsType', schemaType: 'string' })
    validator = ajv.compile(schema)
  }
  if (validator(doc)) return []
  return (validator.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message ?? e.keyword}`)
}
