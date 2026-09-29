import { describe, expect, test } from 'vitest'
import { FeedError, parseFinesFeed } from '../src/fines.ts'
import { feature, feedDoc } from './helpers.ts'

describe('parseFinesFeed', () => {
  test('parses a valid feed and keeps the raw properties', () => {
    const f = parseFinesFeed(feedDoc([feature(1, { future_field: 'x' })]))
    expect(f.schemaVersion).toBe(1)
    expect(f.locations[0]).toMatchObject({
      id: 1,
      lon: 23.321,
      lat: 42.69,
      maxPowerKw: 120,
      restricted: false,
    })
    expect(f.locations[0]!.raw.future_field).toBe('x') // unknown fields ignored, but preserved raw
  })

  test('accepts null name, address, power and price', () => {
    const f = parseFinesFeed(
      feedDoc([feature(1, { name: null, address: null, max_power_kw: null, price_range: null })]),
    )
    expect(f.locations[0]).toMatchObject({
      name: null,
      address: null,
      maxPowerKw: null,
      priceRange: null,
    })
  })

  test.each([
    ['not a collection', { type: 'Feature' }, /FeatureCollection/],
    ['unknown schema version', feedDoc([], { schema_version: 2 }), /schema_version 2/],
    ['bad generated_at', feedDoc([], { generated_at: 'yesterday' }), /generated_at/],
    ['features not array', feedDoc([], { features: {} }), /features is not an array/],
    ['malformed feature', feedDoc([null]), /features\[0\]: malformed/],
    [
      'non-point',
      feedDoc([{ ...feature(1), geometry: { type: 'LineString', coordinates: [] } }]),
      /not a Point/,
    ],
    [
      'string coords',
      feedDoc([feature(1, {}, ['23', '42'] as unknown as [number, number])]),
      /non-numeric/,
    ],
    ['non-integer id', feedDoc([feature(1, { id: '1' })]), /id is not an integer/],
    ['numeric name', feedDoc([feature(1, { name: 5 })]), /name\/address/],
    ['restricted string', feedDoc([feature(1, { restricted: 'no' })]), /restricted/],
    [
      'negative connector count',
      feedDoc([feature(1, { connectors: { CHAdeMO: -1 } })]),
      /connectors/,
    ],
    ['connectors array', feedDoc([feature(1, { connectors: [] })]), /connectors/],
    ['zero power', feedDoc([feature(1, { max_power_kw: 0 })]), /max_power_kw/],
    [
      'price without currency',
      feedDoc([feature(1, { price_range: { min: 1, max: 1, unit: 'kWh' } })]),
      /price_range/,
    ],
  ])('rejects %s', (_, doc, msg) => {
    expect(() => parseFinesFeed(doc)).toThrow(FeedError)
    expect(() => parseFinesFeed(doc)).toThrow(msg)
  })
})
