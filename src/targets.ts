/** 主动投递目标表（契约 docs/rpc-contract.md §2，P-B 批次）：一个 JSON 文件
 *  ~/.local/state/dsh-superagent-dws/targets.json，原子写（tmp+rename，同款
 *  dedup/failure-log 风格，单文件读写串行化防并发读改写交错）。
 *
 *  targetId 与平台 ID 解耦（别名语义，沿 dsh-im PROACTIVE_DELIVERY 设计）：
 *  1–128 字符，[A-Za-z0-9._@:-]，创建后不可改（改路由字段可以）。
 *  dws 平台原生路由字段：address.staffId（单聊直发 --user）或 address.conversationId
 *  （群发 --conversation-id）；投递账号固定用默认账号（rowProfile 为空的行，无则第一行）。
 *  本批无 HTTP 管理路由——upsert/touch 供 P-C' 页壳与测试使用，deliver 路由只读。 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const TARGETS_VERSION = 1
export const TARGET_ID_RE = /^[A-Za-z0-9._@:-]{1,128}$/

export interface DeliverTarget { id: string; address: Record<string, string>; label: string; createdAt: string; lastUsedAt: string }

export interface TargetsFile { version: number; targets: DeliverTarget[] }

function stateBase(baseDir?: string): string {
  return baseDir ?? join(homedir(), '.local', 'state', 'dsh-superagent-dws')
}

export function targetsFile(baseDir?: string): string {
  return join(stateBase(baseDir), 'targets.json')
}

async function writeAtomic(path: string, content: string): Promise<void> {
  const idx = path.lastIndexOf('/')
  await mkdir(idx > 0 ? path.slice(0, idx) : '.', { recursive: true })
  const tmp = path + '.tmp'
  await writeFile(tmp, content, { mode: 0o600 })
  await rename(tmp, path)
}

// 单文件读写串行化（dedup.ts 同式）：deliver 与 touchTarget 并发时防读改写交错。
const chains = new Map<string, Promise<unknown>>()

function serialize<T>(path: string, run: () => Promise<T>): Promise<T> {
  const task = (chains.get(path) ?? Promise.resolve()).then(run, run)
  chains.set(path, task.catch(() => undefined))
  return task
}

async function readTargetsUnsafe(path: string): Promise<TargetsFile> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as unknown
    const targets = parsed && typeof parsed === 'object' && Array.isArray((parsed as TargetsFile).targets)
      ? (parsed as TargetsFile).targets.filter((t): t is DeliverTarget =>
        !!t && typeof t === 'object' && typeof t.id === 'string' && !!t.address && typeof t.address === 'object')
      : []
    return { version: TARGETS_VERSION, targets }
  } catch {
    return { version: TARGETS_VERSION, targets: [] } // 首次运行或损坏：按空表处理
  }
}

/** 读取目标表（损坏/缺失按空表处理，永不抛错）。 */
export async function readTargets(baseDir?: string): Promise<TargetsFile> {
  return await serialize(targetsFile(baseDir), () => readTargetsUnsafe(targetsFile(baseDir)))
}

/** 按 targetId 精确查找；不存在返回 undefined。 */
export async function findTarget(id: string, baseDir?: string): Promise<DeliverTarget | undefined> {
  if (!id) return undefined
  return (await readTargets(baseDir)).targets.find((t) => t.id === id)
}

/** 创建或整体更新（按 id 去重）：createdAt 保留，lastUsedAt 刷新为当前。
 *  非法 targetId 抛错（HTTP 层转 400）。 */
export async function upsertTarget(input: { id: string; address: Record<string, string>; label?: string }, baseDir?: string): Promise<{ created: boolean }> {
  if (!TARGET_ID_RE.test(input.id)) throw new Error('invalid targetId (1-128 chars of [A-Za-z0-9._@:-]): ' + input.id.slice(0, 40))
  const path = targetsFile(baseDir)
  return await serialize(path, async () => {
    const now = new Date().toISOString()
    const file = await readTargetsUnsafe(path)
    const existing = file.targets.find((t) => t.id === input.id)
    const target: DeliverTarget = {
      id: input.id,
      address: { ...input.address },
      label: input.label ?? existing?.label ?? '',
      createdAt: existing?.createdAt ?? now,
      lastUsedAt: now,
    }
    const targets = existing ? file.targets.map((t) => (t.id === input.id ? target : t)) : [...file.targets, target]
    await writeAtomic(path, JSON.stringify({ version: TARGETS_VERSION, targets }))
    return { created: !existing }
  })
}

/** 刷新 lastUsedAt（投递受理后调用；目标不存在静默跳过）。 */
export async function touchTarget(id: string, baseDir?: string): Promise<void> {
  if (!id) return
  const path = targetsFile(baseDir)
  await serialize(path, async () => {
    const file = await readTargetsUnsafe(path)
    const target = file.targets.find((t) => t.id === id)
    if (!target) return
    target.lastUsedAt = new Date().toISOString()
    await writeAtomic(path, JSON.stringify({ version: TARGETS_VERSION, targets: file.targets }))
  })
}
