/** 契约路由（docs/rpc-contract.md §1/§2，P-B 批次）：统一前缀 /dsh-dws/api，
 *  与既有 /dws/api 面板登录路由并存，闸门沿用 seam 拥有者同款 sameOrigin（panel.ts）。
 *
 *  - POST /api/deliver      {targetId, text, kind?} → 非人类 Trigger（human:false，
 *    meta.deliver=true，actor=本包源标识）→ source.receive → 引擎按 ticket 流转，
 *    回复经 channel.send（dws chat message send）回到该目标。收件即受理（202 语义）。
 *  - POST /api/deliver/test {targetId} → 不经引擎，直调 sendDwsMessage 发双语测试文案，
 *    返回 {ok,sent,detail}。dws 无 24h 窗口限制（wechat 特例不适用）。
 *  - GET  /api/health       计数 in/out/fail/deny + 最近 20 条发送失败 + dedup 水位。
 *  - GET  /api/settings     只读当前配置（本源配置无凭据字段：profile 由 dws CLI 钥匙串管理）；
 *                           PUT 本批不开（P-C' 再开）。
 *  - GET  /api/settings.describe  字段静态表（本批手工维护，P-C' 页壳消费）。
 *
 *  错误码（契约 §1）：400 {error:'bad-request',detail}；404 {error:'unknown-target'}；
 *  409 {error:'not-ready'}；成功 {ok:true,...}。投递账号固定用默认账号（rowProfile 为空的
 *  行，无则第一行）；单聊目标（staffId）address.direct='true' + user=staffId（engine 回复
 *  经 channel.send --user 直发），群目标（conversationId）address.conversation=cid。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { TriggerLike } from './types.ts'
import type { DwsConfig, EffectiveAccount } from './dws-kind.ts'
import { activeBinary, idOf } from './dws-kind.ts'
import { sendDwsMessage } from './dws-cli.ts'
import { sameOrigin, type WebServerLike } from './panel.ts'
import { findTarget, readTargets, removeTarget, TARGET_ID_RE, touchTarget, upsertTarget, type DeliverTarget } from './targets.ts'
import { logSendFailure } from './failure-log.ts'
import { buildHealthPayload, countIn } from './health.ts'
import type { HealthHolder } from './dws-kind.ts'

/** 非人类 Trigger 的 actor（契约 §2：actor=本包源标识）。 */
export const DELIVER_ACTOR_ID = 'dsh-superagent-dws'

/** 双语测试文案（deliver/test 直发，不经引擎）。 */
export const TEST_DELIVERY_TEXT = 'dsh-superagent-dws 主动投递测试：收到这条消息说明投递路由可用。\ndsh-superagent-dws delivery test: receiving this confirms the delivery route works.'

const MAX_BODY_BYTES = 8 * 1024

function respondJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) { res.end(); return }
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

function readBody(req: IncomingMessage, limit = MAX_BODY_BYTES): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('deliver api: body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

// 每次 deliver/deliver-test 各生成一个唯一 id 后缀（跨重启 Date.now 兜底）。
let seq = 0
function uniqueSuffix(): string {
  seq += 1
  return Date.now().toString(36) + '-' + String(seq)
}

export interface DeliverDeps {
  port: number
  receive: (trigger: TriggerLike) => unknown | Promise<unknown>
  /** channelConfig 持有器（dws-kind.ts holder）：config + 生效账号 + 二进制路径。 */
  holder: () => HealthHolder | undefined
  /** 测试注入：targets/失败日志根目录（缺省真实 state 目录）。 */
  stateDir?: string
  /** 测试注入：deliver/test 的发送实现（缺省 sendDwsMessage 真链路）。 */
  sendImpl?: (binary: string, account: EffectiveAccount, address: Record<string, string>, text: string, key: string) => Promise<void>
}

/** 投递账号：默认账号（rowProfile 为空 = 当前登录），无则第一行。 */
function defaultAccount(holder: HealthHolder): EffectiveAccount | undefined {
  return holder.accounts.find((a) => a.rowProfile === '') ?? holder.accounts[0]
}

/** 目标路由校验：staffId（单聊）或 conversationId（群）二选一；返回 address 形状与 isDm。 */
function resolveAddress(target: DeliverTarget): { address: Record<string, string>; isDm: boolean; key: string } | undefined {
  const staffId = String(target.address.staffId ?? '').trim()
  const conversationId = String(target.address.conversationId ?? '').trim()
  if (staffId) return { address: { direct: 'true', user: staffId }, isDm: true, key: staffId }
  if (conversationId) return { address: { conversation: conversationId }, isDm: false, key: conversationId }
  return undefined
}

async function handleDeliver(deps: DeliverDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: { targetId?: unknown; text?: unknown; kind?: unknown } = {}
  try {
    const raw = await readBody(req)
    if (raw.trim()) body = JSON.parse(raw) as typeof body
  } catch {
    respondJson(res, 400, { error: 'bad-request', detail: 'invalid JSON body' })
    return
  }
  const targetId = typeof body.targetId === 'string' ? body.targetId.trim() : ''
  const text = typeof body.text === 'string' ? body.text : ''
  const kind = body.kind === 'reply' ? 'reply' : 'notice'
  if (!targetId || !text.trim()) {
    respondJson(res, 400, { error: 'bad-request', detail: 'targetId and non-empty text are required' })
    return
  }
  const target = await findTarget(targetId, deps.stateDir)
  if (!target) {
    respondJson(res, 404, { error: 'unknown-target' })
    return
  }
  const holder = deps.holder()
  const account = holder ? defaultAccount(holder) : undefined
  if (!holder || !account) {
    respondJson(res, 409, { error: 'not-ready', detail: 'dws not logged in or no configured account yet' })
    return
  }
  const resolved = resolveAddress(target)
  if (!resolved) {
    respondJson(res, 400, { error: 'bad-request', detail: 'target address needs staffId (DM) or conversationId (group)' })
    return
  }
  const acctId = idOf(account)
  const threadId = resolved.isDm ? 'dws:' + acctId + ':direct:' + resolved.key : 'dws:' + acctId + ':' + resolved.key
  // 非人类 Trigger（契约 §2）：human:false、meta.deliver=true、actor=本包源标识。
  // addressed:'direct'：主动投递是运营者的明确指派（引擎 machineGate 的 addressed 前提）。
  const trigger: TriggerLike = {
    id: 'dws:' + acctId + ':deliver:' + target.id + ':' + uniqueSuffix(),
    source: 'dws',
    threads: [{ source: 'dws', id: threadId }],
    actor: { source: 'dws', id: DELIVER_ACTOR_ID },
    human: false,
    addressed: 'direct',
    at: new Date().toISOString(),
    text,
    channel: { source: 'dws', thread: threadId, address: { account: acctId, ...resolved.address } },
    meta: { accountId: acctId, deliver: true, targetId: target.id, isDm: resolved.isDm, kind },
  }
  await deps.receive(trigger)
  countIn()
  await touchTarget(target.id, deps.stateDir).catch(() => undefined)
  respondJson(res, 200, { ok: true, accepted: true, triggerId: trigger.id })
}

async function handleDeliverTest(deps: DeliverDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: { targetId?: unknown } = {}
  try {
    const raw = await readBody(req)
    if (raw.trim()) body = JSON.parse(raw) as typeof body
  } catch {
    respondJson(res, 400, { error: 'bad-request', detail: 'invalid JSON body' })
    return
  }
  const targetId = typeof body.targetId === 'string' ? body.targetId.trim() : ''
  if (!targetId) {
    respondJson(res, 400, { error: 'bad-request', detail: 'targetId is required' })
    return
  }
  const target = await findTarget(targetId, deps.stateDir)
  if (!target) {
    respondJson(res, 404, { error: 'unknown-target' })
    return
  }
  const holder = deps.holder()
  const account = holder ? defaultAccount(holder) : undefined
  if (!holder || !account) {
    respondJson(res, 409, { error: 'not-ready', detail: 'dws not logged in or no configured account yet' })
    return
  }
  const resolved = resolveAddress(target)
  if (!resolved) {
    respondJson(res, 400, { error: 'bad-request', detail: 'target address needs staffId (DM) or conversationId (group)' })
    return
  }
  const send = deps.sendImpl ?? ((binary: string, acct: EffectiveAccount, address: Record<string, string>, text: string, key: string) => sendDwsMessage(binary, acct, address, text, key))
  const idempotencyKey = 'deliver-test:' + target.id + ':' + uniqueSuffix()
  try {
    await send(activeBinary(holder), account, resolved.address, TEST_DELIVERY_TEXT, idempotencyKey)
    await touchTarget(target.id, deps.stateDir).catch(() => undefined)
    respondJson(res, 200, { ok: true, sent: true, detail: 'test delivered' })
  } catch (error) {
    // 发送失败留痕（契约 §2：失败走既有 failure-log）并如实返回 sent:false。
    await logSendFailure({
      channelKey: idOf(account) + ':' + resolved.key,
      kind: 'deliver-test',
      error: error instanceof Error ? error.message : String(error),
    }, deps.stateDir).catch(() => undefined)
    respondJson(res, 200, { ok: true, sent: false, detail: String(error instanceof Error ? error.message : error).slice(0, 200) })
  }
}

/** describe 字段静态表（本批手工维护；credential=凭据槽标记；P-C' 页壳消费，扩展点）。
 *  dws 配置无凭据槽：profile 凭据由 dws CLI（macOS 钥匙串）管理，插件不接触 token。 */
export const SETTINGS_FIELDS: { key: string; type: string; credential: boolean; label: { zh: string; en: string }; hint: { zh: string; en: string } }[] = [
  { key: 'dwsBinary', type: 'text', credential: false, label: { zh: 'dws 可执行文件', en: 'dws binary' }, hint: { zh: '命令名或绝对路径；需已 dws auth login', en: 'Command name or absolute path; requires dws auth login' } },
  { key: 'coalesceMs', type: 'number', credential: false, label: { zh: '合并窗口 / 毫秒', en: 'Coalesce window / ms' }, hint: { zh: '@ 与群事件双重投递的合并窗口（500-15000）', en: 'Merge window for dual at/group deliveries (500-15000)' } },
  { key: 'readPageSize', type: 'number', credential: false, label: { zh: '每页消息数', en: 'Messages per page' }, hint: { zh: '智能体读会话历史每页条数（1-50）', en: 'History page size (1-50)' } },
  { key: 'accounts', type: 'rows', credential: false, label: { zh: '钉钉账号', en: 'DingTalk accounts' }, hint: { zh: '每行一个账号；profile 留空 = 当前登录（最多一行）', en: 'One account per row; empty profile = current login (at most one)' } },
  { key: 'accounts[].profile', type: 'text', credential: true, label: { zh: 'Profile', en: 'Profile' }, hint: { zh: 'corpId:userId 身份标识（非密钥；凭据在 dws CLI 钥匙串）', en: 'corpId:userId identity (not a secret; credentials live in the dws CLI keychain)' } },
  { key: 'accounts[].label', type: 'text', credential: false, label: { zh: '名称', en: 'Label' }, hint: { zh: '仅面板显示', en: 'Display only' } },
  { key: 'accounts[].directMessages', type: 'switch', credential: false, label: { zh: '接收单聊', en: 'Direct messages' }, hint: { zh: '关闭则单聊事件不进入引擎', en: 'Off means DM events never reach the engine' } },
  { key: 'accounts[].aiTag', type: 'switch', credential: false, label: { zh: 'AI 角标', en: 'AI badge' }, hint: { zh: '回复消息带「AI」角标', en: 'Mark replies with the AI badge' } },
  { key: 'groups', type: 'rows', credential: false, label: { zh: '接收全部消息的群', en: 'Groups received in full' }, hint: { zh: 'openConversationId 白名单；未列群仅 @ 可指派', en: 'openConversationId allowlist; only @ assigns elsewhere' } },
  { key: 'groups[].account', type: 'text', credential: false, label: { zh: '所属账号 Profile', en: 'Account profile' }, hint: { zh: '留空 = 默认账号', en: 'Empty = default account' } },
  { key: 'groups[].openConversationId', type: 'text', credential: false, label: { zh: '会话 ID', en: 'Conversation ID' }, hint: { zh: 'cid 开头的 openConversationId', en: 'openConversationId (cid...)' } },
  { key: 'policy', type: 'object', credential: false, label: { zh: 'ACL 访问模式', en: 'ACL policy' }, hint: { zh: '契约 §3；不设=全放行（向后兼容）', en: 'Contract §3; unset = allow all (back-compat)' } },
  { key: 'policy.mode', type: 'text', credential: false, label: { zh: '模式', en: 'Mode' }, hint: { zh: 'allowlist | open', en: 'allowlist | open' } },
  { key: 'policy.allowUsers', type: 'rows', credential: false, label: { zh: '允许的成员 staffId', en: 'Allowed staffIds' }, hint: { zh: 'actor.id（senderStaffId）精确串匹配，大小写敏感', en: 'Exact actor.id (senderStaffId) match, case-sensitive' } },
  { key: 'policy.groupOnly', type: 'switch', credential: false, label: { zh: '仅群聊', en: 'Group only' }, hint: { zh: '开启后名单内成员的单聊也被拒（dws 可靠区分群/单聊）', en: 'When on, DMs from listed members are denied too (dws distinguishes reliably)' } },
  { key: 'policy.denyText', type: 'object', credential: false, label: { zh: '拒绝回执文案', en: 'Deny notice text' }, hint: { zh: '{zh,en} 双语；缺省「该机器人未向你开放。」', en: '{zh,en}; default notice applies when unset' } },
]

async function handleApi(path: string, req: IncomingMessage, res: ServerResponse, deps: DeliverDeps): Promise<void> {
  if (!sameOrigin(req, deps.port)) {
    respondJson(res, 403, { error: 'Same-origin management request required' })
    return
  }
  if (path === '/api/deliver' && req.method === 'POST') {
    await handleDeliver(deps, req, res)
    return
  }
  if (path === '/api/deliver/test' && req.method === 'POST') {
    await handleDeliverTest(deps, req, res)
    return
  }
  if (path === '/api/health' && req.method === 'GET') {
    const holder = deps.holder()
    const payload = await buildHealthPayload(holder ? holder.accounts.map((a) => idOf(a)) : [], deps.stateDir)
    respondJson(res, 200, { ok: true, ...payload })
    return
  }
  if (path === '/api/targets' && req.method === 'GET') {
    const file = await readTargets(deps.stateDir)
    respondJson(res, 200, { ok: true, targets: file.targets })
    return
  }
  if (path === '/api/targets' && req.method === 'PUT') {
    // 契约 §1 P-C'：upsert 单目标（targetId 语法校验；createdAt 由 upsert 保留）。
    const raw = await readBody(req)
    let parsed: Record<string, unknown>
    try { parsed = JSON.parse(raw) as Record<string, unknown> } catch {
      respondJson(res, 400, { error: 'bad-request', detail: 'body is not JSON' })
      return
    }
    const id = typeof parsed.id === 'string' ? parsed.id : ''
    if (!TARGET_ID_RE.test(id)) {
      respondJson(res, 400, { error: 'bad-request', detail: 'targetId must match ' + TARGET_ID_RE.source })
      return
    }
    if (!parsed.address || typeof parsed.address !== 'object' || Array.isArray(parsed.address)) {
      respondJson(res, 400, { error: 'bad-request', detail: 'address object required' })
      return
    }
    const address: Record<string, string> = {}
    for (const [key, value] of Object.entries(parsed.address as Record<string, unknown>)) address[key] = String(value)
    const label = typeof parsed.label === 'string' ? parsed.label : ''
    const { created } = await upsertTarget({ id, address, label }, deps.stateDir)
    respondJson(res, 200, { ok: true, created })
    return
  }
  if (path.startsWith('/api/targets/') && req.method === 'DELETE') {
    const id = decodeURIComponent(path.slice('/api/targets/'.length))
    const removed = await removeTarget(id, deps.stateDir)
    respondJson(res, removed ? 200 : 404, removed ? { ok: true } : { error: 'unknown-target' })
    return
  }
  if (path === '/api/settings' && req.method === 'GET') {
    const holder = deps.holder()
    respondJson(res, 200, { ok: true, config: holder?.config ?? null })
    return
  }
  if (path === '/api/settings' && req.method === 'PUT') {
    // 写路径本批不开（任务书：settings 读写本批只做 GET 只读，PUT 随 P-C' 再开）。
    respondJson(res, 400, { error: 'bad-request', detail: 'settings write path is not opened in this batch (lands with P-C\'' + ')' })
    return
  }
  if (path === '/api/settings.describe' && req.method === 'GET') {
    respondJson(res, 200, { ok: true, fields: SETTINGS_FIELDS })
    return
  }
  respondJson(res, 404, { error: 'not found' })
}

/** 处理器工厂（测试注入点：path 为去掉 /dsh-dws 前缀后的部分，如 /api/deliver）。 */
export function createApiHandler(deps: DeliverDeps): (path: string, req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return (path, req, res) => handleApi(path, req, res, deps)
}

/** 在引擎 webserver 上注册契约前缀 /dsh-dws（同一 register 调用面，见 panel.ts）。 */
export function registerContractRoutes(webServer: WebServerLike, deps: Omit<DeliverDeps, 'port'>): () => void {
  const handler = createApiHandler({ ...deps, port: webServer.port })
  return webServer.register({
    kind: 'prefix',
    path: '/dsh-dws',
    handler: (req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      if (!url.pathname.startsWith('/dsh-dws/')) {
        respondJson(res, 404, { error: 'not found' })
        return
      }
      handler(url.pathname.slice('/dsh-dws'.length), req, res).catch((error: unknown) => {
        // 只记错误码级信息，绝不落请求体。
        console.error('[dws-api] request error: ' + String(error).slice(0, 200))
        respondJson(res, 400, { error: 'bad request' })
      })
    },
  })
}
