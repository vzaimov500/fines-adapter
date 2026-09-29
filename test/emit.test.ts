import { describe, expect, test } from 'vitest'
import { buildCollection, validateCollection } from '../src/emit.ts'
import { parseFinesFeed } from '../src/fines.ts'
import { feature, feedDoc } from './helpers.ts'

const feed = parseFinesFeed(
  feedDoc([
    feature(10),
    feature(2, { name: null, address: null, restricted: true }),
    feature(3, { connectors: { 'Type 3 Outlet': 1 } }),
  ]),
)
const build = (o = {}) =>
  buildCollection(feed, { retrievedAt: '2026-09-28T22:00:16.000Z', ...o }) as {
    metadata: Record<string, unknown>
    features: { properties: Record<string, unknown>; geometry: { coordinates: number[] } }[]
  }

describe('buildCollection', () => {
  test('produces a schema-valid document', () => {
    expect(validateCollection(build())).toEqual([])
  })

  test('safe defaults: pending licence, namespaced ref key, only amenity as default tag', () => {
    const d = build()
    expect(d.metadata).toMatchObject({
      format_version: '1',
      dataset_id: 'fines-charging-bg',
      licence: 'LicenseRef-pending',
      ref_key: 'ref:fines',
      default_tags: { amenity: 'charging_station' },
      source_url: 'https://public.finescharging.com/v1/locations.geojson',
    })
    expect(d.metadata.permission_url).toBeUndefined()
  })

  test('options override defaults', () => {
    const d = build({
      licence: 'LicenseRef-permission',
      permissionUrl: 'https://wiki.example/x',
      refKey: 'ref',
      defaultTags: { network: 'X' },
    })
    expect(d.metadata).toMatchObject({
      licence: 'LicenseRef-permission',
      permission_url: 'https://wiki.example/x',
      ref_key: 'ref',
    })
    expect(d.metadata.default_tags).toEqual({ amenity: 'charging_station', network: 'X' })
    expect(validateCollection(d)).toEqual([])
  })

  test('features sorted by id, ids as strings, name only as label', () => {
    const d = build()
    expect(d.features.map((f) => f.properties.source_id)).toEqual(['2', '3', '10'])
    const f10 = d.features[2]!.properties
    expect(f10).toMatchObject({ source_id: '10', ref: '10', label: 'Test Site 10' })
    expect((f10.tags as Record<string, string>).name).toBeUndefined()
    expect(f10.source_raw).toMatchObject({ id: 10 })
  })

  test('null label/address omitted; notes joined', () => {
    const f2 = build().features[0]!.properties
    expect(f2.label).toBeUndefined()
    expect(f2.address).toBeUndefined()
    expect(f2.notes).toMatch(/restricted/)
    expect(build().features[2]!.properties.notes).toBeUndefined()
  })

  test('validation reports problems', () => {
    const d = build()
    ;(d.metadata as Record<string, unknown>).licence = 'not a licence!'
    expect(validateCollection(d)[0]).toMatch(/licence/)
  })
})

describe('with the per-connector list', () => {
  test('used where present; a missing location falls back and says so', () => {
    const connectors = new Map([
      [
        10,
        [
          {
            chargerId: 1,
            name: 'CCS 1',
            plugType: 'CCS Combo 2 Plug (Cable Attached)',
            maxPowerKw: 150,
          },
          {
            chargerId: 1,
            name: 'CCS 2',
            plugType: 'CCS Combo 2 Plug (Cable Attached)',
            maxPowerKw: 150,
          },
        ],
      ],
    ])
    const d = buildCollection(feed, { retrievedAt: '2026-09-28T22:00:16.000Z' }, connectors) as {
      features: {
        properties: { source_id: string; tags: Record<string, string>; notes?: string }
      }[]
    }
    const byId = new Map(d.features.map((f) => [f.properties.source_id, f.properties]))
    expect(byId.get('10')!.tags['socket:type2_combo:output']).toBe('150 kW')
    expect(byId.get('2')!.notes).toMatch(/^location missing from the per-connector list/)
    expect(validateCollection(d)).toEqual([])
  })
})
