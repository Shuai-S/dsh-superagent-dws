// acl.ts（vendored canonical）+ 配置 schema policy 字段接线：evaluateAcl 判定用例、
// 双语回执取词、aclInputFor 会话类型映射、DwsConfigSchema 校验（不设=全放行；形状非法
// 按 schema 拒绝，不做静默降级）。import 自 ../lib/index.js，跑前先 pnpm build。
import test from 'node:test'
import assert from 'node:assert/strict'
import { evaluateAcl, aclDenyNoticeText, DwsConfigSchema, aclInputFor, toTrigger } from '../lib/index.js'

const policy = (over = {}) => ({ mode: 'allowlist', allowUsers: ['staff1'], ...over })
const account = { rowProfile: '', profile: '', label: '', directMessages: true, aiTag: true, groups: [], selfIds: [] }
const line = (business, envelope = {}) => JSON.stringify({ event_type: 'user_im_message_receive_o2o_all', ...envelope, data: JSON.stringify(business) })

test('policy 缺省 / mode=open → 全放行（向后兼容）', () => {
  assert.deepEqual(evaluateAcl(undefined, { actorId: 'anyone' }), { allowed: true })
  assert.deepEqual(evaluateAcl({ mode: 'open', allowUsers: [] }, { actorId: 'anyone' }), { allowed: true })
})

test('allowlist 精确匹配：命中放行，未命中拒绝且带缺省双语文案', () => {
  assert.deepEqual(evaluateAcl(policy(), { actorId: 'staff1' }), { allowed: true })
  const denied = evaluateAcl(policy(), { actorId: 'staff2' })
  assert.equal(denied.allowed, false)
  assert.equal(denied.reason, 'allowlist')
  assert.equal(denied.denyText?.zh, '该机器人未向你开放。')
  assert.equal(denied.denyText?.en, 'This bot is not open to you.')
})

test('allowUsers 大小写敏感；空 actorId fail-closed', () => {
  assert.equal(evaluateAcl(policy(), { actorId: 'Staff1' }).allowed, false)
  assert.equal(evaluateAcl(policy(), { actorId: '' }).reason, 'allowlist')
})

test('groupOnly：single 拒绝、group 放行（dws 可靠区分群/单聊）', () => {
  assert.equal(evaluateAcl(policy({ groupOnly: true }), { actorId: 'staff1', conversationType: 'single' }).allowed, false)
  assert.equal(evaluateAcl(policy({ groupOnly: true }), { actorId: 'staff1', conversationType: 'group' }).allowed, true)
})

test('自定义 denyText 生效；aclDenyNoticeText 按 lang 取词', () => {
  const v = evaluateAcl(policy({ denyText: { zh: '没门', en: 'Nope' } }), { actorId: 'stranger' })
  assert.equal(aclDenyNoticeText(v, 'zh'), '没门')
  assert.equal(aclDenyNoticeText(v, 'en'), 'Nope')
  assert.equal(aclDenyNoticeText({ allowed: true }, 'zh'), '该机器人未向你开放。')
})

test('接线：aclInputFor 映射 toTrigger 产物（单聊 → single；群/@ → group）', () => {
  const dm = toTrigger(account, line({ msgId: 'm1', conversationId: 'c1', senderStaffId: 's1', text: { content: 'hi' } }))
  assert.ok(dm)
  assert.deepEqual(aclInputFor(dm), { actorId: 's1', conversationType: 'single' })
  const atLine = JSON.stringify({ event_type: 'user_im_message_receive_at', data: JSON.stringify({ msgId: 'm2', conversationId: 'c2', senderStaffId: 's2', text: { content: '@x' } }) })
  const group = toTrigger(account, atLine)
  assert.ok(group)
  assert.deepEqual(aclInputFor(group), { actorId: 's2', conversationType: 'group' })
})

test('接线：DwsConfigSchema 接受 policy 且缺省 undefined', () => {
  const bare = DwsConfigSchema.parse({})
  assert.equal(bare.policy, undefined)
  const withPolicy = DwsConfigSchema.parse({
    policy: { mode: 'allowlist', allowUsers: ['s1'], groupOnly: true, denyText: { zh: 'x', en: 'y' } },
  })
  assert.deepEqual(withPolicy.policy, { mode: 'allowlist', allowUsers: ['s1'], groupOnly: true, denyText: { zh: 'x', en: 'y' } })
})

test('接线：policy 形状非法按 schema 拒绝（400/配置报错，不静默降级）', () => {
  assert.throws(() => DwsConfigSchema.parse({ policy: { mode: 'allowlist' } }), undefined, undefined) // 缺 allowUsers
  assert.throws(() => DwsConfigSchema.parse({ policy: { mode: 'nope', allowUsers: [] } }))            // mode 枚举外
  assert.throws(() => DwsConfigSchema.parse({ policy: { mode: 'allowlist', allowUsers: [], extra: 1 } })) // strict 未知字段
})
