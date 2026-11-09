/** Persistent inbound dedup (seen-set): one JSON file per store key (account),
 *  ~/.local/state/dsh-superagent-dws/seen-<account>.json, FIFO-capped at
 *  SEEN_CAP ids, serial per-file writes via tmp+rename. Survives restarts so
 *  redelivered events (consumer re-subscribe replays after a crash) never
 *  reach the engine twice; the engine dedups on trigger.id itself, this layer
 *  keeps the plugin self-sufficient.
 *
 *  Ordering (at-least-once): stream.ts checks seenHas BEFORE a trigger enters
 *  the pipeline and marks seenOrAdd AFTER source.receive succeeds — a crash
 *  between check and mark costs a duplicate (engine trigger-id idempotency
 *  absorbs it), never a silent loss. */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 单文件滚动上限：超过丢最旧，防文件无限膨胀。 */
export const SEEN_CAP = 1000

/** 文件名/目录段净化：只留安全字符，防 profile 注入路径。 */
const sanitizeSegment = (value: string): string => value.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80) || 'unknown'

function stateBase(baseDir?: string): string {
  return baseDir ?? join(homedir(), '.local', 'state', 'dsh-superagent-dws')
}

export function seenFile(storeKey: string, baseDir?: string): string {
  return join(stateBase(baseDir), 'seen-' + sanitizeSegment(storeKey) + '.json')
}

// 同一文件的读写串行化（多账号 runner 各自的文件互不影响，同文件防读改写交错）。
const chains = new Map<string, Promise<unknown>>()

function serialize<T>(path: string, run: () => Promise<T>): Promise<T> {
  const task = (chains.get(path) ?? Promise.resolve()).then(run, run)
  chains.set(path, task.catch(() => undefined))
  return task
}

async function readSeen(path: string): Promise<string[]> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter((id): id is string => typeof id === 'string' && id.length > 0)
  } catch {
    return [] // 首次运行或文件损坏：按空处理
  }
}

async function writeSeen(path: string, ids: string[]): Promise<void> {
  const idx = path.lastIndexOf('/')
  await mkdir(idx > 0 ? path.slice(0, idx) : '.', { recursive: true })
  const tmp = path + '.tmp'
  await writeFile(tmp, JSON.stringify(ids), { mode: 0o600 })
  await rename(tmp, path)
}

/** 只读查询：id 是否已见过（派发管线入口调用，决定是否跳过）。空 id 恒 false。 */
export async function seenHas(storeKey: string, id: string, baseDir?: string): Promise<boolean> {
  if (!id) return false
  const path = seenFile(storeKey, baseDir)
  return await serialize(path, async () => (await readSeen(path)).includes(id))
}

/** 水位（/health 路由用，契约 §1「dedup 水位」）：指定 store 的 seen 条数与上限。 */
export async function seenCount(storeKey: string, baseDir?: string): Promise<{ count: number; cap: number }> {
  if (!storeKey) return { count: 0, cap: SEEN_CAP }
  const path = seenFile(storeKey, baseDir)
  return await serialize(path, async () => ({ count: (await readSeen(path)).length, cap: SEEN_CAP }))
}

/** 查询并标记：返回 true 表示首次登记（派发成功后调用）。空 id 不落盘。 */
export async function seenOrAdd(storeKey: string, id: string, baseDir?: string): Promise<boolean> {
  if (!id) return false
  const path = seenFile(storeKey, baseDir)
  return await serialize(path, async () => {
    const ids = await readSeen(path)
    if (ids.includes(id)) return false
    ids.push(id)
    while (ids.length > SEEN_CAP) ids.shift()
    await writeSeen(path, ids)
    return true
  })
}
