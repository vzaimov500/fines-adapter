import { describe, expect, test } from 'vitest'
import { buildCollection } from '../src/emit.ts'
import { parseFinesFeed } from '../src/fines.ts'
import { finalTags, toOsmXml } from '../src/osmxml.ts'
import { feature, feedDoc } from './helpers.ts'

const feed = parseFinesFeed(feedDoc([feature(2), feature(10, { restricted: true })]))
const doc = buildCollection(feed, {
  retrievedAt: '2026-09-28T22:00:16.000Z',
}) as unknown as Parameters<typeof toOsmXml>[0]

describe('toOsmXml (JOSM reference layer)', () => {
  const xml = toOsmXml(doc)

  test('JOSM must never upload the layer itself', () => {
    expect(xml).toMatch(
      /^<\?xml version="1.0" encoding="UTF-8"\?>\n<osm version="0.6" [^>]*upload="never">/,
    )
  })

  test('one new node per candidate, in order, at the provider position', () => {
    const nodes = [...xml.matchAll(/<node id="(-\d+)" lat="([\d.]+)" lon="([\d.]+)">/g)]
    expect(nodes.map((m) => m[1])).toEqual(['-1', '-2'])
    expect(nodes[0]!.slice(2)).toEqual(['42.6900000', '23.3220000'])
  })

  test('tags are exactly what a reviewed Add writes: defaults, feature tags, ref', () => {
    const f = doc.features[0]!
    const tags = finalTags(doc, f)
    expect(tags).toMatchObject({
      amenity: 'charging_station',
      brand: 'Fines Charging',
      'brand:wikidata': 'Q128904354',
      'ref:fines': '2',
    })
    const first = xml.split('</node>')[0]!
    const written = Object.fromEntries(
      [...first.matchAll(/<tag k="([^"]*)" v="([^"]*)"\/>/g)].map((m) => [m[1], m[2]]),
    )
    expect(written).toEqual(tags)
    // Display-only fields never become tags.
    expect(xml).not.toMatch(/k="(name|label|address|source_id|notes)"/)
  })

  test('feature tags win over defaults, and the ref always wins', () => {
    const d = {
      metadata: { ref_key: 'ref:x', default_tags: { amenity: 'charging_station', access: 'yes' } },
      features: [
        {
          geometry: { coordinates: [23, 42] as [number, number] },
          properties: { ref: '7', tags: { access: 'customers', 'ref:x': 'other' } },
        },
      ],
    }
    expect(finalTags(d, d.features[0]!)).toEqual({
      amenity: 'charging_station',
      access: 'customers',
      'ref:x': '7',
    })
  })

  test('values are XML-escaped; non-ASCII text is kept as is', () => {
    const d = {
      metadata: { ref_key: 'ref:x' },
      features: [
        {
          geometry: { coordinates: [23, 42] as [number, number] },
          properties: { ref: '1', tags: { note: `A & B <"x"> 'y'\nЗарядна` } },
        },
      ],
    }
    expect(toOsmXml(d)).toContain(
      '<tag k="note" v="A &amp; B &lt;&quot;x&quot;&gt; &apos;y&apos;&#10;Зарядна"/>',
    )
  })
})
