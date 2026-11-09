// targets.ts 主动投递目标表：baseDir 隔离、原子写、按 id 去重（createdAt 保留）、
// targetId 校验、损坏文件按空表处理。import 自 ../lib/index.js，跑前先 pnpm build。
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readTargets, findTarget, upsertTarget, touchTarget, targetsFile, TARGET_ID_RE, TARGETS_VERSION } from '../lib/index.js'

test('targetId 校验：1-128 字符 [A-Za-z0-9._@:-]', () => {
  assert.equal(TARGET_ID_RE.test('ops'), true)
  assert.equal(TARGET_ID_RE.test('user@example.com:8080'), true)
  assert.equal(TARGET_ID_RE.test(''), false)
  assert.equal(TARGET_ID_RE.test('a'.repeat(129)), false)
  assert.equal(TARGET_ID_RE.test('空格 id'), false)
  assert.equal(TARGET_ID_RE.test('a/b'), false)
})

test('upsert 创建/更新去重：createdAt 保留、lastUsedAt 刷新、address 可改', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dws-targets-'))
  try {
    const first = await upsertTarget({ id: 'ops', address: { staffId: 's1' }, label: '运营' }, dir)
    assert.deepEqual(first, { created: true })
    const created = await findTarget('ops', dir)
    assert.ok(created)
    const again = await upsertTarget({ id: 'ops', address: { conversationId: 'cid1' } }, dir)
    assert.deepEqual(again, { created: false })
    const updated = await findTarget('ops', dir)
    assert.ok(updated)
    assert.equal(updated.createdAt, created.createdAt)
    assert.equal(updated.address.conversationId, 'cid1')
    assert.equal(updated.label, '运营') // label 未传保留旧值
    const file = JSON.parse(readFileSync(targetsFile(dir), 'utf8'))
    assert.equal(file.version, TARGETS_VERSION)
    assert.equal(file.targets.length, 1)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('非法 targetId 抛错且不落盘', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dws-targets-'))
  try {
    await assert.rejects(() => upsertTarget({ id: 'bad/id', address: { staffId: 'x' } }, dir))
    assert.equal(existsSync(targetsFile(dir)), false)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('原子写：无 .tmp 残留；touchTarget 刷新 lastUsedAt；未知 id 静默跳过', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dws-targets-'))
  try {
    await upsertTarget({ id: 't1', address: { staffId: 's1' } }, dir)
    const before = await findTarget('t1', dir)
    assert.ok(before)
    await new Promise((r) => setTimeout(r, 5))
    await touchTarget('t1', dir)
    const after = await findTarget('t1', dir)
    assert.ok(after)
    assert.notEqual(after.lastUsedAt, before.lastUsedAt)
    await touchTarget('nope', dir) // 不抛错
    const parent = targetsFile(dir).slice(0, targetsFile(dir).lastIndexOf('/'))
    assert.deepEqual(readdirSync(parent).filter((n) => n.includes('.tmp')), [])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('损坏文件按空表处理且可恢复写入', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dws-targets-'))
  try {
    const file = targetsFile(dir)
    mkdirSync(file.slice(0, file.lastIndexOf('/')), { recursive: true })
    writeFileSync(file, 'NOT_JSON')
    assert.deepEqual(await readTargets(dir), { version: TARGETS_VERSION, targets: [] })
    await upsertTarget({ id: 'r1', address: { staffId: 's' } }, dir)
    assert.ok(await findTarget('r1', dir))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
