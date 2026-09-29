/**
 * The Fines Charging public locations feed, schema_version 1, as documented at
 * https://finescharging.com/en/public-api. Per that documentation, clients
 * must ignore unknown fields; we only read what is listed here.
 */
export const FINES_LOCATIONS_URL = 'https://public.finescharging.com/v1/locations.geojson'
export const FINES_DOCS_URL = 'https://finescharging.com/en/public-api'
export const SUPPORTED_SCHEMA_VERSIONS = [1] as const

export interface FinesPriceRange {
  min: number
  max: number
  currency: string
  unit: string
}

export interface FinesLocation {
  id: number
  lon: number
  lat: number
  name: string | null
  address: string | null
  restricted: boolean
  connectors: Record<string, number>
  maxPowerKw: number | null
  priceRange: FinesPriceRange | null
  /** The feature's properties exactly as received, for `source_raw`. */
  raw: Record<string, unknown>
}

export interface FinesFeed {
  schemaVersion: number
  generatedAt: string
  locations: FinesLocation[]
}

export class FeedError extends Error {
  override name = 'FeedError'
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v)
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const strOrNull = (v: unknown): v is string | null => v === null || typeof v === 'string'

/**
 * Checks the feed against its documented contract and normalises it. Any
 * deviation is an error: a silently misread feed produces wrong tags.
 */
export function parseFinesFeed(data: unknown): FinesFeed {
  if (!isObj(data) || data.type !== 'FeatureCollection')
    throw new FeedError('Not a GeoJSON FeatureCollection')
  const v = data.schema_version
  if (!(SUPPORTED_SCHEMA_VERSIONS as readonly unknown[]).includes(v)) {
    throw new FeedError(
      `Unsupported schema_version ${JSON.stringify(v)}; this adapter understands ${SUPPORTED_SCHEMA_VERSIONS.join(', ')}`,
    )
  }
  if (typeof data.generated_at !== 'string' || Number.isNaN(Date.parse(data.generated_at))) {
    throw new FeedError('generated_at missing or not a timestamp')
  }
  if (!Array.isArray(data.features)) throw new FeedError('features is not an array')

  const locations = data.features.map((f: unknown, i): FinesLocation => {
    const at = (msg: string) => new FeedError(`features[${i}]: ${msg}`)
    if (!isObj(f) || !isObj(f.properties) || !isObj(f.geometry)) throw at('malformed feature')
    const p = f.properties
    const g = f.geometry
    if (g.type !== 'Point' || !Array.isArray(g.coordinates) || g.coordinates.length < 2)
      throw at('geometry is not a Point')
    const [lon, lat] = g.coordinates as unknown[]
    if (!isNum(lon) || !isNum(lat)) throw at('non-numeric coordinates')
    if (!Number.isInteger(p.id)) throw at('id is not an integer')
    if (!strOrNull(p.name) || !strOrNull(p.address)) throw at('name/address must be string or null')
    if (typeof p.restricted !== 'boolean') throw at('restricted is not a boolean')
    if (
      !isObj(p.connectors) ||
      !Object.values(p.connectors).every((n) => Number.isInteger(n) && (n as number) >= 0)
    ) {
      throw at('connectors must map plug type to a non-negative integer count')
    }
    if (p.max_power_kw !== null && !(isNum(p.max_power_kw) && p.max_power_kw > 0))
      throw at('max_power_kw must be positive or null')
    let priceRange: FinesPriceRange | null = null
    if (p.price_range !== null) {
      const r = p.price_range
      if (
        !isObj(r) ||
        !isNum(r.min) ||
        !isNum(r.max) ||
        typeof r.currency !== 'string' ||
        typeof r.unit !== 'string'
      ) {
        throw at('price_range malformed')
      }
      priceRange = { min: r.min, max: r.max, currency: r.currency, unit: r.unit }
    }
    return {
      id: p.id as number,
      lon,
      lat,
      name: p.name,
      address: p.address,
      restricted: p.restricted,
      connectors: p.connectors as Record<string, number>,
      maxPowerKw: p.max_power_kw as number | null,
      priceRange,
      raw: p,
    }
  })
  return { schemaVersion: v as number, generatedAt: data.generated_at, locations }
}
