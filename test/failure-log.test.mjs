// failure-log.ts 出站失败 JSONL：追加、200 行滚动、error 截断、损坏恢复、只含约定字段。
// import 自 ../lib/index.js，跑前先 pnpm build。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { logSendFailure, readSendFailures, FAILURE_LOG_LIMIT, failureLogFile } from '../lib/index.js'

test('记录与滚动上限：超过 ' + FAILURE_LOG_LIMIT + ' 行丢最旧', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dws-flog-'))
  try {
    for (let i = 0; i < FAILURE_LOG_LIMIT + 20; i++) {
      await logSendFailure({ channelKey: 'acc:cid' + i, kind: 'send', error: 'boom-' + i }, dir)
    }
    const all = await readSendFailures(dir)
    assert.equal(all.length, FAILURE_LOG_LIMIT)
    assert.equal(all[0].error, 'boom-20')
    assert.equal(all[all.length - 1].error, 'boom-' + (FAILURE_LOG_LIMIT + 19))
    assert.ok(all.every((e) => /^\d{4}-/.test(e.at)))
    assert.ok(all.every((e) => e.kind === 'send'))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('error 截断到 300 字', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dws-flog-'))
  try {
    await logSendFailure({ channelKey: 'k', kind: 'send', error: 'x'.repeat(500) }, dir)
    const all = await readSendFailures(dir)
    assert.equal(all[all.length - 1].error.length, 300)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('损坏行读取时跳过，写入仍继续', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dws-flog-'))
  try {
    await logSendFailure({ channelKey: 'k1', kind: 'send', error: 'first' }, dir)
    writeFileSync(failureLogFile(dir), readFileSync(failureLogFile(dir), 'utf8') + 'GARBAGE\n')
    await logSendFailure({ channelKey: 'k2', kind: 'send', error: 'after-corrupt' }, dir)
    const all = await readSendFailures(dir)
    assert.equal(all.length, 2)
    assert.equal(all[0].error, 'first')
    assert.equal(all[1].error, 'after-corrupt')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('空目录读取返回空数组', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dws-flog-'))
  try {
    assert.deepEqual(await readSendFailures(dir), [])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
