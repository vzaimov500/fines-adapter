/** Synthetic feed records shaped like the real feed. Not real Fines data. */
export function feature(
  id: number,
  props: Record<string, unknown> = {},
  coords: [number, number] = [23.32 + id / 1000, 42.69],
) {
  return {
    type: 'Feature',
    id,
    properties: {
      id,
      name: `Test Site ${id}`,
      address: `Test Street ${id}, Sofia 1000, България`,
      restricted: false,
      connectors: { 'CCS Combo 2 Plug (Cable Attached)': 2 },
      max_power_kw: 120,
      price_range: { min: 0.39, max: 0.39, currency: 'EUR', unit: 'kWh' },
      ...props,
    },
    geometry: { type: 'Point', coordinates: coords },
  }
}

export function feedDoc(features: unknown[], extra: Record<string, unknown> = {}) {
  return {
    type: 'FeatureCollection',
    schema_version: 1,
    generated_at: '2026-09-28T21:32:04.082Z',
    features,
    ...extra,
  }
}
