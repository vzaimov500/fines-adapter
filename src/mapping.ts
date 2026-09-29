/**
 * Fines feed → OpenStreetMap tags. Pure functions; every rule here is
 * documented in MAPPING.md, which is what the import wiki page should link.
 *
 * Principle (osm-charge-review FORMAT.md): map only what is certain. Anything
 * uncertain is left out and explained to the reviewer in `notes`.
 */
import type { FinesLocation } from './fines.ts'

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

/** Above this, an advertised power is implausible enough to leave out and flag. */
export const MAX_PLAUSIBLE_KW = 500
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

export function mapLocation(loc: FinesLocation): MappedLocation {
  const tags: Record<string, string> = {}
  const notes: string[] = []

  // Sockets: count per type.
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
    if (kw > MAX_PLAUSIBLE_KW) {
      notes.push(
        `feed advertises ${formatKw(kw)}, which is implausible for a single connector — output not tagged`,
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
