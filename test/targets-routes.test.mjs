// targets CRUD 路由桩测（契约 §1 P-C' 三路由）：零网络零引擎，stateDir 落临时目录。
import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const STATE = mkdtempSync(join(tmpdir(), 'dws-targets-'))
process.env.DSH_DWS_STATE_DIR = STATE
const lib = await import('../lib/index.js')

const PORT = 3082
function fakeReq(method, body) {
  const req = new EventEmitter()
  req.method = method
  req.url = '/dsh-dws/api/x'
  req.headers = { host: '127.0.0.1:' + PORT, 'x-orchestrator-request': '1' }
  req.destroy = () => {}
  queueMicrotask(() => {
    if (body !== undefined) req.emit('data', Buffer.from(JSON.stringify(body)))
    req.emit('end')
  })
  return req
}
function fakeRes() {
  const res = { statusCode: 0, headers: {}, body: '' }
  res.setHeader = (k, v) => { res.headers[k] = v }
  res.writeHead = (code) => { res.statusCode = code }
  res.end = (chunk) => { if (chunk) res.body += String(chunk) }
  return res
}
const deps = { port: PORT, receive: async () => ({}), config: () => undefined, stateDir: STATE }
const handler = lib.createApiHandler(deps)
async function call(method, path, body) {
  const req = fakeReq(method, body)
  const res = fakeRes()
  await handler(path, req, res)
  let json = null
  try { json = JSON.parse(res.body) } catch { json = null }
  return { status: res.statusCode, json }
}

test('targets: PUT 创建 → GET 列出 → PUT 更新 created=false → DELETE → 再 DELETE 404', async () => {
  const put1 = await call('PUT', '/api/targets', { id: 'release-alerts', label: '发布告警', address: { staffId: 'staff001' } })
  assert.equal(put1.status, 200)
  assert.equal(put1.json.ok, true)
  assert.equal(put1.json.created, true)
  const list = await call('GET', '/api/targets')
  assert.equal(list.json.targets.length, 1)
  assert.equal(list.json.targets[0].id, 'release-alerts')
  assert.equal(list.json.targets[0].address.staffId, 'staff001')
  const put2 = await call('PUT', '/api/targets', { id: 'release-alerts', label: '发布告警2', address: { conversationId: 'cid001' } })
  assert.equal(put2.json.created, false)
  const del = await call('DELETE', '/api/targets/release-alerts')
  assert.equal(del.status, 200)
  const del2 = await call('DELETE', '/api/targets/release-alerts')
  assert.equal(del2.status, 404)
  assert.equal(del2.json.error, 'unknown-target')
})

test('targets: 非法 targetId 400 / 非对象 address 400', async () => {
  const bad1 = await call('PUT', '/api/targets', { id: '../etc', address: { staffId: 'x' } })
  assert.equal(bad1.status, 400)
  const bad2 = await call('PUT', '/api/targets', { id: 'ok-id', address: 'nope' })
  assert.equal(bad2.status, 400)
})

test('targets: TARGET_ID_RE 契约形状导出', () => {
  assert.equal(lib.TARGET_ID_RE.source, /^[A-Za-z0-9._@:-]{1,128}$/.source)
  assert.equal(lib.TARGETS_VERSION, 1)
})
