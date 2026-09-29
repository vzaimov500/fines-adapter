import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, test } from 'vitest'
import {
  HttpError,
  parseMaxAge,
  parseRetryAfter,
  politeGet,
  type PoliteFetchOptions,
} from '../src/http.ts'

const URL_ = 'https://feed.example/v1/locations.geojson'
const UA = 'fines-adapter/0.1.0 (+https://github.com/vzaimov500/fines-adapter)'

type Reply = { status: number; body?: string; headers?: Record<string, string> } | Error

/** Scripted fake server + fake clock. Records every request. */
function harness(replies: Reply[]) {
  let t = Date.parse('2026-09-29T00:00:00Z')
  const requests: { headers: Record<string, string> }[] = []
  const sleeps: number[] = []
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    requests.push({ headers: init.headers as Record<string, string> })
    const r = replies.shift()
    if (!r) throw new Error('unexpected request')
    if (r instanceof Error) throw r
    return new Response(r.status === 304 ? null : (r.body ?? ''), {
      status: r.status,
      headers: r.headers,
    })
  }) as typeof fetch
  return {
    requests,
    sleeps,
    advance: (ms: number) => (t += ms),
    opts: (cacheDir: string, extra: Partial<PoliteFetchOptions> = {}): PoliteFetchOptions => ({
      cacheDir,
      userAgent: UA,
      fetchImpl,
      now: () => t,
      sleep: async (ms) => {
        sleeps.push(ms)
        t += ms
      },
      ...extra,
    }),
  }
}

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fines-http-'))
})

describe('politeGet', () => {
  test('first fetch sends an honest User-Agent and caches the body', async () => {
    const h = harness([
      { status: 200, body: 'v1', headers: { etag: 'W/"a"', 'cache-control': 'max-age=14400' } },
    ])
    const r = await politeGet(URL_, h.opts(dir))
    expect(r).toMatchObject({ body: 'v1', source: 'network' })
    expect(h.requests[0]!.headers['User-Agent']).toBe(UA)
    expect(h.requests[0]!.headers['If-None-Match']).toBeUndefined()
  })

  test('a fresh cache makes no request at all', async () => {
    const h = harness([{ status: 200, body: 'v1', headers: { 'cache-control': 'max-age=14400' } }])
    await politeGet(URL_, h.opts(dir))
    h.advance(60 * 60_000)
    const r = await politeGet(URL_, h.opts(dir))
    expect(r.source).toBe('cache-fresh')
    expect(h.requests).toHaveLength(1)
  })

  test('the minimum interval holds even with --force', async () => {
    const h = harness([{ status: 200, body: 'v1' }])
    await politeGet(URL_, h.opts(dir))
    h.advance(60_000)
    expect((await politeGet(URL_, h.opts(dir, { force: true }))).source).toBe('cache-fresh')
    expect(h.requests).toHaveLength(1)
  })

  test('a stale cache revalidates conditionally; 304 reuses the body', async () => {
    const h = harness([
      {
        status: 200,
        body: 'v1',
        headers: {
          etag: 'W/"a"',
          'last-modified': 'Mon, 28 Sep 2026 21:32:04 GMT',
          'cache-control': 'max-age=600',
        },
      },
      { status: 304, headers: { 'cache-control': 'max-age=600' } },
    ])
    await politeGet(URL_, h.opts(dir))
    h.advance(20 * 60_000)
    const r = await politeGet(URL_, h.opts(dir))
    expect(r).toMatchObject({ body: 'v1', source: 'revalidated' })
    expect(h.requests[1]!.headers['If-None-Match']).toBe('W/"a"')
    expect(h.requests[1]!.headers['If-Modified-Since']).toBe('Mon, 28 Sep 2026 21:32:04 GMT')
  })

  test('--force revalidates a fresh cache once the minimum interval has passed', async () => {
    const h = harness([
      { status: 200, body: 'v1', headers: { 'cache-control': 'max-age=14400' } },
      { status: 200, body: 'v2' },
    ])
    await politeGet(URL_, h.opts(dir))
    h.advance(10 * 60_000)
    expect((await politeGet(URL_, h.opts(dir, { force: true }))).body).toBe('v2')
  })

  test('retries 503 with exponential backoff, then succeeds', async () => {
    const h = harness([{ status: 503 }, new TypeError('fetch failed'), { status: 200, body: 'ok' }])
    const r = await politeGet(URL_, h.opts(dir))
    expect(r.body).toBe('ok')
    expect(h.sleeps).toEqual([10_000, 30_000])
  })

  test('honours Retry-After on 429', async () => {
    const h = harness([
      { status: 429, headers: { 'retry-after': '120' } },
      { status: 200, body: 'ok' },
    ])
    await politeGet(URL_, h.opts(dir))
    expect(h.sleeps).toEqual([120_000])
  })

  test('does not retry 4xx', async () => {
    const h = harness([{ status: 404 }])
    await expect(politeGet(URL_, h.opts(dir))).rejects.toThrow(HttpError)
    expect(h.requests).toHaveLength(1)
  })

  test('a 4xx with a cache records the attempt so the next run waits', async () => {
    const h = harness([{ status: 200, body: 'v1' }, { status: 403 }])
    await politeGet(URL_, h.opts(dir))
    h.advance(10 * 60_000)
    await expect(politeGet(URL_, h.opts(dir))).rejects.toThrow(/403/)
    h.advance(60_000)
    expect((await politeGet(URL_, h.opts(dir))).source).toBe('cache-fresh')
  })

  test('persistent failure falls back to the last good copy', async () => {
    const h = harness([
      { status: 200, body: 'v1' },
      { status: 500 },
      { status: 502 },
      { status: 503 },
    ])
    await politeGet(URL_, h.opts(dir))
    h.advance(10 * 60_000)
    const r = await politeGet(URL_, h.opts(dir))
    expect(r).toMatchObject({ body: 'v1', source: 'cache-stale' })
    expect(h.requests).toHaveLength(4)
  })

  test('persistent failure without cache throws after maxAttempts', async () => {
    const h = harness([{ status: 500 }, { status: 500 }])
    await expect(politeGet(URL_, h.opts(dir, { maxAttempts: 2 }))).rejects.toThrow(
      /after 2 attempts/,
    )
  })

  test('offline uses the cache and never the network', async () => {
    const h = harness([{ status: 200, body: 'v1' }])
    await politeGet(URL_, h.opts(dir))
    expect((await politeGet(URL_, h.opts(dir, { offline: true }))).source).toBe('cache-offline')
    await expect(
      politeGet(URL_, h.opts(mkdtempSync(join(tmpdir(), 'x-')), { offline: true })),
    ).rejects.toThrow(/offline/)
    expect(h.requests).toHaveLength(1)
  })

  test('uses real timers and fetch defaults when not injected', async () => {
    // Only exercises the defaults' wiring; offline so nothing is requested.
    await expect(politeGet(URL_, { cacheDir: dir, userAgent: UA, offline: true })).rejects.toThrow(
      /offline/,
    )
  })
})

describe('header parsing', () => {
  test.each([
    ['public, max-age=14400, s-maxage=300', 14400],
    ['no-cache', 0],
    ['private, no-store', 0],
    ['public', undefined],
    [null, undefined],
  ])('parseMaxAge(%j) = %j', (h, v) => expect(parseMaxAge(h)).toBe(v))

  test.each([
    ['120', 120_000],
    ['99999', 300_000],
    ['Tue, 29 Sep 2026 00:01:00 GMT', 60_000],
    ['Mon, 28 Sep 2026 00:00:00 GMT', 0],
    ['soon', undefined],
    [null, undefined],
  ])('parseRetryAfter(%j) = %j', (h, v) =>
    expect(parseRetryAfter(h, Date.parse('2026-09-29T00:00:00Z'))).toBe(v),
  )
})
