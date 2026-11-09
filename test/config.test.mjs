// DwsConfigSchema 默认值与拒绝路径（zod strict + refine）。
// import 自 ../lib/index.js，跑前先 pnpm build。
import test from 'node:test'
import assert from 'node:assert/strict'
import { DwsConfigSchema } from '../lib/index.js'

test('默认值：空对象补全全部字段', () => {
  const cfg = DwsConfigSchema.parse({})
  assert.equal(cfg.dwsBinary, 'dws')
  assert.equal(cfg.coalesceMs, 2000)
  assert.equal(cfg.readPageSize, 20)
  assert.deepEqual(cfg.accounts, [])
  assert.deepEqual(cfg.groups, [])
})

test('账号行默认值（profile/label 空串，开关默认开）', () => {
  const cfg = DwsConfigSchema.parse({ accounts: [{}] })
  assert.deepEqual(cfg.accounts[0], { profile: '', label: '', directMessages: true, aiTag: true })
})

test('拒绝未知字段（strict）', () => {
  assert.throws(() => DwsConfigSchema.parse({ nope: 1 }))
  assert.throws(() => DwsConfigSchema.parse({ accounts: [{ profile: 'p', ghost: 1 }] }))
})

test('拒绝超过一个空 profile 账号（当前登录行唯一）', () => {
  assert.throws(() => DwsConfigSchema.parse({ accounts: [{ profile: '' }, { profile: '  ' }] }))
  // 一个空 + 一个非空：合法
  const cfg = DwsConfigSchema.parse({ accounts: [{ profile: '' }, { profile: 'p1' }] })
  assert.equal(cfg.accounts.length, 2)
})

test('拒绝挂在未配置账号上的群', () => {
  assert.throws(() => DwsConfigSchema.parse({
    accounts: [{ profile: 'p1' }],
    groups: [{ account: 'ghost', openConversationId: 'cid1' }],
  }))
  // 群账号匹配已配置 profile：合法
  const cfg = DwsConfigSchema.parse({
    accounts: [{ profile: 'p1' }],
    groups: [{ account: 'p1', openConversationId: 'cid1' }],
  })
  assert.equal(cfg.groups.length, 1)
})

test('coalesceMs/readPageSize 越界拒绝', () => {
  assert.throws(() => DwsConfigSchema.parse({ coalesceMs: 100 }))
  assert.throws(() => DwsConfigSchema.parse({ coalesceMs: 20000 }))
  assert.throws(() => DwsConfigSchema.parse({ readPageSize: 0 }))
  assert.throws(() => DwsConfigSchema.parse({ readPageSize: 51 }))
})

test('群 openConversationId 非空约束', () => {
  assert.throws(() => DwsConfigSchema.parse({ groups: [{ openConversationId: '' }] }))
})
