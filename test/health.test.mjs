// health.ts 健康计数与快照桩测：计数语义、denySuffix、withHealthCapture 旁路、
// buildHealthPayload（失败日志尾部 20 条 + dedup 水位）。零网络零 CLI。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  countIn, countOut, countFail, countDeny, snapshotCounters, resetCounters,
  noteHealth, denySuffix, withHealthCapture, buildHealthPayload,
  logSendFailure, seenOrAdd, SEEN_CAP,
} from '../lib/index.js'

test('计数：in/out/fail/deny 独立累加，lastIn/lastOut 记 ISO', () => {
  resetCounters()
  countIn()
  countIn()
  countOut()
  countFail()
  countDeny()
  const s = snapshotCounters()
  assert.deepEqual({ in: s.in, out: s.out, fail: s.fail, deny: s.deny }, { in: 2, out: 1, fail: 1, deny: 1 })
  assert.match(String(s.lastIn), /^\d{4}-\d{2}-\d{2}T/)
  assert.match(String(s.lastOut), /^\d{4}-\d{2}-\d{2}T/)
  resetCounters()
  const empty = snapshotCounters()
  assert.deepEqual({ in: empty.in, out: empty.out, fail: empty.fail, deny: empty.deny }, { in: 0, out: 0, fail: 0, deny: 0 })
  assert.equal(empty.lastIn, undefined)
  assert.equal(empty.lastOut, undefined)
})

test('denySuffix：无拒绝为空串，有拒绝追加 ; deny=N', () => {
  resetCounters()
  assert.equal(denySuffix(), '')
  countDeny()
  assert.equal(denySuffix(), '; deny=1')
  resetCounters()
})

test('withHealthCapture：只捕获目标 entry，其余转发不捕获；receive/config 委托不变', async () => {
  const reports = []
  let received = 0
  const source = {
    deployment: { repository: 'test' },
    configured: () => true,
    config: (kind) => ({ kind }),
    receive: async () => { received += 1 },
    threads: { describe() {}, patch() {} },
    report: (entry, health) => reports.push([entry, health]),
  }
  const captured = withHealthCapture(source, 'dwsStream')
  captured.report('dwsStream', { state: 'ready', detail: 'ok' })
  captured.report('other', { state: 'error', detail: 'x' })
  assert.equal(reports.length, 2) // 两条都转发到引擎
  await captured.receive()
  assert.equal(received, 1)
  assert.equal(captured.config('dws').kind, 'dws')
})

test('buildHealthPayload：失败日志尾部 20 条 + dedup 水位 + state/detail', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dws-health-'))
  try {
    resetCounters()
    countOut()
    countDeny()
    for (let i = 0; i < 25; i += 1) {
      await logSendFailure({ channelKey: 'p1:c' + i, kind: 'send', error: 'boom-' + i }, dir)
    }
    await seenOrAdd('p1', 'a1', dir)
    await seenOrAdd('p1', 'a2', dir)
    await seenOrAdd('p2', 'b1', dir)
    noteHealth({ state: 'ready', detail: '[p1] listening (3 keys)', at: '2026-11-09T10:00:00.000Z' })
    const payload = await buildHealthPayload(['p1', 'p2'], dir)
    assert.equal(payload.state, 'ready')
    assert.equal(payload.detail, '[p1] listening (3 keys)')
    assert.equal(payload.at, '2026-11-09T10:00:00.000Z')
    assert.equal(payload.counts.out, 1)
    assert.equal(payload.counts.deny, 1)
    assert.equal(payload.failures.length, 20)
    assert.equal(payload.failures[0].error, 'boom-5') // 尾部 20 条：最早的 5 条被裁
    assert.equal(payload.failures[19].error, 'boom-24')
    assert.deepEqual(payload.dedup, { cap: SEEN_CAP, stores: [{ key: 'p1', count: 2 }, { key: 'p2', count: 1 }] })
    // 无报告时 state 起始为 starting
    noteHealth(undefined)
    const cold = await buildHealthPayload([], dir)
    assert.equal(cold.state, 'starting')
    resetCounters()
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
