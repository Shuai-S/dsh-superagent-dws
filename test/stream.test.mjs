// stream.ts NDJSON 信封解析纯函数（最小导出）：extractBusiness / textOf /
// isoTime / richTextOf / collectMediaCodes / toTrigger。零网络零 CLI。
// import 自 ../lib/index.js，跑前先 pnpm build。
import test from 'node:test'
import assert from 'node:assert/strict'
import { extractBusiness, textOf, isoTime, richTextOf, collectMediaCodes, toTrigger } from '../lib/index.js'

const account = { rowProfile: '', profile: '', label: '', directMessages: true, aiTag: true, groups: [], selfIds: [] }
const line = (business, envelope = {}) => JSON.stringify({ event_type: 'user_im_message_receive_o2o_all', ...envelope, data: JSON.stringify(business) })

test('extractBusiness 三种信封形态 + 解析失败回退', () => {
  const payload = { msgId: 'm1', text: 'hi' }
  assert.deepEqual(extractBusiness({ data: JSON.stringify(payload) }), payload)      // data 字符串 → 解析
  assert.deepEqual(extractBusiness({ data: payload }), payload)                      // data 对象 → 原样
  assert.deepEqual(extractBusiness({ msgId: 'm1' }), { msgId: 'm1' })                // 无 data → 信封本身
  assert.deepEqual(extractBusiness({ data: 'not-json' }), { data: 'not-json' })      // 解析失败 → 信封
})

test('textOf 各文本形态', () => {
  assert.equal(textOf({ text: { content: 'a' } }), 'a')
  assert.equal(textOf({ content: 'b' }), 'b')
  assert.equal(textOf({ content: { text: 'c' } }), 'c')
  assert.equal(textOf({}), '')
})

test('isoTime 秒/毫秒/ISO/数字串/非法回退当前时间', () => {
  assert.equal(isoTime(1600000000), new Date(1600000000 * 1000).toISOString())
  assert.equal(isoTime(1600000000000), new Date(1600000000000).toISOString())
  assert.equal(isoTime('1600000000'), new Date(1600000000 * 1000).toISOString())
  assert.equal(isoTime('2026-01-02T03:04:05Z'), '2026-01-02T03:04:05.000Z')
  assert.match(String(isoTime(undefined)), /^\d{4}-\d{2}-\d{2}T/)
})

test('richTextOf 拼接富文本片段', () => {
  assert.equal(richTextOf({ content: { richText: [{ text: '你' }, { text: '好' }] } }), '你好')
  assert.equal(richTextOf({ richText: [{ text: 'x' }, {}] }), 'x')
  assert.equal(richTextOf({}), '')
})

test('collectMediaCodes 去重且上限 5', () => {
  const out = []
  collectMediaCodes({ mediaId: 'a', nested: { downloadCode: 'b', deep: [{ mediaId: 'c' }, { mediaId: 'a' }, { mediaId: 'd' }, { mediaId: 'e' }, { mediaId: 'f' }] } }, out)
  assert.deepEqual(out, ['a', 'b', 'c', 'd', 'e'])
})

test('单聊事件规范化为 Trigger', () => {
  const t = toTrigger(account, line({ msgId: 'm1', conversationId: 'cid1', senderStaffId: 's1', senderNick: '张三', createAt: 1600000000, text: { content: '你好' } }))
  assert.ok(t)
  assert.equal(t.id, 'dws:default:m1')
  assert.equal(t.source, 'dws')
  assert.equal(t.actor.id, 's1')
  assert.equal(t.text, '你好')
  assert.equal(t.addressed, 'direct')
  assert.equal(t.meta.isDm, true)
  assert.equal(t.meta.accountId, 'default')
  assert.equal(t.channel.address.conversation, 'cid1')
  assert.equal(t.channel.address.messageId, 'm1')
  assert.equal(t.at, new Date(1600000000 * 1000).toISOString())
})

test('群 @ 事件（mention）与白名单群全量', () => {
  const atLine = JSON.stringify({ event_type: 'user_im_message_receive_at', data: JSON.stringify({ msgId: 'm2', conversationId: 'cid2', senderStaffId: 's2', text: { content: '@dsh 帮我查' } }) })
  const t = toTrigger(account, atLine)
  assert.ok(t)
  assert.equal(t.addressed, 'mention')
  assert.equal(t.meta.isDm, false)
  // 白名单群：group_all 事件 + conversationId 命中 → 放行且非 mention 非 direct
  const groupLine = JSON.stringify({ event_type: 'user_im_message_receive_group_all', data: JSON.stringify({ msgId: 'm3', conversationId: 'cidX', senderStaffId: 's3', text: { content: '群聊' } }) })
  assert.equal(toTrigger(account, groupLine), undefined, '未列入群的非 @ 消息被丢弃')
  const whitelisted = { ...account, groups: [{ account: '', openConversationId: 'cidX', name: '' }] }
  const t3 = toTrigger(whitelisted, groupLine)
  assert.ok(t3)
  assert.equal(t3.addressed, undefined)
})

test('自己发的消息被丢弃（selfIds 命中）', () => {
  const self = { ...account, selfIds: ['me1'] }
  const t = toTrigger(self, line({ msgId: 'm4', conversationId: 'c', senderStaffId: 'me1', text: { content: '自言自语' } }))
  assert.equal(t, undefined)
})

test('缺 msgId/会话/文本 → undefined；坏行抛错', () => {
  assert.equal(toTrigger(account, line({ conversationId: 'c', text: { content: 'x' } })), undefined)
  assert.equal(toTrigger(account, line({ msgId: 'm', text: { content: 'x' } })), undefined)
  assert.equal(toTrigger(account, line({ msgId: 'm', conversationId: 'c' })), undefined)
  assert.throws(() => toTrigger(account, 'NOT_JSON'))
})

test('媒体码注入文本标记并带 meta', () => {
  const t = toTrigger(account, line({ msgId: 'm5', conversationId: 'c', senderStaffId: 's5', text: { content: '看图' }, mediaId: 'MID1' }))
  assert.ok(t)
  assert.equal(t.text, '看图\n[dws-media:MID1]')
  assert.deepEqual(t.meta.mediaCodes, ['MID1'])
})

test('账号维度进入 trigger id（多账号不串）', () => {
  const acct = { ...account, rowProfile: 'p1', profile: 'p1' }
  const t = toTrigger(acct, line({ msgId: 'm6', conversationId: 'c', senderStaffId: 's6', text: { content: 'hi' } }))
  assert.equal(t.id, 'dws:p1:m6')
})
