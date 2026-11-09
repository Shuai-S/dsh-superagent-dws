// login-session.ts 纯状态转移（依赖注入假进程，零 CLI 零网络）：
// start 幂等 / cancel 只在运行中 / exit 0 完成与新 profile diff / exit 非 0 报错 /
// 行缓冲上限 40 / 完成但无新 profile 的 error。8 分钟超时与 3s 轮询不在纯态用例内。
// import 自 ../lib/index.js，跑前先 pnpm build。
import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { LoginSessionManager } from '../lib/index.js'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function fakeChild() {
  const child = new EventEmitter()
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.stdin = { end: () => {} }
  child.kill = () => true
  return child
}

test('start → running；运行中重复 start 幂等（不重复拉进程）', async () => {
  let spawned = 0
  const mgr = new LoginSessionManager({ listProfiles: async () => [], spawn: () => { spawned++; return fakeChild() } })
  await mgr.start('dws-fake')
  assert.equal(mgr.status().running, true)
  assert.equal(spawned, 1)
  await mgr.start('dws-fake-2')
  assert.equal(spawned, 1)
  mgr.cancel()
})

test('cancel 只在运行中生效；未运行 cancel 无副作用', async () => {
  const mgr = new LoginSessionManager({ listProfiles: async () => [], spawn: () => fakeChild() })
  mgr.cancel()
  assert.equal(mgr.status().done, false)
  await mgr.start('b')
  mgr.cancel()
  const st = mgr.status()
  assert.equal(st.done, true)
  assert.equal(st.error, 'cancelled')
  assert.equal(st.running, false)
  mgr.cancel() // 已结束：error 不被覆盖
  assert.equal(mgr.status().error, 'cancelled')
})

test('exit 0 → 完成；新 profile 进入候选 diff', async () => {
  let call = 0
  const child = fakeChild()
  const mgr = new LoginSessionManager({
    listProfiles: async () => (++call === 1 ? [] : [{ profile: 'corp:newbie', isCurrent: true }]),
    spawn: () => child,
  })
  await mgr.start('b')
  child.emit('exit', 0)
  await sleep(20)
  const st = mgr.status()
  assert.equal(st.done, true)
  assert.equal(st.running, false)
  assert.equal(st.error, undefined)
  assert.deepEqual(st.profiles.map((p) => p.profile), ['corp:newbie'])
})

test('exit 非 0 → error 带退出码', async () => {
  const child = fakeChild()
  const mgr = new LoginSessionManager({ listProfiles: async () => [], spawn: () => child })
  await mgr.start('b')
  child.emit('exit', 3)
  await sleep(20)
  const st = mgr.status()
  assert.equal(st.done, true)
  assert.match(st.error, /code=3/)
})

test('spawn error → error 记录', async () => {
  const child = fakeChild()
  const mgr = new LoginSessionManager({ listProfiles: async () => [], spawn: () => child })
  await mgr.start('b')
  child.emit('error', new Error('boom'))
  await sleep(20)
  const st = mgr.status()
  assert.equal(st.done, true)
  assert.match(st.error, /boom/)
})

test('行缓冲上限 LINES_KEPT=40（保留最新）', async () => {
  const child = fakeChild()
  const mgr = new LoginSessionManager({ listProfiles: async () => [], spawn: () => child })
  await mgr.start('b')
  for (let i = 0; i < 45; i++) child.stdout.emit('data', Buffer.from('line-' + i + '\n'))
  const st = mgr.status()
  assert.equal(st.lines.length, 40)
  assert.equal(st.lines[0], 'line-5')
  assert.equal(st.lines[39], 'line-44')
  mgr.cancel()
})

test('完成但无新 profile → error 提示', async () => {
  const child = fakeChild()
  const mgr = new LoginSessionManager({ listProfiles: async () => [], spawn: () => child })
  await mgr.start('b')
  child.emit('exit', 0)
  await sleep(20)
  const st = mgr.status()
  assert.equal(st.done, true)
  assert.equal(st.error, 'login finished but no new profile appeared')
  assert.deepEqual(st.profiles, [])
})

test('status() 返回副本（外部改不动内部行缓冲）', async () => {
  const child = fakeChild()
  const mgr = new LoginSessionManager({ listProfiles: async () => [], spawn: () => child })
  await mgr.start('b')
  child.stdout.emit('data', Buffer.from('hello\n'))
  const st = mgr.status()
  st.lines.push('MUTATED')
  assert.deepEqual(mgr.status().lines, ['hello'])
  mgr.cancel()
})
