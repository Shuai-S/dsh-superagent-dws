/** Outbound send-failure journal: one JSONL file per plugin state dir
 *  (~/.local/state/dsh-superagent-dws/send-failures.jsonl), capped at
 *  FAILURE_LOG_LIMIT lines (oldest dropped on rewrite). Entries carry
 *  {at, channelKey, kind, error<=300 chars} only — never tokens, message
 *  bodies or other credentials. Journaling is best-effort: write failures are
 *  logged and swallowed so the send path itself is never affected. */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 单文件滚动上限：JSONL 行数，超过丢最旧。 */
export const FAILURE_LOG_LIMIT = 200

export interface FailureEntry { at: string; channelKey: string; kind: string; error: string }

export interface FailureInput { channelKey: string; kind: string; error: string; at?: string }

function stateBase(baseDir?: string): string {
  return baseDir ?? join(homedir(), '.local', 'state', 'dsh-superagent-dws')
}

export function failureLogFile(baseDir?: string): string {
  return join(stateBase(baseDir), 'send-failures.jsonl')
}

/** 记一条发送失败（channel.send catch 路径调用）：内部吞掉写失败并 log，
 *  绝不影响发送主流程；error 截断到 300 字，不含凭据。 */
export async function logSendFailure(entry: FailureInput, baseDir?: string): Promise<void> {
  const line = JSON.stringify({
    at: entry.at ?? new Date().toISOString(),
    channelKey: String(entry.channelKey).slice(0, 200),
    kind: String(entry.kind).slice(0, 60),
    error: String(entry.error).slice(0, 300),
  })
  const path = failureLogFile(baseDir)
  try {
    let lines: string[] = []
    try {
      lines = (await readFile(path, 'utf8')).split('\n').filter((l) => l.trim())
    } catch { /* 首条 */ }
    lines.push(line)
    if (lines.length > FAILURE_LOG_LIMIT) lines = lines.slice(lines.length - FAILURE_LOG_LIMIT)
    const idx = path.lastIndexOf('/')
    await mkdir(idx > 0 ? path.slice(0, idx) : '.', { recursive: true })
    const tmp = path + '.tmp'
    await writeFile(tmp, lines.join('\n') + '\n', { mode: 0o600 })
    await rename(tmp, path)
  } catch (error) {
    console.error('[dws] failure log write failed (ignored): ' + String(error).slice(0, 160))
  }
}

/** 读取（排查/测试用）：损坏行跳过，永不抛错。 */
export async function readSendFailures(baseDir?: string): Promise<FailureEntry[]> {
  try {
    return (await readFile(failureLogFile(baseDir), 'utf8'))
      .split('\n')
      .filter((l) => l.trim())
      .flatMap((line) => {
        try {
          const parsed = JSON.parse(line) as Partial<FailureEntry>
          if (typeof parsed.channelKey !== 'string' || typeof parsed.error !== 'string') return []
          return [{ at: String(parsed.at ?? ''), channelKey: parsed.channelKey, kind: String(parsed.kind ?? ''), error: parsed.error }]
        } catch {
          return []
        }
      })
  } catch {
    return []
  }
}
