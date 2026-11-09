/** Per-account consume lifecycle: the dws CLI allows exactly one consumer per
 *  identity (a concurrent second consume fails server-side with subscribeUser,
 *  P0 2026-11-09), so every account runs ONE `dws event consume` process
 *  carrying all IM event keys, with group messages whitelisted locally. NDJSON
 *  lines are normalized into Triggers: mention coalescing merges the at/group
 *  deliveries of one message, exact redeliveries are deduped, and crashes
 *  restart with exponential backoff. Health goes to the single `dwsStream`
 *  entry, details prefixed with the account label. */
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { setTimeout as delay } from 'node:timers/promises'
import type { SourceContextLike, TriggerLike } from './types.ts'
import { HEALTH_ENTRY, channelConfig, resolveAccounts, type DwsConfig, type EffectiveAccount } from './dws-kind.ts'
import { listProfiles, resolveSelfIds, type DwsProfileInfo } from './dws-cli.ts'
import { binaryState, ensureInstalled, installState } from './install.ts'
import { seenHas, seenOrAdd } from './dedup.ts'

/** The three IM keys carried by every account process: all parameterless, so
 *  they share one consume call (P0 dry-run accepted subscription[0..2]); user-
 *  class and group-rule keys could not mix in one call, which is why no
 *  per-group --group subscription is used. */
const CONSUME_KEYS = ['user_im_message_receive_at', 'user_im_message_receive_o2o_all', 'user_im_message_receive_group_all'] as const

const SEEN_TTL_MS = 10 * 60_000
const SEEN_CAP = 1200
const PENDING_CAP = 200

export function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) { resolve(); return }
    const timer = setTimeout(() => { signal.removeEventListener('abort', stop); resolve() }, ms)
    const stop = (): void => { clearTimeout(timer); resolve() }
    signal.addEventListener('abort', stop, { once: true })
  })
}

const accountLabel = (account: EffectiveAccount): string => account.label || account.profile || 'default'

/** 1 s after a run that stayed up for a minute, otherwise exponential backoff up to 60 s. */
const consumerRetry = (previous: number | undefined, ranMs: number): number =>
  previous === undefined || ranMs >= 60_000 ? 1000 : Math.min(previous * 2, 60_000)

interface AccountState {
  seen: Map<string, number>
  pending: Map<string, { trigger: TriggerLike; timer: ReturnType<typeof setTimeout> }>
  chain: Promise<void>
}

export async function watch(source: SourceContextLike, signal: AbortSignal): Promise<void> {
  const runners = new Map<string, { key: string; stop: () => void; done: Promise<void> }>()
  let profileCache: { at: number; profiles: DwsProfileInfo[] } = { at: 0, profiles: [] }
  while (!signal.aborted) {
    const config = source.config<DwsConfig>('dws')
    if (!config || config.accounts.length === 0) {
      source.report(HEALTH_ENTRY, { state: 'paused', detail: 'waiting for account configuration' })
      channelConfig.current = undefined
      await pause(5000, signal)
      continue
    }
    // M3/M1：二进制可用性——缺失时按源静默安装（npmmirror → npm 官方）。
    const binary = await ensureInstalled(config.dwsBinary)
    if (!binary) {
      const st = installState()
      source.report(HEALTH_ENTRY, st.phase === 'installing'
        ? { state: 'starting', detail: 'dws CLI 未安装，正在静默安装（源 ' + (st.registry ?? '') + '，第 ' + st.attempt + '/' + st.total + ' 次）…' }
        : { state: 'error', detail: 'dws CLI 未安装且自动安装失败：' + (st.error ?? 'unknown') + '；可手动 npm i -g dingtalk-workspace-cli' })
      channelConfig.current = undefined
      await pause(5000, signal)
      continue
    }
    binaryState.path = binary.path
    binaryState.version = binary.version
    if (Date.now() - profileCache.at > 30_000) {
      profileCache = { at: Date.now(), profiles: await listProfiles(binary.path) }
    }
    if (profileCache.profiles.length === 0) {
      // M1：未登录不给 consume 拉起机会（省得 subscribeUser 报错退避循环）。
      source.report(HEALTH_ENTRY, { state: 'paused', detail: 'dws 未登录：打开面板「钉钉登录」页完成设备流登录，或终端运行 dws auth login' })
      channelConfig.current = { config, accounts: resolveAccounts(config, ''), binary: binary.path }
      await pause(5000, signal)
      continue
    }
    const currentProfile = profileCache.profiles.find((p) => p.isCurrent === true)?.profile ?? profileCache.profiles[0]?.profile ?? ''
    const effective = resolveAccounts(config, currentProfile)
    channelConfig.current = { config, accounts: effective, binary: binary.path }
    const wanted = new Set<string>()
    for (const account of effective) {
      const id = accountLabel(account)
      wanted.add(id)
      // Only consume-affecting fields may trigger a respawn; aiTag/label changes apply through the holder.
      const key = JSON.stringify([account.profile, account.directMessages,
        account.groups.map((g) => [g.account, g.openConversationId]), config.dwsBinary, config.coalesceMs])
      const existing = runners.get(id)
      if (existing && existing.key === key) continue
      existing?.stop()
      runners.delete(id)
      if (signal.aborted) break
      const controller = new AbortController()
      const done = runAccount(source, controller.signal, account, config, binary.path).catch((error: unknown) => {
        console.error(`[dws] account runner ${id} crashed: ${String(error).slice(0, 240)}`)
      })
      runners.set(id, { key, stop: () => controller.abort(), done })
    }
    for (const [id, runner] of [...runners]) {
      if (!wanted.has(id)) { runner.stop(); runners.delete(id) }
    }
    await pause(5000, signal)
  }
  for (const [, runner] of runners) runner.stop()
  await Promise.allSettled([...runners.values()].map((r) => r.done))
}

async function runAccount(source: SourceContextLike, signal: AbortSignal, account: EffectiveAccount, config: DwsConfig, binary: string): Promise<void> {
  const live: EffectiveAccount = { ...account, selfIds: [] }
  const state: AccountState = { seen: new Map(), pending: new Map(), chain: Promise.resolve() }
  let retry: number | undefined
  while (!signal.aborted) {
    const began = Date.now()
    try { await consumeOnce(source, signal, live, config, state, binary) }
    catch (error) {
      if (!signal.aborted) {
        source.report(HEALTH_ENTRY, { state: 'error', detail: `[${accountLabel(live)}] ${String(error).slice(0, 300)}` })
      }
    }
    if (signal.aborted) break
    retry = consumerRetry(retry, Date.now() - began)
    await delay(retry, undefined, { signal }).catch(() => {})
  }
  flushPending(source, live, state, true)
}

function flushPending(source: SourceContextLike, account: EffectiveAccount, state: AccountState, silent: boolean): void {
  for (const [key, entry] of [...state.pending]) {
    clearTimeout(entry.timer)
    state.pending.delete(key)
    state.chain = state.chain
      .then(async () => {
        await source.receive(entry.trigger)
        await seenOrAdd(account.profile || 'default', entry.trigger.id).catch((error: unknown) => {
          console.error(`[dws] seen persist failed: ${String(error).slice(0, 240)}`)
        })
      })
      .catch((error: unknown) => {
        const detail = `[${accountLabel(account)}] receive failed: ${String(error).slice(0, 240)}`
        if (silent) console.error(`[dws] ${detail}`)
        else source.report(HEALTH_ENTRY, { state: 'error', detail })
      })
  }
}

async function ingest(source: SourceContextLike, account: EffectiveAccount, config: DwsConfig, state: AccountState, trigger: TriggerLike): Promise<void> {
  // 持久去重（dedup.ts，跨重启）：重连/重订阅重放的旧事件不再重复进入 pending。
  // 此处只查不标记；标记在派发成功后（下方与 flushPending）——崩溃窗口宁重复
  // 不丢失（at-least-once），重复由引擎 trigger.id 幂等兜底。
  const storeKey = account.profile || 'default'
  if (trigger.id && (await seenHas(storeKey, trigger.id))) return
  const now = Date.now()
  for (const [key, ts] of state.seen) if (now - ts > SEEN_TTL_MS) state.seen.delete(key)
  if (state.seen.size >= SEEN_CAP) {
    const oldest = state.seen.keys().next().value
    if (oldest !== undefined) state.seen.delete(oldest)
  }
  if (state.seen.has(trigger.id)) return
  state.seen.set(trigger.id, now)
  const existing = state.pending.get(trigger.id)
  if (existing) {
    // The at and group_all subscriptions deliver one message twice; merge the mention.
    if (trigger.addressed === 'direct') existing.trigger.addressed = 'direct'
    else if (trigger.addressed === 'mention' && existing.trigger.addressed !== 'direct') existing.trigger.addressed = 'mention'
    return
  }
  const entry = {
    trigger,
    timer: setTimeout(() => {
      state.pending.delete(trigger.id)
      state.chain = state.chain
        .then(async () => {
          await source.receive(trigger)
          // 派发成功后才落盘 seen（见 ingest 注释）；写失败仅记日志，不影响主流程。
          await seenOrAdd(storeKey, trigger.id).catch((error: unknown) => {
            console.error(`[dws] seen persist failed: ${String(error).slice(0, 240)}`)
          })
        })
        .catch((error: unknown) => {
          source.report(HEALTH_ENTRY, { state: 'error', detail: `[${accountLabel(account)}] receive failed: ${String(error).slice(0, 240)}` })
        })
    }, Math.max(500, config.coalesceMs)),
  }
  state.pending.set(trigger.id, entry)
  if (state.pending.size >= PENDING_CAP) flushPending(source, account, state, false)
}

async function consumeOnce(source: SourceContextLike, signal: AbortSignal, account: EffectiveAccount, config: DwsConfig, state: AccountState, binary: string): Promise<void> {
  // Self identity per connect: one cheap CLI call, refreshed after a login switch.
  account.selfIds = await resolveSelfIds(binary, account.profile)
  if (account.selfIds.length === 0) {
    console.error(`[dws] self identity unresolved for ${accountLabel(account)}; self-message suppression is off`)
  }
  const keys = account.directMessages ? [...CONSUME_KEYS] : CONSUME_KEYS.filter((k) => k !== 'user_im_message_receive_o2o_all')
  const args = ['event', 'consume', ...keys, '-f', 'ndjson', '--name', 'dsh-superagent-dws']
  if (account.profile.trim()) args.push('--profile', account.profile.trim())
  const child = spawn(binary, args, { stdio: ['pipe', 'pipe', 'pipe'] })
  if (!child.stdout || !child.stderr) throw new Error('dws event consume: stdio unavailable')
  const stdout = createInterface({ input: child.stdout })
  const stderr = createInterface({ input: child.stderr })
  let chain = Promise.resolve()
  let diagnostic = ''
  let ready = false
  const stop = (): void => { child.stdin?.end(); child.kill('SIGTERM') }
  signal.addEventListener('abort', stop, { once: true })
  const timeout = setTimeout(() => { diagnostic = 'dws event consumer did not become ready within 45 seconds'; stop() }, 45_000)
  stderr.on('line', (line: string) => {
    diagnostic = line.slice(0, 4000)
    if (line.startsWith('[event] ready')) {
      ready = true
      clearTimeout(timeout)
      source.report(HEALTH_ENTRY, {
        state: 'ready',
        detail: `[${accountLabel(account)}] listening (${keys.length} keys${account.selfIds.length > 0 ? '' : '; self-identity unresolved'})`,
        at: new Date().toISOString(),
      })
    } else if (/SYSTEM_ERROR|ECONNRESET|failed/i.test(line)) {
      source.report(HEALTH_ENTRY, { state: 'error', detail: `[${accountLabel(account)}] ${diagnostic}` })
    }
  })
  stdout.on('line', (line: string) => {
    chain = chain.then(async () => {
      if (line.length > 1_048_576) throw new Error('dws event exceeds 1 MiB')
      if (line.trim().length <= 1) return
      const trigger = toTrigger(account, line)
      if (!trigger) return
      await ingest(source, account, config, state, trigger)
    }).catch((error: unknown) => {
      source.report(HEALTH_ENTRY, { state: 'error', detail: `[${accountLabel(account)}] ${String(error).slice(0, 300)}` })
    })
  })
  try {
    await new Promise<void>((resolve, reject) => {
      child.once('error', reject)
      child.once('close', (code) => {
        if (signal.aborted) resolve()
        else reject(new Error(`dws event consume exited (code=${code}, ready=${ready}): ${diagnostic}`))
      })
    })
  } finally {
    clearTimeout(timeout)
    signal.removeEventListener('abort', stop)
    stdout.close()
    stderr.close()
    await chain
    child.kill('SIGTERM')
  }
}

const str = (value: unknown): string => (typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '')

/** Without --flatten the line is the transport envelope whose `data` holds the
 *  business payload as a JSON string; a future CLI change may flatten or nest it,
 *  so all three shapes are accepted. */
export function extractBusiness(envelope: Record<string, unknown>): Record<string, unknown> {
  const data = envelope.data
  if (typeof data === 'string' && data.trim()) {
    try {
      const parsed: unknown = JSON.parse(data)
      if (parsed && typeof parsed === 'object') return parsed as Record<string, unknown>
    } catch { /* fall through to the envelope itself */ }
  }
  if (data && typeof data === 'object') return data as Record<string, unknown>
  return envelope
}

export function textOf(business: Record<string, unknown>): string {
  const text = business.text
  if (text && typeof text === 'object') return str((text as Record<string, unknown>).content)
  const content = business.content
  if (typeof content === 'string') return content
  if (content && typeof content === 'object') return str((content as Record<string, unknown>).text)
  return ''
}

export function isoTime(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(value > 1e12 ? value : value * 1000).toISOString()
  }
  if (typeof value === 'string' && value.trim()) {
    if (/^\d+$/.test(value.trim())) {
      const n = Number(value.trim())
      return new Date(n > 1e12 ? n : n * 1000).toISOString()
    }
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString()
  }
  return new Date().toISOString()
}

export function richTextOf(business: Record<string, unknown>): string {
  const content = business.content
  const rich = (content && typeof content === 'object' ? (content as Record<string, unknown>).richText : undefined) ?? business.richText
  if (!Array.isArray(rich)) return ''
  return rich.map((item) => item && typeof item === 'object' ? str((item as Record<string, unknown>).text) : '').join('')
}

/** Collects media id candidates (mediaId on personal events, downloadCode on the
 *  robot-event domain) from anywhere in the payload, capped so a huge payload
 *  cannot flood the trigger text. */
export function collectMediaCodes(value: unknown, out: string[]): void {
  if (Array.isArray(value)) { for (const item of value) collectMediaCodes(item, out); return }
  if (!value || typeof value !== 'object') return
  const record = value as Record<string, unknown>
  const code = str(record.mediaId ?? record.downloadCode)
  if (code && out.length < 5 && !out.includes(code)) out.push(code)
  if (out.length >= 5) return
  for (const nested of Object.values(record)) collectMediaCodes(nested, out)
}

/** Normalizes one NDJSON event line into a Trigger; undefined for self messages,
 *  empty texts and (unmentioned) unlisted group chatter. Payload field names are
 *  candidates until the first real event confirms them (see README). */
export function toTrigger(account: EffectiveAccount, line: string): TriggerLike | undefined {
  let envelope: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(line)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
    envelope = parsed as Record<string, unknown>
  } catch {
    throw new Error(`unparseable dws event line: ${line.slice(0, 160)}`)
  }
  const business = extractBusiness(envelope)
  const eventKey = str(envelope.event_type ?? envelope.event_key)
  const msgId = str(business.msgId ?? business.messageId ?? envelope.event_id)
  const conversationId = str(business.conversationId ?? business.openConversationId ?? business.cid)
  const senderId = str(business.senderStaffId ?? business.senderId)
  let text = textOf(business).trim()
  if (!text) text = richTextOf(business).trim()
  const mediaCodes: string[] = []
  collectMediaCodes(business, mediaCodes)
  if (mediaCodes.length > 0) text = (text + '\n' + mediaCodes.map((code) => `[dws-media:${code}]`).join(' ')).trim()
  if (!msgId || !conversationId || !text) return undefined
  if (account.selfIds.length > 0) {
    const senderUnion = str(business.senderUnionId ?? business.unionId)
    if (account.selfIds.some((id) => id === senderId || id === senderUnion)) {
      console.error(`[dws] drop self message: ${msgId}`)
      return undefined
    }
  }
  const isDm = eventKey === 'user_im_message_receive_o2o_all'
  const atUsers = Array.isArray(business.atUsers) ? business.atUsers as Record<string, unknown>[] : []
  const mentioned = eventKey === 'user_im_message_receive_at'
    || business.isInAtList === true
    || account.selfIds.some((id) => atUsers.some((u) => u && (u.dingtalkId === id || u.staffId === id)))
  if (!isDm && !mentioned) {
    // Unlisted group chatter never enters the engine (group_all + local whitelist).
    if (!account.groups.some((g) => g.openConversationId === conversationId)) return undefined
  }
  const accountId = account.profile || 'default'
  const senderNick = str(business.senderNick ?? business.senderNickName)
  return {
    id: `dws:${accountId}:${msgId}`,
    source: 'dws',
    threads: [{ source: 'dws', id: `dws:${accountId}:${conversationId}` }],
    actor: { source: 'dws', id: senderId || senderNick || accountId },
    human: true,
    ...(isDm ? { addressed: 'direct' as const } : mentioned ? { addressed: 'mention' as const } : {}),
    at: isoTime(business.createAt ?? business.createTime ?? envelope.event_born_time),
    text,
    channel: {
      source: 'dws',
      thread: `dws:${accountId}:${conversationId}`,
      address: {
        account: accountId,
        conversation: conversationId,
        messageId: msgId,
        user: senderId,
        senderNick,
        direct: isDm ? 'true' : '',
        ...(mentioned && !isDm ? { mentioned: 'true' } : {}),
      },
    },
    meta: {
      accountId,
      accountDefault: account.rowProfile === '',
      conversationId,
      messageId: msgId,
      isDm,
      mentioned,
      eventKey,
      senderId,
      senderNick,
      ...(mediaCodes.length > 0 ? { mediaCodes } : {}),
    },
  }
}
