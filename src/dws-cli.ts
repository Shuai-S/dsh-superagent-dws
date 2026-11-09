/** dws CLI process helpers: profile resolution, self identity, message send,
 *  chat listing, history reads and media download.
 *  Every call goes through execFile with an args array — no shell, no escaping. */
import { execFile } from 'node:child_process'
import { dirname, join } from 'node:path'
import type { EffectiveAccount } from './dws-kind.ts'

const TIMEOUT_MS = 30_000

function runDws(binary: string, args: string[], timeoutMs = TIMEOUT_MS): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(binary, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        const detail = String((error as { message?: string }).message ?? error).slice(0, 300)
        reject(new Error(`dws ${args[0] ?? ''} ${args[1] ?? ''} failed: ${detail}${stderr ? ' | ' + String(stderr).slice(0, 240) : ''}`))
      } else resolve(stdout)
    })
  })
}

interface ProfileList { success?: boolean; currentProfile?: string }

/** The current login profile (`corpId:userId`); '' when unresolvable. */
export async function resolveCurrentProfile(binary: string): Promise<string> {
  try {
    const parsed = JSON.parse(await runDws(binary, ['profile', 'list', '-f', 'json'])) as ProfileList
    return typeof parsed.currentProfile === 'string' ? parsed.currentProfile.trim() : ''
  } catch { return '' }
}

interface SelfResult { result?: { orgEmployeeModel?: { userId?: string } }[] }

/** The account's own ids for self-message suppression. P0 (2026-11-09): get-self
 *  returns orgEmployeeModel.userId, the same domain as the profile userId. */
export async function resolveSelfIds(binary: string, profile: string): Promise<string[]> {
  const args = ['contact', 'user', 'get-self', '-f', 'json']
  if (profile.trim()) args.push('--profile', profile.trim())
  try {
    const parsed = JSON.parse(await runDws(binary, args)) as SelfResult
    const ids = new Set<string>()
    const userId = parsed.result?.[0]?.orgEmployeeModel?.userId
    if (userId) ids.add(String(userId))
    return [...ids]
  } catch { return [] }
}

/** Sends one message as the account. Prefers the quoted reply (`message reply`,
 *  --uuid idempotency) when the original sender's openDingTalkId is known — the
 *  personal-event payload may not carry it, in which case fall back to the plain
 *  send (group --conversation-id / DM --open-dingtalk-id ?? --user). */
export async function sendDwsMessage(
  binary: string,
  account: EffectiveAccount,
  address: Record<string, string>,
  text: string,
  idempotencyKey: string,
): Promise<void> {
  const profileArgs = account.profile.trim() ? ['--profile', account.profile.trim()] : []
  const conversation = String(address.conversation ?? '').trim()
  const messageId = String(address.messageId ?? '').trim()
  const refSender = String(address.openDingTalkId ?? '').trim()
  if (conversation && messageId && refSender) {
    try {
      const reply = ['chat', 'message', 'reply', '--group', conversation, '--ref-msg-id', messageId, '--ref-sender', refSender,
        '--content', text, '--uuid', idempotencyKey.trim() || 'dsh-' + Date.now(), ...profileArgs]
      if (account.aiTag === false) reply.push('--ai-tag=false')
      await runDws(binary, reply, 45_000)
      return
    } catch (error) {
      console.error(`[dws] quoted reply failed, falling back to plain send: ${String(error).slice(0, 200)}`)
    }
  }
  const args = ['chat', 'message', 'send', ...profileArgs]
  if (address.direct === 'true') {
    const openId = String(address.openDingTalkId ?? '').trim()
    const user = String(address.user ?? '').trim()
    if (openId) args.push('--open-dingtalk-id', openId)
    else if (user) args.push('--user', user)
    else throw new Error('dws reply failed: no DM recipient in address')
  } else {
    if (!conversation) throw new Error('dws reply failed: no conversation in address')
    args.push('--conversation-id', conversation)
  }
  if (account.aiTag === false) args.push('--ai-tag=false')
  if (idempotencyKey.trim()) args.push('--idempotency-key', idempotencyKey.trim())
  args.push('--content', text)
  await runDws(binary, args, 45_000)
}

interface ChatListItem { openConversationId?: string; openChatId?: string; id?: string; cid?: string; name?: string; title?: string }

function pickChatArray(parsed: unknown): ChatListItem[] {
  const root = parsed as Record<string, unknown>
  const candidates = [root.items, root.chats, root.result, root.conversations, root.list]
  for (const value of candidates) {
    if (Array.isArray(value)) return value as ChatListItem[]
    if (value && typeof value === 'object') {
      const nested = value as Record<string, unknown>
      for (const inner of [nested.items, nested.chats, nested.list]) if (Array.isArray(inner)) return inner as ChatListItem[]
    }
  }
  return []
}

/** The account's joined chats (group by default) for label refresh. */
export async function listChats(binary: string, profile: string, pageAll = false): Promise<{ id: string; name: string }[]> {
  const args = ['chat', '+chat-list', '--page-size', '100']
  if (profile.trim()) args.push('--profile', profile.trim())
  if (pageAll) args.push('--page-all')
  const parsed = JSON.parse(await runDws(binary, args)) as unknown
  return pickChatArray(parsed)
    .map((item) => ({ id: String(item.openConversationId ?? item.openChatId ?? item.id ?? item.cid ?? '').trim(), name: String(item.name ?? item.title ?? '').trim() }))
    .filter((chat) => chat.id && chat.name)
}

/** Shanghai wall-clock string (yyyy-MM-dd HH:mm:ss) for the CLI --time flags. */
export function shanghaiTime(iso: string): string {
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) return ''
  return new Date(ms + 8 * 3600_000).toISOString().slice(0, 19).replace('T', ' ')
}

interface MessageListItem { messageId?: string; openMessageId?: string; text?: unknown; content?: unknown; senderNick?: string; senderStaffId?: string; senderId?: string; createTime?: unknown; createAt?: unknown }

function pickMessages(parsed: unknown): MessageListItem[] {
  const root = parsed as Record<string, unknown>
  if (Array.isArray(root.messages)) return root.messages as MessageListItem[]
  const result = root.result
  if (result && typeof result === 'object' && Array.isArray((result as Record<string, unknown>).messages)) {
    return (result as Record<string, unknown>).messages as MessageListItem[]
  }
  return []
}

/** One bounded page of a conversation's history; the CLI documents stable
 *  `messageId` and `text` fields (content/openMessageId kept for compatibility). */
export async function listMessages(binary: string, profile: string, options: { conversationId: string; time?: string; direction?: 'newer' | 'older'; limit: number }): Promise<{ id: string; from: string; at: string; text: string }[]> {
  const args = ['chat', 'message', 'list', '--conversation-id', options.conversationId, '--limit', String(options.limit)]
  if (profile.trim()) args.push('--profile', profile.trim())
  if (options.time) args.push('--time', options.time)
  if (options.direction) args.push('--direction', options.direction)
  const parsed = JSON.parse(await runDws(binary, args)) as unknown
  return pickMessages(parsed)
    .map((m) => ({
      id: String(m.messageId ?? m.openMessageId ?? '').trim(),
      from: String(m.senderNick ?? m.senderStaffId ?? m.senderId ?? '').trim(),
      at: typeof m.createTime === 'number' ? new Date(m.createTime).toISOString()
        : typeof m.createAt === 'number' ? new Date(m.createAt).toISOString() : String(m.createTime ?? m.createAt ?? ''),
      text: typeof m.text === 'string' ? m.text : typeof m.content === 'string' ? m.content : '',
    }))
    .filter((m) => m.id && m.text)
}

/** Downloads one chat-message media resource (mediaId domain) to outputPath. */
export async function downloadMedia(binary: string, profile: string, target: { mediaId: string; messageId: string; conversationId: string; outputPath: string }): Promise<void> {
  const args = ['chat', 'message', 'download-media', '--type', 'mediaId', '--resource-id', target.mediaId,
    '--message-id', target.messageId, '--open-conversation-id', target.conversationId, '--output', target.outputPath]
  if (profile.trim()) args.push('--profile', profile.trim())
  await runDws(binary, args, 120_000)
}

export interface DwsProfileInfo { profile: string; corpName?: string; userName?: string; isCurrent?: boolean }

interface ProfileListFull { currentProfile?: string; profiles?: DwsProfileInfo[] }

/** All logged-in profiles (the multi-account surface the login card lists). */
export async function listProfiles(binary: string): Promise<DwsProfileInfo[]> {
  try {
    const parsed = JSON.parse(await runDws(binary, ['profile', 'list', '-f', 'json'])) as ProfileListFull
    return Array.isArray(parsed.profiles) ? parsed.profiles : []
  } catch { return [] }
}

/** Binary candidates in resolution order: the configured value (when explicit),
 *  then the npm -g bin beside the running node (fnm/official layouts), then PATH. */
export function binaryCandidates(configBinary: string): string[] {
  const out: string[] = []
  const push = (p: string): void => { if (p && !out.includes(p)) out.push(p) }
  const configured = configBinary.trim()
  if (configured && configured !== 'dws') push(configured)
  push(join(dirname(process.execPath), 'dws'))
  push('dws')
  return out
}

/** Probes one binary; returns the parsed version, or null when unusable. */
export async function probeBinary(path: string): Promise<string | null> {
  try {
    const stdout = await new Promise<string>((resolve, reject) => {
      execFile(path, ['--version'], { timeout: 10_000, windowsHide: true }, (error, out) => error ? reject(error) : resolve(String(out)))
    })
    return /v?(\d+\.\d+\.\d+)/.exec(stdout)?.[1] ?? null
  } catch { return null }
}
