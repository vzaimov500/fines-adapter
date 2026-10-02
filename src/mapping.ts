/**
 * Fines feed → OpenStreetMap tags. Pure functions; every rule here is
 * documented in MAPPING.md, which is what the import wiki page should link.
 *
 * Principle (osm-charge-review FORMAT.md): map only what is certain. Anything
 * uncertain is left out and explained to the reviewer in `notes`.
 */
import type { FinesConnector, FinesLocation } from './fines.ts'

/**
 * Plug type labels as they appear in the feed → OSM socket key.
 * Keys verified against https://wiki.openstreetmap.org/wiki/Key:socket.
 */
export const SOCKET_KEYS: Readonly<Record<string, string>> = {
  'CCS Combo 2 Plug (Cable Attached)': 'socket:type2_combo',
  'CCS Combo 1 Plug (Cable Attached)': 'socket:type1_combo',
  'Type 2 Outlet': 'socket:type2',
  'Type 2 Connector (Cable Attached)': 'socket:type2_cable',
  CHAdeMO: 'socket:chademo',
}

/** Plug types we deliberately do not map, with the reason shown to the reviewer. */
export const UNMAPPED_PLUGS: Readonly<Record<string, string>> = {
  'Type 3 Outlet':
    'feed lists a "Type 3 Outlet"; OSM requires socket:type3a or socket:type3c and the feed does not say which — not tagged, please survey',
  'Small Paddle Inductive':
    'feed lists a "Small Paddle Inductive" connector (obsolete Magne Charge); probably a data-entry error at a modern station — not tagged',
}

/** Above this, an advertised DC power is implausible enough to leave out and flag. */
export const MAX_PLAUSIBLE_KW = 1000
/**
 * The location summary gives one maximum for the whole site. Above this it may
 * well belong to an MCS truck connector that Fines lists under a CCS plug type.
 */
export const SUMMARY_MAX_KW = 500
/** Megawatt Charging System (trucks): up to 3750 kW by specification. */
export const MCS_MAX_KW = 3750
/** Fines lists MCS connectors under a CCS plug type; only the connector name says "MCS". */
const MCS_NAME = /\bMCS\b/i
/** DC plugs: a connector *named* "AC …" with one of these is a contradiction in the feed. */
export const DC_SOCKETS: ReadonlySet<string> = new Set([
  'socket:type2_combo',
  'socket:type1_combo',
  'socket:chademo',
  'socket:mcs',
])
/** AC sockets (Type 2) cannot deliver more than 43 kW (3-phase, 63 A). */
export const AC_SOCKETS: ReadonlySet<string> = new Set(['socket:type2', 'socket:type2_cable'])
export const AC_MAX_KW = 43

export interface MappedLocation {
  tags: Record<string, string>
  notes: string[]
}

/** "22 kW", "7.4 kW" — OSM convention: number, space, unit; no trailing zeros. */
export function formatKw(kw: number): string {
  return `${Number(kw.toFixed(2))} kW`
}

const label = (socket: string): string => socket.slice('socket:'.length)

const maxKwFor = (socket: string): number =>
  AC_SOCKETS.has(socket) ? AC_MAX_KW : socket === 'socket:mcs' ? MCS_MAX_KW : MAX_PLAUSIBLE_KW

/**
 * Map one location. With its per-connector list (from /v1/live.json), socket
 * counts and powers come from the connectors themselves; without it, or when
 * it disagrees with the location summary, only the summary is used.
 */
/**
 * The feed's site label without the brand ("FINES Gelemenovo" → "Gelemenovo"):
 * which location of the brand this is. The brand itself is tagged as `brand`.
 */
export function branchFromName(name: string | null): string | undefined {
  if (name === null) return undefined
  const branch = name
    .trim()
    .replace(/^fines\b[\s\-–:]*/i, '')
    .replace(/\s+/g, ' ')
    .trim()
  return branch || undefined
}

export function mapLocation(
  loc: FinesLocation,
  connectors?: readonly FinesConnector[],
): MappedLocation {
  const tags: Record<string, string> = {}
  const notes: string[] = []

  const branch = branchFromName(loc.name)
  if (branch) tags.branch = branch

  if (connectors !== undefined && matchesSummary(loc, connectors, notes))
    socketsFromConnectors(connectors, tags, notes)
  else socketsFromSummary(loc, tags, notes)

  // Access: `restricted: false` is documented as "not restricted or conditional".
  if (loc.restricted) {
    notes.push(
      'feed marks access as restricted or conditional (e.g. customers or residents only) — access not tagged, please check',
    )
  } else {
    tags.access = 'yes'
  }

  // Fee: a price range means charging costs money; a zero range means free.
  if (loc.priceRange !== null) {
    if (loc.priceRange.max > 0) tags.fee = 'yes'
    else if (loc.priceRange.min === 0 && loc.priceRange.max === 0) tags.fee = 'no'
  }

  return { tags, notes }
}

/** The per-connector list must count the same plug types as the location summary. */
function matchesSummary(
  loc: FinesLocation,
  connectors: readonly FinesConnector[],
  notes: string[],
): boolean {
  const counted: Record<string, number> = {}
  for (const c of connectors) counted[c.plugType] = (counted[c.plugType] ?? 0) + 1
  const summary = Object.entries(loc.connectors).filter(([, n]) => n > 0)
  const same =
    summary.length === Object.keys(counted).length &&
    summary.every(([plug, n]) => counted[plug] === n)
  if (!same)
    notes.push(
      'the per-connector list does not match the location summary — per-connector power not used',
    )
  return same
}

/** Counts and powers per socket type, connector by connector. */
function socketsFromConnectors(
  connectors: readonly FinesConnector[],
  tags: Record<string, string>,
  notes: string[],
): void {
  const powers = new Map<string, (number | null)[]>()
  const unmapped = new Map<string, number>()
  for (const c of connectors) {
    const isMcs = c.name !== null && MCS_NAME.test(c.name)
    const socket = isMcs ? 'socket:mcs' : SOCKET_KEYS[c.plugType]
    if (socket === undefined) {
      unmapped.set(c.plugType, (unmapped.get(c.plugType) ?? 0) + 1)
      continue
    }
    if (DC_SOCKETS.has(socket) && c.name !== null && /^AC\b/i.test(c.name)) {
      notes.push(
        `connector "${c.name.trim()}" is listed as ${c.plugType}, a DC plug — the plug type looks wrong; not tagged, please survey`,
      )
      continue
    }
    if (isMcs && c.plugType !== 'MCS')
      notes.push(`connector "${c.name!.trim()}" is listed as ${c.plugType}; tagged as socket:mcs`)
    powers.set(socket, [...(powers.get(socket) ?? []), c.maxPowerKw])
  }
  for (const [plug, n] of unmapped)
    notes.push(UNMAPPED_PLUGS[plug] ?? `unknown plug type "${plug}" ×${n} in feed — not tagged`)
  if (powers.size === 0) notes.push('no connector type could be mapped; socket tags need a survey')

  for (const [socket, kws] of powers) {
    tags[socket] = String(kws.length)
    if (kws.some((kw) => kw === null)) {
      notes.push(`power missing for some ${label(socket)} connectors — output not tagged`)
      continue
    }
    const max = maxKwFor(socket)
    const tooHigh = (kws as number[]).filter((kw) => kw > max)
    if (tooHigh.length > 0) {
      notes.push(
        `feed advertises ${formatKw(Math.max(...tooHigh))} on a ${label(socket)} connector (plausible up to ${max} kW) — output not tagged`,
      )
      continue
    }
    // Several powers: all of them, highest first, as mappers here already write it.
    const distinct = [...new Set(kws as number[])].sort((a, b) => b - a)
    tags[`${socket}:output`] = distinct.map(formatKw).join(';')
  }
}

/** Only the location summary: counts per plug type and one maximum for the whole site. */
function socketsFromSummary(
  loc: FinesLocation,
  tags: Record<string, string>,
  notes: string[],
): void {
  const mappedTypes: string[] = []
  let hasUnmapped = false
  for (const [plug, count] of Object.entries(loc.connectors)) {
    if (count === 0) continue
    const key = SOCKET_KEYS[plug]
    if (key !== undefined) {
      tags[key] = String(count)
      mappedTypes.push(key)
    } else {
      hasUnmapped = true
      notes.push(
        UNMAPPED_PLUGS[plug] ?? `unknown plug type "${plug}" ×${count} in feed — not tagged`,
      )
    }
  }
  if (mappedTypes.length === 0)
    notes.push('no connector type could be mapped; socket tags need a survey')

  // Output: the feed gives only the highest connector power for the whole
  // location. It can be attributed to a socket type only when there is exactly
  // one type and nothing unmapped.
  const kw = loc.maxPowerKw
  if (kw !== null) {
    if (kw > SUMMARY_MAX_KW) {
      notes.push(
        `feed gives only the location maximum (${formatKw(kw)}), too high to attribute to a car connector without the per-connector list — output not tagged`,
      )
    } else if (mappedTypes.length === 1 && !hasUnmapped) {
      const socket = mappedTypes[0]!
      if (AC_SOCKETS.has(socket) && kw > AC_MAX_KW) {
        notes.push(
          `feed advertises ${formatKw(kw)} for an AC ${socket.slice(7)} socket (max ${AC_MAX_KW} kW) — output not tagged`,
        )
      } else {
        tags[`${socket}:output`] = formatKw(kw)
      }
    } else {
      notes.push(
        `feed gives only the location maximum (${formatKw(kw)}); cannot attribute it to one socket type — output not tagged`,
      )
    }
  }
}
