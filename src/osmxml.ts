/**
 * A JOSM reference layer: one new node per candidate, carrying exactly the tags
 * a reviewed Add would write (default_tags ⊕ feature tags ⊕ ref), nothing else.
 * `upload="never"` makes JOSM refuse to upload the layer itself: stations are
 * copied into the data layer one by one, after checking them.
 */
import { ADAPTER_NAME, ADAPTER_VERSION } from './version.ts'

interface Feature {
  geometry: { coordinates: [number, number] }
  properties: { ref: string; tags: Record<string, string> }
}

interface Collection {
  metadata: { ref_key: string; default_tags?: Record<string, string> }
  features: Feature[]
}

const escape = (s: string): string =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
    .replace(/\n/g, '&#10;')
    .replace(/\r/g, '&#13;')
    .replace(/\t/g, '&#9;')

/** The tags a candidate ends up with in OpenStreetMap (osm-charge-review FORMAT.md). */
export function finalTags(doc: Collection, f: Feature): Record<string, string> {
  return {
    ...doc.metadata.default_tags,
    ...f.properties.tags,
    [doc.metadata.ref_key]: f.properties.ref,
  }
}

export function toOsmXml(doc: Collection): string {
  const lines = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<osm version="0.6" generator="${ADAPTER_NAME} ${ADAPTER_VERSION}" upload="never">`,
  ]
  doc.features.forEach((f, i) => {
    const [lon, lat] = f.geometry.coordinates
    lines.push(`  <node id="${-(i + 1)}" lat="${lat.toFixed(7)}" lon="${lon.toFixed(7)}">`)
    for (const [k, v] of Object.entries(finalTags(doc, f)).sort(([a], [b]) => (a < b ? -1 : 1)))
      lines.push(`    <tag k="${escape(k)}" v="${escape(v)}"/>`)
    lines.push('  </node>')
  })
  lines.push('</osm>')
  return lines.join('\n') + '\n'
}
