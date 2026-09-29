import { describe, expect, test } from 'vitest'
import type { FinesLocation } from '../src/fines.ts'
import { formatKw, mapLocation, SOCKET_KEYS } from '../src/mapping.ts'

const loc = (over: Partial<FinesLocation> = {}): FinesLocation => ({
  id: 1,
  lon: 23.3,
  lat: 42.7,
  name: 'Test',
  address: null,
  restricted: false,
  connectors: { 'CCS Combo 2 Plug (Cable Attached)': 2 },
  maxPowerKw: 120,
  priceRange: { min: 0.39, max: 0.39, currency: 'EUR', unit: 'kWh' },
  raw: {},
  ...over,
})

describe('sockets', () => {
  test.each(Object.entries(SOCKET_KEYS))('%s → %s', (plug, key) => {
    const { tags } = mapLocation(loc({ connectors: { [plug]: 3 }, maxPowerKw: null }))
    expect(tags[key]).toBe('3')
  })

  test('zero counts are skipped', () => {
    const { tags, notes } = mapLocation(
      loc({ connectors: { CHAdeMO: 0, 'Type 2 Outlet': 1 }, maxPowerKw: 22 }),
    )
    expect(tags['socket:chademo']).toBeUndefined()
    expect(tags['socket:type2:output']).toBe('22 kW')
    expect(notes).toEqual([])
  })

  test.each(['Type 3 Outlet', 'Small Paddle Inductive', 'Tesla Supercharger'])(
    '%s is not tagged and is explained',
    (plug) => {
      const { tags, notes } = mapLocation(loc({ connectors: { [plug]: 1 } }))
      expect(Object.keys(tags).some((k) => k.startsWith('socket:'))).toBe(false)
      expect(notes.join(' ')).toMatch(/not tagged/)
      expect(notes.join(' ')).toMatch(/no connector type could be mapped/)
    },
  )
})

describe('output', () => {
  test('single socket type gets the location maximum', () => {
    expect(mapLocation(loc()).tags['socket:type2_combo:output']).toBe('120 kW')
  })

  test('several socket types: output not attributed, reviewer told why', () => {
    const r = mapLocation(
      loc({ connectors: { 'CCS Combo 2 Plug (Cable Attached)': 1, CHAdeMO: 1 }, maxPowerKw: 50 }),
    )
    expect(Object.keys(r.tags).filter((k) => k.endsWith(':output'))).toEqual([])
    expect(r.notes[0]).toMatch(/location maximum \(50 kW\)/)
  })

  test('one mapped type plus an unmapped plug: output not attributed', () => {
    const r = mapLocation(
      loc({ connectors: { 'Type 2 Outlet': 1, 'Type 3 Outlet': 1 }, maxPowerKw: 22 }),
    )
    expect(r.tags['socket:type2:output']).toBeUndefined()
  })

  test('implausible power is flagged, not tagged', () => {
    const r = mapLocation(loc({ maxPowerKw: 1000 }))
    expect(r.tags['socket:type2_combo:output']).toBeUndefined()
    expect(r.notes[0]).toMatch(/1000 kW.*implausible/)
  })

  test('AC socket above 43 kW is flagged, not tagged', () => {
    const r = mapLocation(
      loc({ connectors: { 'Type 2 Connector (Cable Attached)': 1 }, maxPowerKw: 150 }),
    )
    expect(r.tags['socket:type2_cable:output']).toBeUndefined()
    expect(r.notes[0]).toMatch(/AC type2_cable socket/)
  })

  test('43 kW on AC is allowed', () => {
    expect(
      mapLocation(loc({ connectors: { 'Type 2 Outlet': 1 }, maxPowerKw: 43 })).tags[
        'socket:type2:output'
      ],
    ).toBe('43 kW')
  })

  test('null power: nothing', () => {
    const r = mapLocation(loc({ maxPowerKw: null }))
    expect(r.tags['socket:type2_combo:output']).toBeUndefined()
    expect(r.notes).toEqual([])
  })

  test.each([
    [22, '22 kW'],
    [7.4, '7.4 kW'],
    [3.68, '3.68 kW'],
    [11.0, '11 kW'],
    [2.3456, '2.35 kW'],
  ])('formatKw(%d) = %s', (kw, s) => expect(formatKw(kw)).toBe(s))
})

describe('access and fee', () => {
  test('unrestricted → access=yes', () => expect(mapLocation(loc()).tags.access).toBe('yes'))

  test('restricted → no access tag, reviewer told', () => {
    const r = mapLocation(loc({ restricted: true }))
    expect(r.tags.access).toBeUndefined()
    expect(r.notes.join()).toMatch(/restricted or conditional/)
  })

  test.each([
    [{ min: 0.3, max: 0.5, currency: 'EUR', unit: 'kWh' }, 'yes'],
    [{ min: 0, max: 0.5, currency: 'EUR', unit: 'kWh' }, 'yes'],
    [{ min: 0, max: 0, currency: 'EUR', unit: 'kWh' }, 'no'],
    [null, undefined],
  ])('price %j → fee=%s', (priceRange, fee) => {
    expect(mapLocation(loc({ priceRange })).tags.fee).toBe(fee)
  })

  test('never writes name, charge, capacity, operator or source', () => {
    const { tags } = mapLocation(loc())
    for (const k of ['name', 'charge', 'capacity', 'operator', 'source'])
      expect(tags[k]).toBeUndefined()
  })
})
