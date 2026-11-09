// What survives a restart: each test runs server.js as real processes (`node server.js`, PORT=0) against a fake
// Elasticsearch, stops one and starts the next, the way a deploy does. No dependencies: node:test, http and fetch.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const SERVER = fileURLToPath(new URL('../server.js', import.meta.url))
const SEED = JSON.parse(readFileSync(new URL('../registry.seed.json', import.meta.url), 'utf8'))

// A tiny Elasticsearch: documents in memory, answering what server.js sends. PUT and DELETE of /<index>/_doc/<id>, and
// POST /<index>/_search (match_all, or any query: every document of the indices named, patterns and lists included).
// An index it has never seen is a 404, as Elasticsearch answers.
async function fakeElasticsearch() {
  const indices = new Map() // index -> Map(id -> document)
  const writes = [] // "PUT seek-targets/phone", in the order they arrived
  const server = http.createServer(async (req, res) => {
    let body = ''
    for await (const c of req) body += c
    const [index, op, id] = new URL(req.url, 'http://x').pathname.split('/').filter(Boolean).map(decodeURIComponent)
    const reply = (status, json) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(json))
    }
    if (op === '_doc' && req.method === 'PUT') {
      writes.push(`PUT ${index}/${id}`)
      if (!indices.has(index)) indices.set(index, new Map())
      indices.get(index).set(id, JSON.parse(body))
      return reply(200, { result: 'updated' })
    }
    if (op === '_doc' && req.method === 'DELETE') {
      writes.push(`DELETE ${index}/${id}`)
      const found = indices.get(index)?.delete(id)
      return reply(found ? 200 : 404, { result: found ? 'deleted' : 'not_found' })
    }
    if (op === '_search') {
      const patterns = index.split(',').map((p) => new RegExp(`^${p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`))
      const names = [...indices.keys()].filter((n) => patterns.some((p) => p.test(n)))
      if (!names.length && !index.includes('*')) return reply(404, { error: { type: 'index_not_found_exception' } })
      const hits = names.flatMap((n) => [...indices.get(n)].map(([_id, _source]) => ({ _index: n, _id, _score: 1, _source })))
      return reply(200, { hits: { hits } })
    }
    reply(400, { error: `the fake has no ${req.method} ${req.url}` })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    doc: (index, id) => indices.get(index)?.get(id),
    writes,
    close: () => new Promise((r) => server.close(r)),
  }
}

// One server process, against Elasticsearch at esUrl or with none: resolves once it listens.
async function startServer(esUrl) {
  const env = { PATH: process.env.PATH, PORT: '0', ...(esUrl ? { ES_URL: esUrl } : {}) }
  const child = spawn(process.execPath, [SERVER], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  let log = ''
  child.stderr.on('data', (c) => (log += c))
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`the server did not start:\n${log}`)), 10000)
    child.stdout.on('data', (c) => {
      log += c
      const m = log.match(/ on :(\d+)/)
      if (m) clearTimeout(timer), resolve(Number(m[1]))
    })
    child.on('exit', (code) => clearTimeout(timer) || reject(new Error(`the server exited ${code}:\n${log}`)))
  })
  const base = `http://127.0.0.1:${port}`
  return {
    log: () => log,
    get: (path) => fetch(base + path).then((r) => r.json()),
    call: (method, path, body) =>
      fetch(base + path, { method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json() })),
    // SIGTERM, as a deploy sends it; SIGKILL if it has not gone in two seconds.
    stop: () =>
      new Promise((r) => {
        if (child.exitCode !== null) return r()
        child.once('exit', r)
        child.kill('SIGTERM')
        setTimeout(() => child.kill('SIGKILL'), 2000).unref()
      }),
  }
}

// Writes to Elasticsearch leave after the response: wait until one has landed.
async function until(what, ok) {
  for (const end = Date.now() + 3000; Date.now() < end; await new Promise((r) => setTimeout(r, 20))) if (ok()) return
  assert.fail(`timed out waiting for ${what}`)
}

test('a seek target set on one process comes back on the next', async (t) => {
  const es = await fakeElasticsearch()
  t.after(() => es.close())
  const first = await startServer(es.url)
  t.after(() => first.stop())
  const set = await first.call('PUT', '/api/target?seeker=phone', { name: 'Kunal' })
  assert.equal(set.status, 200)
  assert.equal(set.body.hardwareId, 'CA588E78')
  await until('the target in seek-targets', () => es.doc('seek-targets', 'phone'))
  assert.deepEqual(es.doc('seek-targets', 'phone'), { seekerId: 'phone', influencerId: 'kunal', beaconId: 'beacon-2', at: set.body.at })
  await first.stop()

  const second = await startServer(es.url)
  t.after(() => second.stop())
  assert.match(second.log(), /loaded 1 seek target/)
  const target = await second.get('/api/target?seeker=phone')
  assert.equal(target.influencerId, 'kunal')
  assert.equal(target.name, 'Kunal')
  assert.equal(target.hardwareId, 'CA588E78')
  assert.equal((await second.get('/api/state')).targets.length, 1)
  // seek-targets is outside the patterns search runs over: a target is never a result.
  const results = await second.get('/api/search?q=kunal')
  assert.ok(results.length > 0)
  assert.ok(results.every((r) => r.index !== 'seek-targets'))
})

test('a cleared target stays gone, even cleared at once after it was set', async (t) => {
  const es = await fakeElasticsearch()
  t.after(() => es.close())
  const first = await startServer(es.url)
  t.after(() => first.stop())
  await first.call('PUT', '/api/target?seeker=phone', { name: 'Kelsey' })
  const cleared = await first.call('DELETE', '/api/target?seeker=phone')
  assert.deepEqual(cleared.body, { seekerId: 'phone', target: null })
  await until('the delete in seek-targets', () => es.writes.includes('DELETE seek-targets/phone'))
  // The set and the clear reached Elasticsearch in the order they were made.
  assert.deepEqual(es.writes.filter((w) => w.includes('seek-targets')), ['PUT seek-targets/phone', 'DELETE seek-targets/phone'])
  assert.equal(es.doc('seek-targets', 'phone'), undefined)
  await first.stop()

  const second = await startServer(es.url)
  t.after(() => second.stop())
  assert.deepEqual(await second.get('/api/target?seeker=phone'), { seekerId: 'phone', target: null })
  assert.deepEqual((await second.get('/api/state')).targets, [])
})

test('the seed fills only what Elasticsearch lacks, so an influencer\'s edits survive a restart', async (t) => {
  const es = await fakeElasticsearch()
  t.after(() => es.close())
  const first = await startServer(es.url)
  t.after(() => first.stop())
  // An empty Elasticsearch: everything comes from registry.seed.json, and is written through.
  const state = await first.get('/api/state')
  assert.deepEqual(state.influencers.map((i) => i.id).sort(), SEED.influencers.map((i) => i.id).sort())
  for (const b of SEED.beacons) {
    const got = state.beacons.find((x) => x.id === b.id)
    assert.deepEqual({ id: got.id, name: got.name, hardwareId: got.hardwareId, influencerId: got.influencerId }, b)
  }
  await until('the seed in Elasticsearch', () => es.doc('influence-influencers', 'kunal') && es.doc('influence-beacons', 'beacon-2'))
  const edited = await first.call('PUT', '/api/influencers/kelsey', { tagline: 'Edited on my own page' })
  assert.equal(edited.status, 200)
  await until('the edit in Elasticsearch', () => es.doc('influence-influencers', 'kelsey')?.tagline === 'Edited on my own page')
  await first.stop()

  const second = await startServer(es.url)
  t.after(() => second.stop())
  const kelsey = await second.get('/api/influencers/kelsey')
  assert.equal(kelsey.tagline, 'Edited on my own page')
  const kunal = await second.get('/api/influencers/kunal')
  assert.equal(kunal.tagline, SEED.influencers.find((i) => i.id === 'kunal').tagline)
})

test('with no ES_URL everything works in memory, from the seed', async (t) => {
  const server = await startServer(null)
  t.after(() => server.stop())
  assert.equal((await server.get('/healthz')).elasticsearch, false)
  assert.equal((await server.get('/api/state')).beacons.length, SEED.beacons.length)
  assert.equal((await server.call('PUT', '/api/target?seeker=phone', { name: 'Kunal' })).status, 200)
  assert.equal((await server.call('POST', '/api/readings', { seekerId: 'phone', hardwareId: 'CA588E78', distance: 2.5 })).status, 201)
  const target = await server.get('/api/target?seeker=phone')
  assert.equal(target.name, 'Kunal')
  assert.equal(target.lastReading.distance, 2.5)
  assert.deepEqual((await server.call('DELETE', '/api/target?seeker=phone')).body, { seekerId: 'phone', target: null })
})

test('with Elasticsearch unreachable the API starts anyway, says so, and a target write only logs', async (t) => {
  const gone = await fakeElasticsearch()
  await gone.close() // a port nothing answers on
  const server = await startServer(gone.url)
  t.after(() => server.stop())
  assert.match(server.log(), /elasticsearch not reachable, the registry stays in memory/)
  assert.match(server.log(), /elasticsearch not reachable, the seek targets start empty/)
  assert.equal((await server.call('PUT', '/api/target?seeker=phone', { name: 'Kunal' })).status, 200)
  assert.equal((await server.get('/api/target?seeker=phone')).name, 'Kunal')
})
