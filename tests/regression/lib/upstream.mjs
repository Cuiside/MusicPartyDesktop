/**
 * Synthetic NetEase Cloud Music upstream API (mock HTTP server).
 *
 * The music server under test is started with
 * `--app.music-api.netease.base-url=http://127.0.0.1:<port>` and talks to this server
 * instead of the real NCM API. It is deterministic and records every request so tests
 * can assert which cookie was actually used, whether the legacy `/song/url` fallback was
 * tried, and so on. No real credential/network is involved.
 *
 * Important: the `data[0].id` of the legacy `/song/url` response uses the REQUESTED music
 * id (the deployed JAR adopts the response entry id, so a mismatched fixture id would
 * make state assertions ambiguous).
 */
import http from 'node:http'

const SONG_DURATION_MS = 120000

function songFor(id, { duration = SONG_DURATION_MS } = {}) {
  return {
    id,
    name: `Fixture ${id}`,
    dt: duration,
    ar: [{ name: 'Fixture Artist' }],
    artists: [{ name: 'Fixture Artist' }],
    al: { picUrl: 'https://example.invalid/cover.jpg' },
    fee: 0
  }
}

function urlEntry(id, { url, time = SONG_DURATION_MS, freeTrialInfo = null, code = 200 } = {}) {
  return { id, code, url, time, freeTrialInfo }
}

/** `ok` fixture: both endpoints return a usable full URL (v1 preferred). */
function fullBehavior(id) {
  return {
    v1: { code: 200, data: [urlEntry(id, { url: `https://fixture.invalid/${id}.mp3` })] },
    legacy: { code: 200, data: [urlEntry(id, { url: `https://fixture.invalid/${id}-legacy.mp3` })] }
  }
}

/** Trial: v1 returns a 30s preview URL of a 120s song, plus freeTrialInfo. */
function trialBehavior(id) {
  return {
    v1: {
      code: 200,
      data: [
        urlEntry(id, {
          url: `https://fixture.invalid/${id}-30s.mp3`,
          time: 30000,
          freeTrialInfo: { start: 0, end: 30 }
        })
      ]
    },
    legacy: {
      code: 200,
      data: [urlEntry(id, { url: `https://fixture.invalid/${id}-30s.mp3`, time: 30000 })]
    }
  }
}

/**
 * Default fixtures keyed by the music id used in `/app/enqueue`.
 * Each fixture defines what `/song/url/v1` (v1) and the legacy `/song/url` return.
 */
export const FIXTURES = {
  /** Complete track: v1 returns a normal full-length URL. */
  full: () => fullBehavior('full'),
  /** Trial track: 30s trial URL + freeTrialInfo; detail duration is 120s. */
  trial: () => trialBehavior('trial'),
  /** v1 returns `url: null` (must be treated as unusable → legacy fallback). */
  nullurl: () => ({
    v1: { code: 200, data: [urlEntry('nullurl', { url: null, time: 0 })] },
    legacy: { code: 200, data: [urlEntry('nullurl', { url: 'https://fixture.invalid/nullurl-legacy.mp3' })] }
  }),
  /** Both endpoints return `data: []` → structured failure, no NPE leak. */
  emptyarr: () => ({ v1: { code: 200, data: [] }, legacy: { code: 200, data: [] } }),
  /** v1 responds HTTP 404 but legacy endpoint works → fallback must be used. */
  fallback: () => ({
    v1: { status: 404, body: { code: 404, msg: 'not found' } },
    legacy: { code: 200, data: [urlEntry('fallback', { url: 'https://fixture.invalid/fallback-legacy.mp3' })] }
  }),
  /** v1 returns a non-http(s) URL → must not be played as-is. */
  nonhttp: () => ({
    v1: { code: 200, data: [urlEntry('nonhttp', { url: 'not-a-valid-url', time: SONG_DURATION_MS })] },
    legacy: { code: 200, data: [urlEntry('nonhttp', { url: 'https://fixture.invalid/nonhttp-legacy.mp3' })] }
  }),
  /** v1 entry has business code 404 and a null URL → legacy fallback. */
  itemcode: () => ({
    v1: { code: 200, data: [urlEntry('itemcode', { url: null, code: 404 })] },
    legacy: { code: 200, data: [urlEntry('itemcode', { url: 'https://fixture.invalid/itemcode-legacy.mp3' })] }
  }),
  /** v1 business failure (top-level code != 200) → legacy fallback. */
  bizcode: () => ({
    v1: { code: 404, message: 'no copyright' },
    legacy: { code: 200, data: [urlEntry('bizcode', { url: 'https://fixture.invalid/bizcode-legacy.mp3' })] }
  }),
  /** Both endpoints unusable → structured failure with UPSTREAM/INVALID ack. */
  bothfail: () => ({ v1: { status: 404, body: { code: 404 } }, legacy: { status: 404, body: { code: 404 } } }),
  /** v1 returns an empty-string URL → unusable → legacy fallback. */
  emptyurl: () => ({
    v1: { code: 200, data: [urlEntry('emptyurl', { url: '', time: SONG_DURATION_MS })] },
    legacy: { code: 200, data: [urlEntry('emptyurl', { url: 'https://fixture.invalid/emptyurl-legacy.mp3' })] }
  })
}

/**
 * Start the synthetic upstream.
 *
 * @param {number} port TCP port on 127.0.0.1.
 * @param {{ fixtures?: Record<string, () => object> }} [options]
 */
export async function startUpstream(port, options = {}) {
  const fixtures = { ...FIXTURES, ...(options.fixtures || {}) }
  /** @type {Array<{method:string,path:string,id:string,cookie:string,at:number}>} */
  const records = []
  const cookieProfileValid =
    options.cookieProfileValid ||
    ((cookie) => {
      const value = String(cookie || '')
      if (!value) return false
      // Pair-quotes / placeholders are treated as "no usable credential".
      if (/^["'\s]+$/.test(value)) return false
      if (value === '""' || value === "''") return false
      if (value.includes('invalid')) return false
      if (value.includes('YOUR_')) return false
      return value.includes('MUSIC_U=valid')
    })
  // Optional per-cookie validation result override (S-06 tests can change validity).
  let cookieValidOverride = null

  const server = http.createServer(async (request, response) => {
    const parsed = new URL(request.url, 'http://localhost')
    const id = parsed.searchParams.get('id') || parsed.searchParams.get('ids') || ''
    const cookie = parsed.searchParams.get('cookie') || ''
    const record = {
      method: request.method,
      path: parsed.pathname,
      id,
      cookie,
      params: Object.fromEntries(parsed.searchParams.entries()),
      at: Date.now()
    }
    records.push(record)

    const send = (status, body) => {
      response.writeHead(status, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify(body))
    }

    try {
      if (parsed.pathname === '/user/account') {
        const valid = cookieValidOverride === null ? cookieProfileValid(cookie) : cookieValidOverride
        send(200, {
          code: 200,
          profile: valid ? { userId: 10001, nickname: 'FixtureUser' } : null,
          account: valid ? { id: 10001 } : null
        })
        return
      }
      if (parsed.pathname === '/search' || parsed.pathname === '/cloudsearch') {
        const keyword = parsed.searchParams.get('keywords') || parsed.searchParams.get('s') || 'fixture'
        send(200, { code: 200, result: { songs: [songFor(`${keyword}-song`)] } })
        return
      }
      if (parsed.pathname === '/song/detail') {
        const ids = String(id).split(',')
        send(200, { code: 200, songs: ids.map((songId) => songFor(songId)) })
        return
      }
      if (parsed.pathname === '/lyric') {
        if (id === 'slow') await new Promise((resolve) => setTimeout(resolve, 350))
        send(200, { code: 200, lrc: { lyric: `[00:00.00]${id}` } })
        return
      }
      if (parsed.pathname === '/song/url/v1' || parsed.pathname === '/song/url') {
        const fixture = fixtures[id]
        const behavior = fixture ? fixture() : fullBehavior(id)
        const branch = parsed.pathname.endsWith('/v1') ? behavior.v1 : behavior.legacy
        if (branch.status && branch.status !== 200) {
          send(branch.status, branch.body || {})
          return
        }
        send(200, branch)
        return
      }
      if (parsed.pathname === '/user/playlist' || parsed.pathname === '/playlist/detail') {
        send(200, { code: 200, playlist: [] })
        return
      }
      if (parsed.pathname === '/inner/version' || parsed.pathname === '/version') {
        send(200, { code: 200, version: 'fixture-upstream-4.36.1' })
        return
      }
      send(200, { code: 200 })
    } catch (error) {
      send(500, { code: 500, message: String(error?.message || error) })
    }
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', resolve)
  })

  return {
    port,
    url: `http://127.0.0.1:${port}`,
    records,
    reset() {
      records.length = 0
    },
    /** Force the `/user/account` profile validity for the next calls (S-06). */
    setCookieValidOverride(value) {
      cookieValidOverride = value
    },
    /** All `/song/url*` records observed for a given id. */
    playUrlRecords(id) {
      return records.filter((record) => record.path.startsWith('/song/url') && (!id || record.id === id))
    },
    lastCookie(pathIncludes = '/search') {
      const matches = records.filter((record) => record.path.includes(pathIncludes))
      return matches.length ? matches[matches.length - 1].cookie : null
    },
    close() {
      return new Promise((resolve) => server.close(() => resolve()))
    }
  }
}
