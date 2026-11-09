// dedup.ts 入站持久去重：seenOrAdd/seenHas、baseDir 隔离、上限 1000、串行原子写、
// 损坏恢复、空 id 防御。import 自 ../lib/index.js，跑前先 pnpm build。
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { seenHas, seenOrAdd, SEEN_CAP, seenFile } from '../lib/index.js'

test('seenOrAdd 首次 true、重复 false；seenHas 跨调用持久', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dws-dedup-'))
  try {
    assert.equal(await seenHas('accA', 'm1', dir), false)
    assert.equal(await seenOrAdd('accA', 'm1', dir), true)
    assert.equal(await seenHas('accA', 'm1', dir), true)
    assert.equal(await seenOrAdd('accA', 'm1', dir), false)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('按 storeKey（账号 profile）隔离', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dws-dedup-'))
  try {
    await seenOrAdd('accA', 'm1', dir)
    assert.equal(await seenHas('accB', 'm1', dir), false)
    assert.equal(existsSync(seenFile('accA', dir)), true)
    assert.equal(existsSync(seenFile('accB', dir)), false)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('上限 SEEN_CAP=1000：最旧被逐出', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dws-dedup-'))
  try {
    for (let i = 0; i <= SEEN_CAP; i++) await seenOrAdd('cap', 'id-' + i, dir)
    assert.equal(await seenHas('cap', 'id-0', dir), false, '最旧应被逐出')
    assert.equal(await seenHas('cap', 'id-1', dir), true, '容量 1000：仅最旧 1 条被逐出')
    assert.equal(await seenHas('cap', 'id-' + SEEN_CAP, dir), true, '最新应保留')
    assert.equal(await seenOrAdd('cap', 'id-0', dir), true, '被逐出后可重新登记')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('损坏文件按空处理并可恢复', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dws-dedup-'))
  try {
    writeFileSync(seenFile('corrupt', dir), 'NOT_JSON')
    assert.equal(await seenHas('corrupt', 'x', dir), false)
    assert.equal(await seenOrAdd('corrupt', 'x', dir), true)
    assert.equal(await seenHas('corrupt', 'x', dir), true)
    assert.deepEqual(JSON.parse(readFileSync(seenFile('corrupt', dir), 'utf8')), ['x'])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('空 id 不落盘', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dws-dedup-'))
  try {
    assert.equal(await seenOrAdd('empty', '', dir), false)
    assert.equal(await seenHas('empty', '', dir), false)
    assert.equal(existsSync(seenFile('empty', dir)), false)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('串行写：并发登记全部落盘（无读改写交错丢失）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dws-dedup-'))
  try {
    await Promise.all(Array.from({ length: 50 }, (_, i) => seenOrAdd('race', 'r-' + i, dir)))
    const ids = JSON.parse(readFileSync(seenFile('race', dir), 'utf8'))
    assert.equal(ids.length, 50)
    assert.deepEqual([...ids].sort(), Array.from({ length: 50 }, (_, i) => 'r-' + i).sort())
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
