#!/usr/bin/env node
/**
 * fines-adapter — fetch the Fines Charging public locations feed (politely) and
 * write an osm-charge-review interchange file.
 *
 *   pnpm start [--out FILE] [--offline] [--force] [--config FILE]
 *              [--licence ID] [--permission-url URL] [--ref-key KEY] [--contact TEXT]
 *              [--osm]
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { parseArgs } from 'node:util'
import { buildCollection, DATASET_ID, validateCollection, type EmitOptions } from './emit.ts'
import { FINES_LOCATIONS_URL, parseFinesFeed } from './fines.ts'
import { toOsmXml } from './osmxml.ts'
import { politeGet } from './http.ts'
import { ADAPTER_NAME, ADAPTER_URL, ADAPTER_VERSION } from './version.ts'

const { values: args } = parseArgs({
  options: {
    out: { type: 'string', default: `out/${DATASET_ID}.geojson` },
    offline: { type: 'boolean', default: false },
    force: { type: 'boolean', default: false },
    config: { type: 'string' },
    licence: { type: 'string' },
    'permission-url': { type: 'string' },
    'ref-key': { type: 'string' },
    contact: { type: 'string', default: process.env.FINES_ADAPTER_CONTACT },
    'cache-dir': { type: 'string', default: '.cache' },
    osm: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
})

if (args.help) {
  console.log(`${ADAPTER_NAME} ${ADAPTER_VERSION}
  --out FILE             output path (default out/${DATASET_ID}.geojson)
  --offline              use the cached feed only; no network
  --force                revalidate even if the cached copy is fresh (still at most one request per 5 min)
  --config FILE          JSON: { "defaultTags": {...}, "licence": "...", "permissionUrl": "...", "refKey": "..." }
  --licence ID           SPDX id or LicenseRef-* (default LicenseRef-pending)
  --permission-url URL   where the data permission is documented
  --ref-key KEY          OSM key for the Fines id (default ref:fines)
  --contact TEXT         contact added to the User-Agent (or env FINES_ADAPTER_CONTACT)
  --osm                  also write a JOSM reference layer (.osm, upload="never") next to --out`)
  process.exit(0)
}

const log = (m: string) => console.error(`[${ADAPTER_NAME}] ${m}`)

// Honest identification (OSM/API etiquette): tool, version, where to find it, optional contact.
const userAgent = `${ADAPTER_NAME}/${ADAPTER_VERSION} (+${ADAPTER_URL}${args.contact ? `; ${args.contact}` : ''})`

const config: Partial<EmitOptions> = args.config
  ? JSON.parse(await readFile(args.config, 'utf8'))
  : {}

const res = await politeGet(FINES_LOCATIONS_URL, {
  cacheDir: args['cache-dir'],
  userAgent,
  accept: 'application/geo+json, application/json;q=0.9',
  force: args.force,
  offline: args.offline,
  log,
})

const feed = parseFinesFeed(JSON.parse(res.body))
const opts: EmitOptions = { ...config, retrievedAt: res.fetchedAt }
if (args.licence) opts.licence = args.licence
if (args['permission-url']) opts.permissionUrl = args['permission-url']
if (args['ref-key']) opts.refKey = args['ref-key']

const doc = buildCollection(feed, opts)
const errors = validateCollection(doc)
if (errors.length > 0) {
  log(
    `output fails the interchange schema — not writing it:\n  ${errors.slice(0, 20).join('\n  ')}`,
  )
  process.exit(1)
}

await mkdir(dirname(args.out), { recursive: true })
await writeFile(args.out, JSON.stringify(doc, null, 2) + '\n')

const features = doc.features as { properties: { notes?: string; tags: Record<string, string> } }[]
const withNotes = features.filter((f) => f.properties.notes).length
log(`feed generated ${feed.generatedAt}, ${res.source}`)
log(`wrote ${features.length} candidates to ${args.out} (${withNotes} with notes for the reviewer)`)
if (args.osm) {
  const osmPath = args.out.replace(/\.(geo)?json$/, '') + '.osm'
  await writeFile(osmPath, toOsmXml(doc as unknown as Parameters<typeof toOsmXml>[0]))
  log(
    `wrote a JOSM reference layer to ${osmPath} (JOSM will not upload it; copy stations after checking)`,
  )
}
if ((doc.metadata as { licence: string }).licence === 'LicenseRef-pending') {
  log(
    'licence: LicenseRef-pending — the feed publishes no licence. Review is possible; live upload stays blocked until permission is documented.',
  )
}
