// deliver.ts 契约路由（/dsh-dws/api）桩测：零网络零 CLI。假 req/res 直调
// createApiHandler；sendImpl 注入；holder（channelConfig）直接设值；targets/失败日志
// 落临时目录。import 自 ../lib/index.js，跑前先 pnpm build。
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApiHandler, upsertTarget, findTarget, readSendFailures, seenOrAdd, countDeny, resetCounters, snapshotCounters, SEEN_CAP, DELIVER_ACTOR_ID } from '../lib/index.js'

const STATE = mkdtempSync(join(tmpdir(), 'dws-deliver-'))
const PORT = 3082
const holder = (over = {}) => ({
  config: { dwsBinary: '/bin/echo', coalesceMs: 2000, readPageSize: 20, accounts: [], groups: [], ...over.config },
  accounts: [{ rowProfile: '', profile: 'p1', label: '', directMessages: true, aiTag: true, groups: [], selfIds: [] }],
  binary: '/bin/echo',
  ...over,
})

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
  return {
    headersSent: false, statusCode: 0, headers: {}, body: '',
    writeHead(code, h) { this.statusCode = code; Object.assign(this.headers, h || {}) },
    end(chunk) { if (chunk !== undefined) this.body += String(chunk); this.headersSent = true },
  }
}

async function call(handler, method, path, body, headers) {
  const req = fakeReq(method, body)
  if (headers !== undefined) req.headers = headers
  const res = fakeRes()
  await handler(path, req, res)
  let data = null
  try { data = res.body ? JSON.parse(res.body) : null } catch { data = res.body }
  return { status: res.statusCode, data }
}

function handler(deps) {
  return createApiHandler({
    port: PORT,
    receive: deps.receive ?? (async () => undefined),
    holder: deps.holder ?? (() => undefined),
    stateDir: deps.stateDir ?? STATE,
    ...(deps.sendImpl ? { sendImpl: deps.sendImpl } : {}),
  })
}

test('sameOrigin 闸门：缺 x-orchestrator-request → 403', async () => {
  const res = await call(handler({}), 'GET', '/api/health', undefined, { host: '127.0.0.1:' + PORT })
  assert.equal(res.status, 403)
})

test('未知路由 → 404；PUT /settings 本批不开 → 400 bad-request', async () => {
  assert.equal((await call(handler({}), 'GET', '/api/nope')).status, 404)
  const put = await call(handler({}), 'PUT', '/api/settings', { coalesceMs: 1000 })
  assert.equal(put.status, 400)
  assert.equal(put.data.error, 'bad-request')
})

test('POST /deliver：400 形状非法 / 404 unknown-target / 409 not-ready / 400 缺路由字段', async () => {
  const h = handler({})
  assert.equal((await call(h, 'POST', '/api/deliver', { text: 'x' })).status, 400)
  assert.equal((await call(h, 'POST', '/api/deliver', { targetId: 'nope', text: 'x' })).status, 404)
  assert.equal((await call(h, 'POST', '/api/deliver', { targetId: 'nope', text: 'x' })).data.error, 'unknown-target')
  await upsertTarget({ id: 'u1', address: { staffId: 's1' } }, STATE)
  const emptyHolder = handler({ holder: () => undefined })
  const notReady = await call(emptyHolder, 'POST', '/api/deliver', { targetId: 'u1', text: 'hi' })
  assert.equal(notReady.status, 409)
  assert.equal(notReady.data.error, 'not-ready')
  await upsertTarget({ id: 'bad', address: {} }, STATE)
  const badAddress = await call(handler({ holder: () => holder() }), 'POST', '/api/deliver', { targetId: 'bad', text: 'x' })
  assert.equal(badAddress.status, 400)
})

test('POST /deliver（单聊目标）：受理并产出非人类 Trigger（human:false、addressed:direct、meta.deliver、actor=源标识）', async () => {
  resetCounters()
  await upsertTarget({ id: 'dm', address: { staffId: 'staff9' } }, STATE)
  const received = []
  const h = handler({ receive: (t) => received.push(t), holder: () => holder() })
  const res = await call(h, 'POST', '/api/deliver', { targetId: 'dm', text: '把周报整理成纪要' })
  assert.equal(res.status, 200)
  assert.equal(res.data.ok, true)
  assert.equal(res.data.accepted, true)
  assert.equal(typeof res.data.triggerId, 'string')
  const t = received[0]
  assert.equal(t.human, false)
  assert.equal(t.addressed, 'direct') // 非人类 Trigger 进引擎的 machineGate 前提
  assert.equal(t.meta.deliver, true)
  assert.equal(t.meta.targetId, 'dm')
  assert.equal(t.meta.isDm, true)
  assert.equal(t.actor.id, DELIVER_ACTOR_ID)
  assert.equal(t.actor.id, 'dsh-superagent-dws')
  assert.equal(t.threads[0].id, 'dws:p1:direct:staff9')
  assert.deepEqual(t.channel.address, { account: 'p1', direct: 'true', user: 'staff9' })
  assert.equal(t.text, '把周报整理成纪要')
  // 收件即受理：计数入 in；lastUsedAt 已刷新
  assert.equal(snapshotCounters().in, 1)
  const target = await findTarget('dm', STATE)
  assert.ok(target && target.lastUsedAt >= target.createdAt)
})

test('POST /deliver（群目标）：conversation 路由回群', async () => {
  resetCounters()
  await upsertTarget({ id: 'ops', address: { conversationId: 'cid99' } }, STATE)
  const received = []
  const h = handler({ receive: (t) => received.push(t), holder: () => holder() })
  const res = await call(h, 'POST', '/api/deliver', { targetId: 'ops', text: '群通知' })
  assert.equal(res.data.accepted, true)
  const t = received[0]
  assert.equal(t.meta.isDm, false)
  assert.equal(t.threads[0].id, 'dws:p1:cid99')
  assert.deepEqual(t.channel.address, { account: 'p1', conversation: 'cid99' })
})

test('POST /deliver/test：注入 sendImpl 直发（staffId → direct 地址；conversationId → 群地址）', async () => {
  resetCounters()
  const sent = []
  const h = handler({
    holder: () => holder(),
    sendImpl: async (binary, account, address, text, key) => sent.push({ binary, profile: account.profile, address, text, key }),
  })
  await upsertTarget({ id: 'g', address: { conversationId: 'cid77' } }, STATE)
  const res = await call(h, 'POST', '/api/deliver/test', { targetId: 'g' })
  assert.equal(res.status, 200)
  assert.equal(res.data.ok, true)
  assert.equal(res.data.sent, true)
  assert.equal(sent.length, 1)
  assert.equal(sent[0].binary, '/bin/echo')
  assert.deepEqual(sent[0].address, { conversation: 'cid77' })
  assert.equal(sent[0].text.includes('主动投递测试'), true)
  assert.equal(sent[0].text.includes('delivery test'), true) // 双语文案
  assert.equal(sent[0].key.startsWith('deliver-test:g'), true)
})

test('POST /deliver/test：发送抛错 → sent:false + failure-log 留痕', async () => {
  resetCounters()
  const h = handler({
    holder: () => holder(),
    sendImpl: async () => { throw new Error('FAKE_DWS_DOWN') },
  })
  const res = await call(h, 'POST', '/api/deliver/test', { targetId: 'g' })
  assert.equal(res.data.sent, false)
  assert.equal(res.data.detail.includes('FAKE_DWS_DOWN'), true)
  const failures = await readSendFailures(STATE)
  assert.equal(failures.some((f) => f.kind === 'deliver-test' && f.error.includes('FAKE_DWS_DOWN')), true)
})

test('GET /settings：返回 config 原样（本源无凭据字段）；describe 字段表齐全', async () => {
  const h = handler({ holder: () => holder({ config: { dwsBinary: 'dws', coalesceMs: 2000, readPageSize: 20, accounts: [], groups: [] } }) })
  const settings = await call(h, 'GET', '/api/settings')
  assert.equal(settings.status, 200)
  assert.equal(settings.data.ok, true)
  assert.equal(settings.data.config.dwsBinary, 'dws')
  const describe = await call(h, 'GET', '/api/settings.describe')
  assert.equal(describe.data.ok, true)
  assert.ok(Array.isArray(describe.data.fields) && describe.data.fields.length > 0)
  assert.equal(describe.data.fields.find((f) => f.key === 'policy.groupOnly').hint.zh.includes('群/单聊'), true)
  assert.equal(describe.data.fields.every((f) => f.key !== 'accounts[].botToken'), true)
})

test('GET /health：计数/最近失败/dedup 水位齐全', async () => {
  resetCounters()
  countDeny()
  await seenOrAdd('p1', 'm1', STATE)
  const h = handler({ holder: () => holder() })
  const res = await call(h, 'GET', '/api/health')
  assert.equal(res.data.ok, true)
  assert.equal(res.data.counts.deny, 1)
  assert.deepEqual(res.data.dedup, { cap: SEEN_CAP, stores: [{ key: 'p1', count: 1 }] })
  assert.ok(Array.isArray(res.data.failures))
})

after(() => { rmSync(STATE, { recursive: true, force: true }) })
