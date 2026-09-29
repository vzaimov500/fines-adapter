/**
 * A deliberately polite HTTP GET with an on-disk cache.
 *
 * - Honest, identifying User-Agent (never a browser imitation).
 * - Fresh cache (Cache-Control max-age, and a minimum interval floor) → no request at all.
 * - Stale cache → conditional request (If-None-Match / If-Modified-Since); a 304 costs the server almost nothing.
 * - Timeouts on every request.
 * - Retries only for network errors, 429 and 5xx, with backoff that honours Retry-After.
 * - On persistent failure, falls back to the last good response, as the Fines docs ask.
 */
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export interface PoliteFetchOptions {
  cacheDir: string
  userAgent: string
  accept?: string
  /** Per-attempt timeout. Default 60 s. */
  timeoutMs?: number
  /** Total attempts including the first. Default 3. */
  maxAttempts?: number
  /** Never contact the server more often than this, even with --force. Default 300 s. */
  minIntervalS?: number
  /** Ignore max-age freshness (still sends a conditional request and respects minIntervalS). */
  force?: boolean
  /** Never touch the network; use the cache or fail. */
  offline?: boolean
  fetchImpl?: typeof fetch
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  log?: (msg: string) => void
}

export interface PoliteResponse {
  body: string
  /** When the body was last confirmed current by the server (ISO 8601). */
  fetchedAt: string
  source: 'network' | 'revalidated' | 'cache-fresh' | 'cache-stale' | 'cache-offline'
}

interface CacheMeta {
  url: string
  fetchedAt: number
  lastAttemptAt: number
  etag?: string
  lastModified?: string
  maxAgeS?: number
}

export class HttpError extends Error {
  override name = 'HttpError'
  readonly status: number | undefined
  constructor(message: string, status?: number) {
    super(message)
    this.status = status
  }
}

const RETRY_BASE_MS = 10_000
const RETRY_CAP_MS = 5 * 60_000

export function parseMaxAge(cacheControl: string | null): number | undefined {
  if (!cacheControl) return undefined
  if (/(?:^|,)\s*(?:no-store|no-cache)\b/i.test(cacheControl)) return 0
  const m = /(?:^|,)\s*max-age\s*=\s*(\d+)/i.exec(cacheControl)
  return m ? Number(m[1]) : undefined
}

/** Retry-After as delta-seconds or HTTP date → milliseconds, capped. */
export function parseRetryAfter(value: string | null, now: number): number | undefined {
  if (!value) return undefined
  const ms = /^\d+$/.test(value.trim()) ? Number(value) * 1000 : Date.parse(value) - now
  return Number.isFinite(ms) ? Math.min(Math.max(ms, 0), RETRY_CAP_MS) : undefined
}

export async function politeGet(url: string, opts: PoliteFetchOptions): Promise<PoliteResponse> {
  const fetchImpl = opts.fetchImpl ?? fetch
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const now = opts.now ?? Date.now
  const log = opts.log ?? (() => {})
  const timeoutMs = opts.timeoutMs ?? 60_000
  const maxAttempts = opts.maxAttempts ?? 3
  const minIntervalMs = (opts.minIntervalS ?? 300) * 1000

  const key = createHash('sha256').update(url).digest('hex').slice(0, 24)
  const metaPath = join(opts.cacheDir, `${key}.meta.json`)
  const bodyPath = join(opts.cacheDir, `${key}.body`)
  const meta = await readJson<CacheMeta>(metaPath)
  const cachedBody = meta ? await readFile(bodyPath, 'utf8').catch(() => undefined) : undefined
  const cached = meta && cachedBody !== undefined ? { meta, body: cachedBody } : undefined
  const iso = (t: number) => new Date(t).toISOString()

  if (opts.offline) {
    if (!cached) throw new HttpError(`offline and no cached copy of ${url}`)
    return { body: cached.body, fetchedAt: iso(cached.meta.fetchedAt), source: 'cache-offline' }
  }
  if (cached) {
    const age = now() - cached.meta.fetchedAt
    const fresh =
      !opts.force && cached.meta.maxAgeS !== undefined && age < cached.meta.maxAgeS * 1000
    const tooSoon = now() - cached.meta.lastAttemptAt < minIntervalMs
    if (fresh || tooSoon) {
      log(
        `using cached copy (${Math.round(age / 1000)} s old${tooSoon && !fresh ? '; minimum interval not yet elapsed' : ''})`,
      )
      return { body: cached.body, fetchedAt: iso(cached.meta.fetchedAt), source: 'cache-fresh' }
    }
  }

  await mkdir(opts.cacheDir, { recursive: true })
  const headers: Record<string, string> = {
    'User-Agent': opts.userAgent,
    Accept: opts.accept ?? '*/*',
  }
  if (cached?.meta.etag) headers['If-None-Match'] = cached.meta.etag
  if (cached?.meta.lastModified) headers['If-Modified-Since'] = cached.meta.lastModified

  let lastError: unknown
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const attemptAt = now()
    let retryAfterMs: number | undefined
    try {
      log(`GET ${url} (attempt ${attempt}/${maxAttempts})`)
      const res = await fetchImpl(url, {
        headers,
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'follow',
      })
      const common = {
        url,
        lastAttemptAt: attemptAt,
        maxAgeS: parseMaxAge(res.headers.get('cache-control')),
      }
      if (res.status === 304 && cached) {
        await writeJson(metaPath, { ...cached.meta, ...common, fetchedAt: attemptAt })
        log('304 Not Modified — cached copy is current')
        return { body: cached.body, fetchedAt: iso(attemptAt), source: 'revalidated' }
      }
      if (res.ok) {
        const body = await res.text()
        const m: CacheMeta = { ...common, fetchedAt: attemptAt }
        const etag = res.headers.get('etag')
        const lastModified = res.headers.get('last-modified')
        if (etag) m.etag = etag
        if (lastModified) m.lastModified = lastModified
        await writeFile(bodyPath, body)
        await writeJson(metaPath, m)
        log(`${res.status} — ${body.length} bytes`)
        return { body, fetchedAt: iso(attemptAt), source: 'network' }
      }
      if (res.status !== 429 && res.status < 500) {
        // Client errors will not fix themselves; do not hammer.
        if (cached) await writeJson(metaPath, { ...cached.meta, lastAttemptAt: attemptAt })
        throw new HttpError(`${res.status} ${res.statusText} for ${url}`, res.status)
      }
      retryAfterMs = parseRetryAfter(res.headers.get('retry-after'), now())
      lastError = new HttpError(`${res.status} ${res.statusText} for ${url}`, res.status)
    } catch (e) {
      if (e instanceof HttpError && e.status !== undefined && e.status !== 429 && e.status < 500)
        throw e
      lastError = e
    }
    if (attempt < maxAttempts) {
      const delay = retryAfterMs ?? Math.min(RETRY_BASE_MS * 3 ** (attempt - 1), RETRY_CAP_MS)
      log(
        `request failed (${describe(lastError)}); waiting ${Math.round(delay / 1000)} s before retrying`,
      )
      await sleep(delay)
    }
  }

  if (cached) {
    await writeJson(metaPath, { ...cached.meta, lastAttemptAt: now() })
    log(`giving up after ${maxAttempts} attempts (${describe(lastError)}); using last good copy`)
    return { body: cached.body, fetchedAt: iso(cached.meta.fetchedAt), source: 'cache-stale' }
  }
  throw new HttpError(`failed after ${maxAttempts} attempts: ${describe(lastError)}`)
}

function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T
  } catch {
    return undefined
  }
}

async function writeJson(path: string, v: unknown): Promise<void> {
  await writeFile(path, JSON.stringify(v, null, 2))
}
