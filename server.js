// Influence API: the beacon and influencer registry, live readings from the phone, the seek target
// ("find Kunal"), a live event stream for the map, and the same actions as MCP tools.
// No dependencies: Node 22's http, crypto and fetch.
import http from 'node:http'
import { createHmac, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'

// The launcher runs node directly, so npm's package variables are not set: read the version from package.json.
const VERSION = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version
const PORT = Number(process.env.PORT || 8080)
// Registry writes (influencers, beacons) need this key when it is set: header `Authorization: Bearer <key>`.
// Readings, the seek target, search and reads stay open so the phone, the glasses and the map need no key.
const WRITE_KEY = process.env.WRITE_KEY || ''
// Each influencer edits their own profile with a key derived from this secret (stable across restarts when set).
const PROFILE_SECRET = process.env.PROFILE_SECRET || WRITE_KEY || randomBytes(32).toString('hex')
// Optional Elasticsearch: the registry is written through to it and search runs on it.
const ES_URL = (process.env.ES_URL || '').replace(/\/$/, '')
const ES_AUTH = process.env.ES_AUTH || '' // "ApiKey <base64>" or "Basic <base64>"
// The Salt Palace Convention Center, Salt Lake City (the centre of OpenStreetMap's way 33149360): where the map
// opens and the demo walks.
const VENUE = { lat: 40.767437, lon: -111.8962966 }

const state = {
  influencers: new Map(),
  beacons: new Map(),
  seekers: new Map(), // id -> { lat, lon, accuracy, heading, at }
  readings: new Map(), // beaconId -> latest reading, with its estimate
  targets: new Map(), // seekerId -> { influencerId, beaconId, at }
}

// ---------- registry ----------

const slug = (s) => String(s || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40)
const now = () => new Date().toISOString()
const profileKey = (id) => createHmac('sha256', PROFILE_SECRET).update(`influencer:${id}`).digest('hex').slice(0, 20)

function upsertInfluencer(input, { keepId } = {}) {
  const id = keepId || slug(input.id || input.handle || input.name)
  if (!id) throw httpError(400, 'an influencer needs a name')
  const old = state.influencers.get(id) || {}
  const inf = {
    id,
    name: str(input.name ?? old.name, 60) || id,
    handle: str(input.handle ?? old.handle, 40),
    tagline: str(input.tagline ?? old.tagline, 140),
    bio: str(input.bio ?? old.bio, 600),
    imageUrl: url(input.imageUrl ?? old.imageUrl),
    color: color(input.color ?? old.color) || '#3DA992',
    emoji: str(input.emoji ?? old.emoji, 8),
    // How they show on the map and in the lens: each one theirs to turn off.
    show: { name: true, photo: true, tagline: true, distance: true, ...(old.show || {}), ...(input.show || {}) },
    visible: input.visible ?? old.visible ?? true,
    createdAt: old.createdAt || now(),
    updatedAt: now(),
  }
  state.influencers.set(id, inf)
  esPut('influence-influencers', id, inf)
  changed()
  return inf
}

function upsertBeacon(input, { keepId } = {}) {
  const id = keepId || slug(input.id || input.name || input.hardwareId)
  if (!id) throw httpError(400, 'a beacon needs a name')
  const old = state.beacons.get(id) || {}
  let influencerId = input.influencerId !== undefined ? input.influencerId : input.influencer !== undefined ? input.influencer : old.influencerId
  if (influencerId) {
    const inf = resolveInfluencer(influencerId)
    if (!inf) throw httpError(404, `no influencer named ${influencerId}`)
    influencerId = inf.id
  }
  const b = {
    id,
    name: str(input.name ?? old.name, 60) || id,
    // What the phone sees: the beacon's Bluetooth name, or the peripheral identifier iOS gave it.
    hardwareId: str(input.hardwareId ?? old.hardwareId, 80),
    influencerId: influencerId || null,
    createdAt: old.createdAt || now(),
    updatedAt: now(),
  }
  state.beacons.set(id, b)
  esPut('influence-beacons', id, b)
  changed()
  return b
}

function resolveInfluencer(q) {
  if (!q) return null
  const key = String(q).toLowerCase().replace(/^@/, '').trim()
  const list = [...state.influencers.values()]
  const exact = list.find((i) => i.id === slug(key) || i.name.toLowerCase() === key || (i.handle || '').toLowerCase().replace(/^@/, '') === key)
  if (exact) return exact
  const first = list.find((i) => i.name.toLowerCase().split(/\s+/)[0] === key.split(/\s+/)[0])
  if (first) return first
  // Speech recognition spells names its own way ("Kunaal", "Kelsie"): take the nearest within two edits.
  let best = null
  let bestD = 3
  for (const i of list) {
    for (const cand of [i.name.toLowerCase(), i.name.toLowerCase().split(/\s+/)[0], (i.handle || '').toLowerCase()]) {
      if (!cand) continue
      const d = lev(cand, key)
      if (d < bestD) (bestD = d), (best = i)
    }
  }
  return best
}

function resolveBeacon(q) {
  if (!q) return null
  const key = String(q).trim()
  return state.beacons.get(slug(key)) || [...state.beacons.values()].find((b) => b.hardwareId && b.hardwareId === key) || null
}

const beaconOf = (influencerId) => [...state.beacons.values()].find((b) => b.influencerId === influencerId) || null

// ---------- readings and positions ----------

// Where a reading puts the beacon: the phone's GPS position moved `distance` metres along the phone's compass
// heading plus the beacon's angle off the phone's forward axis. Without a direction, a circle around the phone.
function estimate(r, seeker) {
  const lat = num(r.lat) ?? seeker?.lat
  const lon = num(r.lon) ?? seeker?.lon
  if (lat == null || lon == null) return null
  const distance = num(r.distance)
  const heading = num(r.heading) ?? seeker?.heading
  const az = num(r.azimuthDeg)
  if (distance != null && heading != null && az != null) {
    const p = project(lat, lon, heading + az, distance)
    return { ...p, radius: Math.max(1, distance * 0.15), how: 'direction' }
  }
  return { lat, lon, radius: distance ?? 10, how: 'range' }
}

function project(lat, lon, bearingDeg, meters) {
  const R = 6371008.8
  const br = (bearingDeg * Math.PI) / 180
  const d = meters / R
  const p1 = (lat * Math.PI) / 180
  const l1 = (lon * Math.PI) / 180
  const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(br))
  const l2 = l1 + Math.atan2(Math.sin(br) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2))
  return { lat: (p2 * 180) / Math.PI, lon: ((((l2 * 180) / Math.PI) + 540) % 360) - 180 }
}

function addReading(input) {
  const seekerId = slug(input.seekerId || input.seeker || 'phone') || 'phone'
  if (num(input.lat) != null && num(input.lon) != null) setSeeker(seekerId, input, { quiet: true })
  let beacon = resolveBeacon(input.beaconId || input.beacon || input.hardwareId)
  if (!beacon && input.hardwareId) beacon = upsertBeacon({ name: input.hardwareId, hardwareId: input.hardwareId })
  if (!beacon) {
    // A reading for the current target needs no beacon id: the phone seeks what the target names.
    const t = state.targets.get(seekerId)
    beacon = t?.beaconId ? state.beacons.get(t.beaconId) : null
  }
  if (!beacon) throw httpError(404, 'the reading names no known beacon: send beaconId or hardwareId')
  const seeker = state.seekers.get(seekerId)
  const r = {
    beaconId: beacon.id,
    seekerId,
    distance: num(input.distance),
    azimuthDeg: num(input.azimuthDeg),
    elevationDeg: num(input.elevationDeg),
    heading: num(input.heading) ?? seeker?.heading ?? null,
    trend: str(input.trend, 20),
    at: now(),
  }
  r.estimate = estimate({ ...r, lat: input.lat, lon: input.lon }, seeker)
  state.readings.set(beacon.id, r)
  changed()
  return r
}

function setSeeker(id, input, { quiet } = {}) {
  const s = {
    id,
    name: str(input.name, 40) || state.seekers.get(id)?.name || id,
    lat: num(input.lat),
    lon: num(input.lon),
    accuracy: num(input.accuracy),
    heading: num(input.heading) ?? state.seekers.get(id)?.heading ?? null,
    at: now(),
  }
  if (s.lat == null || s.lon == null) throw httpError(400, 'a position needs lat and lon')
  state.seekers.set(id, s)
  if (!quiet) changed()
  return s
}

function setTarget(seekerId, who) {
  const sid = slug(seekerId || 'phone') || 'phone'
  if (!who) {
    state.targets.delete(sid)
    changed()
    return { seekerId: sid, target: null }
  }
  const inf = resolveInfluencer(who)
  const beacon = inf ? beaconOf(inf.id) : resolveBeacon(who)
  if (!inf && !beacon) throw httpError(404, `nobody named ${who} is registered`)
  const t = { seekerId: sid, influencerId: inf?.id || beacon?.influencerId || null, beaconId: beacon?.id || null, at: now() }
  state.targets.set(sid, t)
  changed()
  return describeTarget(t)
}

function describeTarget(t) {
  if (!t) return null
  const inf = t.influencerId ? state.influencers.get(t.influencerId) : null
  const beacon = t.beaconId ? state.beacons.get(t.beaconId) : null
  return {
    ...t,
    name: inf?.name || beacon?.name || null,
    hardwareId: beacon?.hardwareId || null,
    lastReading: beacon ? state.readings.get(beacon.id) || null : null,
    note: beacon ? null : `${inf?.name} has no beacon yet: map one in the registry`,
  }
}

function snapshot() {
  const influencers = [...state.influencers.values()].filter((i) => i.visible !== false)
  const beacons = [...state.beacons.values()].map((b) => {
    const inf = b.influencerId ? state.influencers.get(b.influencerId) : null
    return { ...b, influencer: inf && inf.visible !== false ? inf : null, reading: state.readings.get(b.id) || null }
  })
  const targets = [...state.targets.values()].map(describeTarget)
  return { version: VERSION, venue: VENUE, at: now(), influencers, beacons, seekers: [...state.seekers.values()], targets, demo: !!demo.timer }
}

// ---------- the live stream ----------

const clients = new Set()
let pending = null
function changed() {
  if (pending) return
  pending = setTimeout(() => {
    pending = null
    const data = `event: state\ndata: ${JSON.stringify(snapshot())}\n\n`
    for (const res of clients) res.write(data)
  }, 200)
}
setInterval(() => {
  for (const res of clients) res.write(': keep-alive\n\n')
}, 15000).unref()

// ---------- a demo walk, for when no beacon is in the room ----------

const demo = { timer: null, t: 0 }
function setDemo(on) {
  if (on && !demo.timer) {
    demo.timer = setInterval(() => {
      demo.t += 1
      const seeker = state.seekers.get('demo') || { lat: VENUE.lat, lon: VENUE.lon, heading: 0 }
      setSeeker('demo', { name: 'Demo phone', lat: VENUE.lat + 0.0002 * Math.sin(demo.t / 30), lon: VENUE.lon + 0.0003 * Math.cos(demo.t / 40), heading: (demo.t * 3) % 360 }, { quiet: true })
      let k = 0
      for (const b of state.beacons.values()) {
        k += 1
        const dist = 6 + 5 * Math.sin(demo.t / (8 + k)) + k * 3
        addReading({ seekerId: 'demo', beaconId: b.id, distance: dist, azimuthDeg: (k * 70 + demo.t * 2) % 360 - 180, heading: seeker.heading })
      }
    }, 1000)
  } else if (!on && demo.timer) {
    clearInterval(demo.timer)
    demo.timer = null
    state.seekers.delete('demo')
    for (const [id, r] of state.readings) if (r.seekerId === 'demo') state.readings.delete(id)
  }
  changed()
  return { demo: !!demo.timer }
}

// ---------- Elasticsearch, optional ----------

async function es(method, path, body) {
  if (!ES_URL) return null
  const res = await fetch(`${ES_URL}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(ES_AUTH ? { authorization: ES_AUTH } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(3000),
  })
  if (!res.ok && res.status !== 404) throw new Error(`elasticsearch ${method} ${path}: ${res.status}`)
  return res.status === 404 ? null : res.json()
}
function esPut(index, id, doc) {
  es('PUT', `/${index}/_doc/${encodeURIComponent(id)}`, doc).catch((e) => console.warn(e.message))
}
async function esLoad() {
  if (!ES_URL) return
  try {
    for (const [index, put] of [['influence-influencers', (d) => upsertInfluencer(d, { keepId: d.id })], ['influence-beacons', (d) => upsertBeacon(d, { keepId: d.id })]]) {
      const r = await es('POST', `/${index}/_search`, { size: 500, query: { match_all: {} } })
      for (const h of r?.hits?.hits || []) put(h._source)
    }
    console.log(`loaded the registry from ${ES_URL}`)
  } catch (e) {
    console.warn(`elasticsearch not reachable, the registry stays in memory: ${e.message}`)
  }
}
async function search(q) {
  const term = String(q || '').trim()
  if (!term) return []
  if (ES_URL) {
    try {
      const r = await es('POST', '/influence-*,kubecon-*/_search', {
        size: 20,
        query: { multi_match: { query: term, fields: ['name^3', 'title^3', 'handle^2', 'tagline', 'speakers^2', 'company', 'room', 'track', 'bio', 'description'], fuzziness: 'AUTO' } },
      })
      return (r?.hits?.hits || []).map((h) => ({ index: h._index, id: h._id, score: h._score, ...h._source }))
    } catch (e) {
      console.warn(`search fell back to memory: ${e.message}`)
    }
  }
  const t = term.toLowerCase()
  return [...state.influencers.values()].filter((i) => [i.name, i.handle, i.tagline, i.bio].join(' ').toLowerCase().includes(t)).map((i) => ({ index: 'memory', ...i }))
}

// ---------- MCP: the same actions as tools (JSON-RPC over streamable HTTP, stateless) ----------

const TOOLS = [
  { name: 'list_influencers', description: 'List the registered influencers, each with their beacon and where it was last seen.', inputSchema: { type: 'object', properties: {} }, run: () => snapshot().beacons },
  { name: 'find_influencer', description: 'Start finding an influencer: sets the seek target, so the phone seeks their beacon and the glasses show the way. Example: find Kunal.', inputSchema: { type: 'object', properties: { name: { type: 'string', description: 'The influencer, as said: "Kunal", "Kelsey"' }, seeker: { type: 'string', description: 'Which phone seeks; default phone' } }, required: ['name'] }, run: (a) => setTarget(a.seeker, a.name) },
  { name: 'stop_finding', description: 'Stop seeking: clears the target.', inputSchema: { type: 'object', properties: { seeker: { type: 'string' } } }, run: (a) => setTarget(a.seeker, null) },
  { name: 'where_is', description: 'Where an influencer was last seen: distance, direction and an estimated position.', inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] }, run: (a) => { const i = resolveInfluencer(a.name); if (!i) throw httpError(404, `nobody named ${a.name}`); const b = beaconOf(i.id); return { influencer: i, beacon: b, reading: b ? state.readings.get(b.id) || null : null } } },
  { name: 'search', description: 'Search influencers (and, with Elasticsearch, KubeCon sessions and speakers).', inputSchema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] }, run: (a) => search(a.q) },
  { name: 'register_influencer', write: true, description: 'Register or update an influencer.', inputSchema: { type: 'object', properties: { name: { type: 'string' }, handle: { type: 'string' }, tagline: { type: 'string' }, imageUrl: { type: 'string' }, color: { type: 'string' } }, required: ['name'] }, run: (a) => upsertInfluencer(a) },
  { name: 'register_beacon', write: true, description: 'Register a beacon, and map it to an influencer if one is named.', inputSchema: { type: 'object', properties: { name: { type: 'string' }, hardwareId: { type: 'string' }, influencer: { type: 'string' } }, required: ['name'] }, run: (a) => upsertBeacon(a) },
  { name: 'map_beacon', write: true, description: 'Map a beacon to an influencer, or unmap it with influencer null.', inputSchema: { type: 'object', properties: { beacon: { type: 'string' }, influencer: { type: ['string', 'null'] } }, required: ['beacon'] }, run: (a) => { const b = resolveBeacon(a.beacon); if (!b) throw httpError(404, `no beacon ${a.beacon}`); return upsertBeacon({ influencerId: a.influencer ?? null }, { keepId: b.id }) } },
]

async function mcp(msg, authed) {
  const { id, method, params } = msg
  const reply = (result) => ({ jsonrpc: '2.0', id, result })
  const fail = (code, message) => ({ jsonrpc: '2.0', id, error: { code, message } })
  if (id === undefined || id === null) return null // a notification
  switch (method) {
    case 'initialize':
      return reply({ protocolVersion: params?.protocolVersion || '2025-06-18', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'influence', version: VERSION }, instructions: 'Find influencers at KubeCon by their UWB beacons. find_influencer starts the seek on the phone and the glasses.' })
    case 'ping':
      return reply({})
    case 'tools/list':
      return reply({ tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) })
    case 'tools/call': {
      const tool = TOOLS.find((t) => t.name === params?.name)
      if (!tool) return fail(-32602, `unknown tool ${params?.name}`)
      if (tool.write && !authed) return reply({ isError: true, content: [{ type: 'text', text: 'this tool changes the registry: send Authorization: Bearer <write key>' }] })
      try {
        const out = await tool.run(params?.arguments || {})
        return reply({ content: [{ type: 'text', text: JSON.stringify(out, null, 2) }], structuredContent: Array.isArray(out) ? { items: out } : out })
      } catch (e) {
        return reply({ isError: true, content: [{ type: 'text', text: e.message }] })
      }
    }
    default:
      return fail(-32601, `unknown method ${method}`)
  }
}

// ---------- HTTP ----------

function httpError(status, message) {
  const e = new Error(message)
  e.status = status
  return e
}
const str = (v, max) => (v == null ? '' : String(v).slice(0, max))
const num = (v) => (v === null || v === undefined || v === '' || Number.isNaN(Number(v)) ? null : Number(v))
const url = (v) => (v && /^https:\/\/[^\s"'<>]+$/.test(String(v)) ? String(v).slice(0, 500) : '')
const color = (v) => (v && /^#[0-9a-fA-F]{6}$/.test(String(v)) ? String(v) : '')
function lev(a, b) {
  const m = a.length
  const n = b.length
  const d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)])
  for (let j = 1; j <= n; j++) d[0][j] = j
  for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
  return d[m][n]
}

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
  'access-control-allow-headers': 'content-type,authorization,mcp-protocol-version,mcp-session-id',
  'access-control-max-age': '600',
}
function send(res, status, body) {
  res.writeHead(status, { ...CORS, 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(body === undefined ? '' : JSON.stringify(body))
}
async function readBody(req) {
  let size = 0
  const chunks = []
  for await (const c of req) {
    size += c.length
    if (size > 256 * 1024) throw httpError(413, 'the body is over 256 KB')
    chunks.push(c)
  }
  if (!chunks.length) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw httpError(400, 'the body is not JSON')
  }
}
const bearer = (req) => (req.headers.authorization || '').replace(/^Bearer\s+/i, '')
const isWriter = (req) => !WRITE_KEY || bearer(req) === WRITE_KEY
const canEditProfile = (req, id) => isWriter(req) || bearer(req) === profileKey(id)
function requireWriter(req) {
  if (!isWriter(req)) throw httpError(401, 'registry changes need Authorization: Bearer <write key>')
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x')
  const parts = u.pathname.split('/').filter(Boolean)
  try {
    if (req.method === 'OPTIONS') return send(res, 204)
    if (u.pathname === '/healthz' || u.pathname === '/') return send(res, 200, { ok: true, name: 'influence-api', version: VERSION, elasticsearch: !!ES_URL })
    if (u.pathname === '/api/state' && req.method === 'GET') return send(res, 200, snapshot())
    if (u.pathname === '/api/events' && req.method === 'GET') {
      res.writeHead(200, { ...CORS, 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' })
      res.write(`retry: 2000\nevent: state\ndata: ${JSON.stringify(snapshot())}\n\n`)
      clients.add(res)
      req.on('close', () => clients.delete(res))
      return
    }
    if (u.pathname === '/mcp') {
      if (req.method !== 'POST') return send(res, 405, { error: 'MCP here is POST only (stateless streamable HTTP)' })
      const body = await readBody(req)
      const authed = isWriter(req)
      const out = Array.isArray(body) ? (await Promise.all(body.map((m) => mcp(m, authed)))).filter(Boolean) : await mcp(body, authed)
      if (!out || (Array.isArray(out) && !out.length)) return send(res, 202)
      return send(res, 200, out)
    }
    if (parts[0] !== 'api') return send(res, 404, { error: `no route ${req.method} ${u.pathname}` })

    const [, kind, id] = parts
    if (kind === 'influencers') {
      if (req.method === 'GET' && !id) return send(res, 200, [...state.influencers.values()])
      if (req.method === 'GET' && !parts[3]) return state.influencers.has(id) ? send(res, 200, state.influencers.get(id)) : send(res, 404, { error: `no influencer ${id}` })
      if (req.method === 'POST' && !id) {
        requireWriter(req)
        const inf = upsertInfluencer(await readBody(req))
        return send(res, 201, { ...inf, profileKey: profileKey(inf.id) })
      }
      if ((req.method === 'PUT' || req.method === 'PATCH') && id) {
        if (!state.influencers.has(id)) return send(res, 404, { error: `no influencer ${id}` })
        if (!canEditProfile(req, id)) throw httpError(401, 'this profile needs its own key or the write key')
        return send(res, 200, upsertInfluencer(await readBody(req), { keepId: id }))
      }
      if (req.method === 'DELETE' && id) {
        requireWriter(req)
        state.influencers.delete(id)
        for (const b of state.beacons.values()) if (b.influencerId === id) b.influencerId = null
        es('DELETE', `/influence-influencers/_doc/${encodeURIComponent(id)}`).catch(() => {})
        changed()
        return send(res, 204)
      }
      if (req.method === 'GET' && parts[3] === 'key') {
        requireWriter(req)
        return send(res, 200, { id, profileKey: profileKey(id) })
      }
    }
    if (kind === 'beacons') {
      if (req.method === 'GET' && !id) return send(res, 200, snapshot().beacons)
      if (req.method === 'POST' && !id) {
        requireWriter(req)
        return send(res, 201, upsertBeacon(await readBody(req)))
      }
      if ((req.method === 'PUT' || req.method === 'PATCH') && id) {
        requireWriter(req)
        if (!state.beacons.has(id)) return send(res, 404, { error: `no beacon ${id}` })
        return send(res, 200, upsertBeacon(await readBody(req), { keepId: id }))
      }
      if (req.method === 'DELETE' && id) {
        requireWriter(req)
        state.beacons.delete(id)
        state.readings.delete(id)
        es('DELETE', `/influence-beacons/_doc/${encodeURIComponent(id)}`).catch(() => {})
        changed()
        return send(res, 204)
      }
    }
    if (kind === 'readings' && req.method === 'POST') {
      const body = await readBody(req)
      const list = Array.isArray(body) ? body : [body]
      return send(res, 201, list.map(addReading))
    }
    if (kind === 'seekers' && id && (req.method === 'POST' || req.method === 'PUT')) return send(res, 200, setSeeker(slug(id), await readBody(req)))
    if (kind === 'target') {
      const seeker = u.searchParams.get('seeker') || 'phone'
      if (req.method === 'GET') return send(res, 200, describeTarget(state.targets.get(slug(seeker))) || { seekerId: slug(seeker), target: null })
      if (req.method === 'PUT' || req.method === 'POST') {
        const body = await readBody(req)
        return send(res, 200, setTarget(body.seeker || seeker, body.name || body.influencer || body.beacon || null))
      }
      if (req.method === 'DELETE') return send(res, 200, setTarget(seeker, null))
    }
    if (kind === 'search' && req.method === 'GET') return send(res, 200, await search(u.searchParams.get('q')))
    if (kind === 'demo' && req.method === 'POST') {
      requireWriter(req)
      const body = await readBody(req)
      return send(res, 200, setDemo(body.on !== false))
    }
    return send(res, 404, { error: `no route ${req.method} ${u.pathname}` })
  } catch (e) {
    const status = e.status || 500
    if (status >= 500) console.error(e)
    if (!res.headersSent) send(res, status, { error: e.message })
  }
})

// The registry Elasticsearch kept, then the two influencers the hackathon starts with, only where it has none: a
// restart must not undo what an influencer set on their own page.
await esLoad()
if (!state.influencers.has('kelsey')) upsertInfluencer({ id: 'kelsey', name: 'Kelsey', tagline: 'Find me at KubeCon', color: '#3DA992' })
if (!state.influencers.has('kunal')) upsertInfluencer({ id: 'kunal', name: 'Kunal', tagline: 'Find me at KubeCon', color: '#8B7CF6' })
if (!state.beacons.has('beacon-1')) upsertBeacon({ id: 'beacon-1', name: 'Beacon 1', influencerId: 'kelsey' })
if (!state.beacons.has('beacon-2')) upsertBeacon({ id: 'beacon-2', name: 'Beacon 2', influencerId: 'kunal' })

server.listen(PORT, () => console.log(`influence-api ${VERSION} on :${PORT}${ES_URL ? `, Elasticsearch at ${ES_URL}` : ''}`))
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => server.close(() => process.exit(0)))
