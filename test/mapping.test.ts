import { describe, expect, test } from 'vitest'
import type { FinesConnector, FinesLocation } from '../src/fines.ts'
import { branchFromName, formatKw, mapLocation, SOCKET_KEYS } from '../src/mapping.ts'

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

  test('without the per-connector list, a very high site maximum is flagged, not tagged', () => {
    const r = mapLocation(loc({ maxPowerKw: 1000 }))
    expect(r.tags['socket:type2_combo:output']).toBeUndefined()
    expect(r.notes[0]).toMatch(/1000 kW.*too high/)
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

describe('per-connector list (live.json)', () => {
  const CCS = 'CCS Combo 2 Plug (Cable Attached)'
  const con = (
    chargerId: number,
    name: string,
    plugType: string,
    maxPowerKw: number | null,
  ): FinesConnector => ({ chargerId, name, plugType, maxPowerKw })

  test('each socket type gets its own power (two chargers, DC and AC)', () => {
    const r = mapLocation(loc({ connectors: { [CCS]: 2, 'Type 2 Outlet': 1 }, maxPowerKw: 240 }), [
      con(613, 'CCS 1', CCS, 240),
      con(613, 'CCS 2', CCS, 240),
      con(281, 'AC', 'Type 2 Outlet', 22),
    ])
    expect(r.tags).toMatchObject({
      'socket:type2_combo': '2',
      'socket:type2_combo:output': '240 kW',
      'socket:type2': '1',
      'socket:type2:output': '22 kW',
    })
    expect(r.notes).toEqual([])
  })

  test('one charger with CCS and CHAdeMO: both powers tagged, capacity is not', () => {
    const r = mapLocation(loc({ connectors: { [CCS]: 1, CHAdeMO: 1 }, maxPowerKw: 80 }), [
      con(5, 'CCS', CCS, 80),
      con(5, 'CHAdeMO', 'CHAdeMO', 80),
    ])
    expect(r.tags).toMatchObject({
      'socket:type2_combo:output': '80 kW',
      'socket:chademo': '1',
      'socket:chademo:output': '80 kW',
    })
    expect(r.tags.capacity).toBeUndefined()
  })

  test('mixed powers are listed highest first; an MCS connector listed as CCS becomes socket:mcs', () => {
    const r = mapLocation(loc({ connectors: { [CCS]: 5 }, maxPowerKw: 1000 }), [
      con(701, 'CCS 1', CCS, 600),
      con(701, 'MCS', CCS, 1000),
      con(462, 'CCS 5', CCS, 480),
      con(462, 'CCS 6', CCS, 480),
      con(1122, 'CCS 15', CCS, 120),
    ])
    expect(r.tags).toMatchObject({
      'socket:type2_combo': '4',
      'socket:type2_combo:output': '600 kW;480 kW;120 kW',
      'socket:mcs': '1',
      'socket:mcs:output': '1000 kW',
    })
    expect(r.notes).toEqual([`connector "MCS" is listed as ${CCS}; tagged as socket:mcs`])
  })

  test('a plug type that already says MCS needs no note', () => {
    const r = mapLocation(loc({ connectors: { MCS: 1 }, maxPowerKw: 1200 }), [
      con(9, 'MCS', 'MCS', 1200),
    ])
    expect(r.tags).toMatchObject({ 'socket:mcs': '1', 'socket:mcs:output': '1200 kW' })
    expect(r.notes).toEqual([])
  })

  test('a DC plug on a connector named "AC" is flagged, not tagged', () => {
    const r = mapLocation(
      loc({
        connectors: {
          'CCS Combo 1 Plug (Cable Attached)': 1,
          'Type 2 Connector (Cable Attached)': 1,
        },
        maxPowerKw: 22,
      }),
      [
        con(1403, 'AC 1', 'CCS Combo 1 Plug (Cable Attached)', 22),
        con(1404, 'AC 2', 'Type 2 Connector (Cable Attached)', 22),
      ],
    )
    expect(r.tags['socket:type1_combo']).toBeUndefined()
    expect(r.tags['socket:type2_cable:output']).toBe('22 kW')
    expect(r.notes[0]).toMatch(/"AC 1" is listed as CCS Combo 1.*looks wrong/)
  })

  test('a list that disagrees with the summary is not used', () => {
    const r = mapLocation(loc({ connectors: { [CCS]: 2 }, maxPowerKw: 120 }), [
      con(1, 'CCS 1', CCS, 120),
    ])
    expect(r.tags['socket:type2_combo']).toBe('2')
    expect(r.tags['socket:type2_combo:output']).toBe('120 kW') // summary path: single type
    expect(r.notes[0]).toMatch(/does not match the location summary/)
  })

  test('missing or implausible powers are flagged per socket type', () => {
    const r = mapLocation(
      loc({ connectors: { [CCS]: 2, 'Type 2 Outlet': 1, CHAdeMO: 1 }, maxPowerKw: 50 }),
      [
        con(1, 'CCS 1', CCS, 50),
        con(1, 'CCS 2', CCS, null),
        con(2, 'AC', 'Type 2 Outlet', 50),
        con(3, 'CHAdeMO', 'CHAdeMO', 1200),
      ],
    )
    expect(r.tags['socket:type2_combo:output']).toBeUndefined()
    expect(r.tags['socket:type2:output']).toBeUndefined()
    expect(r.tags['socket:chademo:output']).toBeUndefined()
    expect(r.notes).toEqual([
      'power missing for some type2_combo connectors — output not tagged',
      'feed advertises 50 kW on a type2 connector (plausible up to 43 kW) — output not tagged',
      'feed advertises 1200 kW on a chademo connector (plausible up to 1000 kW) — output not tagged',
    ])
  })

  test('unknown and unmapped plugs are explained once per type', () => {
    const r = mapLocation(loc({ connectors: { 'Type 3 Outlet': 1, Mystery: 2 }, maxPowerKw: 22 }), [
      con(1, null as unknown as string, 'Type 3 Outlet', 22),
      con(2, 'X', 'Mystery', 22),
      con(2, 'Y', 'Mystery', 22),
    ])
    expect(Object.keys(r.tags).some((k) => k.startsWith('socket:'))).toBe(false)
    expect(r.notes.join('\n')).toMatch(/Type 3/)
    expect(r.notes.join('\n')).toMatch(/unknown plug type "Mystery" ×2/)
    expect(r.notes.join('\n')).toMatch(/no connector type could be mapped/)
  })
})

describe('branch', () => {
  test.each([
    ['FINES Gelemenovo', 'Gelemenovo'],
    ['fines  Mladost 1 ', 'Mladost 1'],
    ['FINES - Trakia 243 Burgas', 'Trakia 243 Burgas'],
    ['Hotel Rostov', 'Hotel Rostov'],
    ['Finesse Spa', 'Finesse Spa'], // only the whole word is the brand
    ['FINES', undefined],
    ['  ', undefined],
    [null, undefined],
  ])('%j → %j', (name, branch) => expect(branchFromName(name)).toBe(branch))

  test('the site label becomes branch, never name', () => {
    const { tags } = mapLocation(loc({ name: 'FINES Gelemenovo' }))
    expect(tags.branch).toBe('Gelemenovo')
    expect(tags.name).toBeUndefined()
    expect(mapLocation(loc({ name: null })).tags.branch).toBeUndefined()
  })
})
