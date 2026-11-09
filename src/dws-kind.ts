/** The 'dws' Source kind: personal-identity DingTalk through the dws CLI.
 *  Multi-account is a flat accounts[] + groups[] pair (mail-style; the engine
 *  keeps one config slot per kind), every key carries the account dimension so
 *  two accounts sharing a group never collide. Shape mirrors the dingtalk/mail
 *  kinds; the engine duck-types it at runtime. */
import { mkdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import type { Localized, OutboundMessageLike, SourceKindLike, TriggerLike } from './types.ts'
import { downloadMedia, listChats, listMessages, sendDwsMessage, shanghaiTime } from './dws-cli.ts'
import { logSendFailure } from './failure-log.ts'

export const HEALTH_ENTRY = 'dwsStream'

const emptyLink = (label: Localized) => ({ url: '', label })

interface StateLike { get<V>(key: string): V | undefined; set<V>(key: string, value: V | undefined): void }
interface ScopeOutcome { listened: boolean; observed?: boolean; row?: string; reason?: string }

export const AccountRowSchema = z.object({
  profile: z.string().default(''),
  label: z.string().default(''),
  directMessages: z.boolean().default(true),
  aiTag: z.boolean().default(true),
}).strict()
export const GroupRowSchema = z.object({
  account: z.string().default(''),
  openConversationId: z.string().min(1),
  name: z.string().default(''),
}).strict()

export const DwsConfigSchema = z.object({
  dwsBinary: z.string().default('dws'),
  coalesceMs: z.number().int().min(500).max(15000).default(2000),
  readPageSize: z.number().int().min(1).max(50).default(20),
  accounts: z.array(AccountRowSchema).default([]),
  groups: z.array(GroupRowSchema).default([]),
}).strict()
  .refine((cfg) => cfg.accounts.filter((a) => !a.profile.trim()).length <= 1, 'At most one account may leave profile empty (current login)')
  .refine((cfg) => cfg.groups.every((g) => !g.account.trim() || cfg.accounts.some((a) => a.profile.trim() === g.account.trim())), 'Group account must match a configured account profile')
export type DwsConfig = z.infer<typeof DwsConfigSchema>
export type AccountRow = z.infer<typeof AccountRowSchema>
export type GroupRow = z.infer<typeof GroupRowSchema>

export interface EffectiveAccount {
  rowProfile: string
  profile: string
  label: string
  directMessages: boolean
  aiTag: boolean
  groups: GroupRow[]
  selfIds: string[]
}

export const idOf = (row: { profile: string }): string => row.profile.trim() || 'default'

/** Maps configured account rows onto effective accounts: a '' profile row uses
 *  the current login (resolved by the watcher), and a '' group account attaches
 *  to the default row (the '' row, else the first row). */
export function resolveAccounts(config: DwsConfig, currentProfile: string): EffectiveAccount[] {
  const rows = config.accounts
  const defaultRow = rows.find((r) => !r.profile.trim()) ?? rows[0]
  return rows.map((row) => ({
    rowProfile: row.profile.trim(),
    profile: row.profile.trim() || currentProfile,
    label: row.label.trim(),
    directMessages: row.directMessages,
    aiTag: row.aiTag,
    groups: config.groups.filter((g) => {
      const want = g.account.trim()
      if (!want) return row === defaultRow
      return want === row.profile.trim()
    }),
    selfIds: [],
  }))
}

// channel.send reads config through this holder; watch() refreshes it every round.
// binary = watcher-resolved executable (silent-install aware); overrides config.dwsBinary.
export const channelConfig: { current?: { config: DwsConfig; accounts: EffectiveAccount[]; binary?: string } } = {}

/** The effective dws binary for host-side CLI calls. */
export const activeBinary = (holder: { config: DwsConfig; binary?: string } | undefined): string =>
  holder?.binary ?? holder?.config.dwsBinary ?? 'dws'

/** Media keys embedded by the event normalizer; keys must come from the original
 *  text so an assessor cannot reference arbitrary media. */
const mediaKeysOf = (text: string): string[] =>
  [...new Set([...text.matchAll(/\[dws-media:([^\]]+)\]/g)].map((m) => m[1] ?? ''))].filter(Boolean)

function sniffImageMime(data: Buffer): string {
  if (data.length > 8 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) return 'image/png'
  if (data.length > 3 && data[0] === 0xff && data[1] === 0xd8) return 'image/jpeg'
  if (data.length > 6 && data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46) return 'image/gif'
  if (data.length > 12 && data[8] === 0x57 && data[9] === 0x45 && data[10] === 0x42 && data[11] === 0x50) return 'image/webp'
  return ''
}

interface DwsKindLike extends SourceKindLike {
  scope(input: { meta: Record<string, unknown> }, config: DwsConfig): ScopeOutcome
  refreshLabels?(host: unknown, signal?: AbortSignal): Promise<Record<string, string>>
}

export const dwsKind: DwsKindLike = {
  kind: 'dws',
  title: { zh: '钉钉个人（dws）', en: 'DingTalk personal (dws)' },
  description: {
    zh: '复用 dws CLI 的个人登录态：你在群里被 @、单聊消息与所配群消息成为工作候选，回复以你的身份发出（默认带 AI 角标）。需本机已 dws auth login。',
    en: 'Reuses the dws CLI personal login: messages that @ you, direct messages and configured group chats become work candidates; replies go out as you (AI badge on by default). Requires dws auth login on this machine.',
  },
  schema: DwsConfigSchema,
  fields: [
    { key: 'accounts', type: 'rows', dialog: true, label: { zh: '钉钉账号', en: 'DingTalk accounts' }, columns: [
      { key: 'profile', type: 'text', label: { zh: 'Profile', en: 'Profile' }, optional: true, hint: { zh: 'corpId:userId，来自 dws profile list；留空 = 当前登录账号（最多一行留空）', en: 'corpId:userId from dws profile list; empty = current login (at most one empty row)' } },
      { key: 'label', type: 'text', label: { zh: '名称', en: 'Label' }, optional: true },
      { key: 'directMessages', type: 'switch', label: { zh: '接收单聊', en: 'Direct messages' } },
      { key: 'aiTag', type: 'switch', label: { zh: 'AI 角标', en: 'AI badge' }, hint: { zh: '回复消息带「AI」角标，默认开启', en: 'Mark replies with the AI badge (default on)' } },
    ] },
    { key: 'groups', type: 'rows', dialog: true, label: { zh: '接收全部消息的群', en: 'Groups received in full' }, columns: [
      { key: 'account', type: 'text', label: { zh: '所属账号 Profile', en: 'Account profile' }, optional: true, hint: { zh: 'accounts 里该账号 profile 的原文；留空 = 默认账号', en: 'The account profile verbatim; empty = default account' } },
      { key: 'openConversationId', type: 'text', label: { zh: '会话 ID（cid 开头）', en: 'Conversation ID (cid...)' },
        choose: { zh: '选择已加入的群', en: 'Choose a joined chat' }, refresh: { zh: '刷新群列表', en: 'Refresh chats' } },
      { key: 'name', type: 'text', label: { zh: '群名', en: 'Name' }, optional: true },
    ] },
    { key: 'coalesceMs', type: 'number', advanced: true, min: 500, max: 15000, label: { zh: '合并窗口 / 毫秒', en: 'Coalesce window / ms' }, hint: { zh: '同一条消息会经「@我」与「群消息」两个事件各到一次，窗口内合并 mention 标记', en: 'One message arrives via both the at and the group events; mentions merge within this window' } },
    { key: 'readPageSize', type: 'number', advanced: true, min: 1, max: 50, label: { zh: '每页消息数', en: 'Messages per page' }, hint: { zh: '智能体读取会话历史时每页的消息数（dws chat message list）', en: 'Messages per page when agents read conversation history (dws chat message list)' } },
    { key: 'dwsBinary', type: 'text', advanced: true, label: { zh: 'dws 可执行文件', en: 'dws binary' }, hint: { zh: '命令名或绝对路径；需已 dws auth login', en: 'Command name or absolute path; requires dws auth login' } },
  ],
  health: ['dwsStream'],
  // Rereads the joined-chat names (KV.sources.labels) so panel rows show real names.
  refreshLabels: async (host: unknown, signal?: AbortSignal) => {
    const holder = channelConfig.current
    if (!holder) return {}
    const labels: Record<string, string> = {}
    for (const account of holder.accounts) {
      if (signal?.aborted) break
      try {
        for (const chat of await listChats(activeBinary(holder), account.profile)) labels[chat.id] = chat.name
      } catch (error) {
        console.error(`[dws] chat list failed for ${account.profile || 'default'}: ${String(error).slice(0, 200)}`)
      }
    }
    const ctx = (host as { context?: (kind: unknown) => { state?: StateLike } }).context?.(dwsKind)
    ctx?.state?.set('labels', labels)
    return labels
  },
  scope(input: { meta: Record<string, unknown> }, config: DwsConfig): ScopeOutcome {
    const accountId = String(input.meta.accountId ?? '')
    const rows = config.accounts
    const row = rows.find((a) => idOf(a) === accountId)
    if (!row) return { listened: false, reason: 'dws: account not configured: ' + accountId }
    const rowId = idOf(row)
    if (input.meta.isDm === true) {
      return row.directMessages
        ? { listened: true, observed: false, row: rowId }
        : { listened: false, reason: 'dws: direct messages disabled' }
    }
    const conversation = String(input.meta.conversationId ?? '')
    const defaultRow = rows.find((r) => !r.profile.trim()) ?? rows[0]
    const listed = config.groups.some((g) => g.openConversationId === conversation
      && (g.account.trim() ? g.account.trim() === row.profile.trim() : row === defaultRow))
    if (listed) return { listened: true, observed: true, row: rowId }
    if (input.meta.mentioned === true) return { listened: true, observed: false, row: rowId }
    return { listened: false, reason: 'dws: chat not configured: ' + conversation }
  },
  channel: {
    allowed: (address: Record<string, string>, config: DwsConfig) =>
      dwsKind.scope({ meta: {
        accountId: String(address.account ?? ''),
        isDm: address.direct === 'true',
        conversationId: String(address.conversation ?? ''),
        ...(address.mentioned === 'true' ? { mentioned: true } : {}),
      } }, config).listened,
    async send(_host: unknown, message: OutboundMessageLike): Promise<'sent' | 'gone'> {
      try {
        const holder = channelConfig.current
        if (!holder) throw new Error('dws: channel not ready (no active account yet)')
        const address = message.channel.address as Record<string, string>
        const account = holder.accounts.find((a) => idOf(a) === String(address.account ?? ''))
        if (!account) throw new Error('dws: account not active: ' + String(address.account ?? ''))
        await sendDwsMessage(activeBinary(holder), account, address, message.text, message.id)
        return 'sent'
      } catch (error) {
        // 失败日志（failure-log.ts）：先记 JSONL 再原样 throw，引擎照常退避重试，日志只做旁证。
        // channelKey = 账号 + 会话（均非凭据）；写失败不影响主流程。
        const address = (message?.channel?.address ?? {}) as Record<string, string>
        await logSendFailure({
          channelKey: String(address.account ?? '?') + (address.conversation ? ':' + address.conversation : ''),
          kind: 'send',
          error: error instanceof Error ? error.message : String(error),
        }).catch(() => undefined)
        throw error
      }
    },
    link(address: Record<string, string>) {
      return emptyLink({ zh: '钉钉 ' + String(address.conversation ?? '').slice(0, 12), en: 'DingTalk ' + String(address.conversation ?? '').slice(0, 12) })
    },
  },
  threadContext: {
    messageId(trigger: TriggerLike): string {
      return String(trigger.meta.messageId ?? '')
    },
    images(text: string): string[] {
      return mediaKeysOf(text)
    },
    async image(agent: unknown, _commands: unknown, trigger: TriggerLike, message: { id: string; text: string }, key: string, _stateDir: string, signal: AbortSignal) {
      if (!mediaKeysOf(message.text).includes(key)) throw new Error('Choose a media key from this source message')
      const holder = channelConfig.current
      if (!holder) throw new Error('dws: channel not ready (no active account yet)')
      const account = holder.accounts.find((a) => idOf(a) === String(trigger.meta.accountId ?? ''))
      const conversationId = String(trigger.meta.conversationId ?? '')
      const messageId = String(trigger.meta.messageId ?? '')
      if (!account || !conversationId || !messageId) throw new Error('dws: image download needs the originating account, conversation and message')
      const host = agent as {
        ctx?: { get?: (name: string) => unknown }
        session?: { requestHeader?: () => { config?: { provider?: string; model?: string } } }
        options?: { provider?: string; model?: string }
      }
      const attachments = host.ctx?.get?.('attachments') as {
        saveImage: (input: { data: Buffer; mediaType: string; name: string }) => Promise<unknown>
        imageLimits?: { maxImageBytes?: number; maxMessageImageBytes?: number }
      } | undefined
      if (!attachments?.saveImage) throw new Error('Image reading is unavailable: no attachment service is mounted')
      const route = host.session?.requestHeader?.()?.config
      const provider = route?.provider ?? host.options?.provider
      const model = route?.model ?? host.options?.model
      const llm = host.ctx?.get?.('llm') as { resolveModelInfo?: (p: string, m: string, s: AbortSignal) => Promise<{ inputModalities?: string[] }> } | undefined
      if (!llm?.resolveModelInfo || !provider || !model) throw new Error('Image reading is unavailable: the current model route is unresolved')
      const info = await llm.resolveModelInfo(provider, model, signal)
      if (!info.inputModalities?.includes('image')) throw new Error(`Model ${model} does not support image input; the image has not been inspected`)
      signal.throwIfAborted()
      const dir = join(homedir(), '.dsh', 'dws-attachments', messageId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 60))
      await mkdir(dir, { recursive: true })
      const target = join(dir, `dws-${key.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40) || 'media'}.bin`)
      await downloadMedia(activeBinary(holder), account.profile, { mediaId: key, messageId, conversationId, outputPath: target })
      signal.throwIfAborted()
      const data = await readFile(target)
      const mediaType = sniffImageMime(data)
      if (!mediaType) throw new Error('The downloaded resource is not a supported image (png/jpeg/gif/webp)')
      const maxBytes = Math.min(attachments.imageLimits?.maxImageBytes ?? 20 * 1024 * 1024, attachments.imageLimits?.maxMessageImageBytes ?? 20 * 1024 * 1024)
      if (data.length > maxBytes) throw new Error(`The image exceeds the ${maxBytes} byte limit`)
      const name = `dws-${key.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 24) || 'image'}.${mediaType.split('/')[1]}`
      const image = await attachments.saveImage({ data, mediaType, name })
      signal.throwIfAborted()
      return { source_message_id: message.id, image_key: key, image }
    },
    async read(_commands: unknown, trigger: TriggerLike, part: 'thread' | 'root' | 'parent', _cursor: string | undefined, config: DwsConfig) {
      const from = String(trigger.meta.senderNick ?? trigger.actor.id)
      const own = { id: String(trigger.meta.messageId ?? trigger.id), from, at: trigger.at, text: trigger.text }
      if (part === 'parent') return { messages: [], body: {}, status: undefined }
      if (part !== 'thread') return { messages: [own], body: {}, status: undefined }
      // 'thread': the conversation messages after the trigger, via dws chat message list.
      const conversation = String(trigger.meta.conversationId ?? '')
      const holder = channelConfig.current
      if (!conversation || !holder) return { messages: [own], body: {}, status: undefined }
      const account = holder.accounts.find((a) => idOf(a) === String(trigger.meta.accountId ?? ''))
      const messages = await listMessages(activeBinary(holder), account?.profile ?? '', {
        conversationId: conversation,
        time: shanghaiTime(trigger.at),
        direction: 'newer',
        limit: config.readPageSize,
      }).catch((error: unknown) => {
        console.error(`[dws] history read failed: ${String(error).slice(0, 200)}`)
        return [] as { id: string; from: string; at: string; text: string }[]
      })
      return { messages: [own, ...messages.filter((m) => m.id !== own.id)], body: {}, status: undefined }
    },
  },
  // Variables the execution environment exposes to worker sessions.
  environment: {
    variables: [
      { key: 'DSH_SUPERAGENT_DWS_ACCOUNT', description: { zh: '触发工单的钉钉账号 profile；工单不是从 dws 来的时为空', en: 'The DingTalk account profile that started the ticket; empty when it did not start on dws' } },
      { key: 'DSH_SUPERAGENT_DWS_CHAT', description: { zh: '接下工单的钉钉会话 ID；工单不是从 dws 来的时为空', en: 'The conversation id that started the ticket; empty when it did not start on dws' } },
    ],
    values: (input: { trigger?: TriggerLike | null }) => ({
      DSH_SUPERAGENT_DWS_ACCOUNT: input.trigger?.source === 'dws' ? String(input.trigger.meta.accountId ?? '') : '',
      DSH_SUPERAGENT_DWS_CHAT: input.trigger?.source === 'dws' ? String(input.trigger.meta.conversationId ?? '') : '',
    }),
  },
  policy: {
    schema: z.object({
      allowed: z.array(z.object({ id: z.string(), name: z.string().optional() }).strict()).default([]),
    }).strict(),
    fields: [
      { key: 'allowed', type: 'rows', label: { zh: '允许派活的成员', en: 'Allowed members' }, columns: [
        { key: 'id', type: 'text', label: { zh: '成员 ID', en: 'Member ID' }, hint: { zh: '事件里的发送者 ID（userId 域，以真实事件实测为准）', en: 'Sender id from events (userId domain; confirm on real events)' } },
        { key: 'name', type: 'text', label: { zh: '名称', en: 'Name' }, optional: true },
      ] },
    ],
    explicit: { zh: '名单内的人在群里 @ 你，或向你发单聊（@ 的是你本人，AI 以你的身份应答）', en: 'Someone on the list @-mentions you in a group or DMs you (the mention targets you; the AI answers as you)' },
    rows(config: Record<string, unknown>) {
      const cfg = DwsConfigSchema.parse(config)
      const defaultRow = cfg.accounts.find((r) => !r.profile.trim()) ?? cfg.accounts[0]
      const rows: { id: string; label: Localized | string; note: Localized; cells: { listedUnaddressed: boolean; unlistedAddressed: boolean; unlistedUnaddressed: boolean } }[] = []
      for (const row of cfg.accounts) {
        const rowId = idOf(row)
        const label = row.label.trim() || row.profile.trim() || '当前账号'
        for (const g of cfg.groups) {
          const mine = g.account.trim() ? g.account.trim() === row.profile.trim() : row === defaultRow
          if (!mine) continue
          rows.push({
            id: rowId + ':' + g.openConversationId,
            label: g.name.trim() || g.openConversationId,
            note: { zh: '群聊（接收全部消息；未列群仅 @ 可指派）', en: 'Group chat (all messages received; only @ assigns in unlisted chats)' },
            cells: { listedUnaddressed: true, unlistedAddressed: true, unlistedUnaddressed: false },
          })
        }
        if (row.directMessages) {
          rows.push({
            id: rowId + ':direct',
            label: label + ' · 单聊',
            note: { zh: '单聊消息均为明确指派', en: 'DMs are explicit assignments' },
            cells: { listedUnaddressed: true, unlistedAddressed: true, unlistedUnaddressed: true },
          })
        }
      }
      return rows
    },
  },
}
