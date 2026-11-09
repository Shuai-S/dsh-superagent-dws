/** 健康计数与快照（契约 docs/rpc-contract.md §1/§5）：in=去重后送达 receive 的
 *  trigger；out=整条发送成功；fail=发送失败；deny=ACL 拒绝；last=最近一次 in/out ISO。
 *  进程内存活计数，不落盘（健康是实时视图不是审计日志）。GET /dsh-dws/api/health
 *  另附最近 20 条发送失败（failure-log）与 dedup 水位（seen-<account>.json 条数/上限）；
 *  state/detail 经 withHealthCapture 从 stream 的 dwsStream report 旁路捕获。 */
import type { Health, SourceContextLike, TriggerLike } from './types.ts'
import { SEEN_CAP, seenCount } from './dedup.ts'
import { readSendFailures, type FailureEntry } from './failure-log.ts'

export interface HealthCounters { in: number; out: number; fail: number; deny: number; lastIn?: string; lastOut?: string }

const counters: HealthCounters = { in: 0, out: 0, fail: 0, deny: 0 }

export function countIn(): void {
  counters.in += 1
  counters.lastIn = new Date().toISOString()
}

export function countOut(): void {
  counters.out += 1
  counters.lastOut = new Date().toISOString()
}

export function countFail(): void {
  counters.fail += 1
}

export function countDeny(): void {
  counters.deny += 1
}

export function snapshotCounters(): HealthCounters {
  return { ...counters }
}

/** 测试隔离用：全部归零。 */
export function resetCounters(): void {
  counters.in = 0
  counters.out = 0
  counters.fail = 0
  counters.deny = 0
  counters.lastIn = undefined
  counters.lastOut = undefined
}

let lastHealth: Health | undefined

/** watch() 经 withHealthCapture 把 dwsStream 的每次 report 同步进来（/health 的 state/detail）。 */
export function noteHealth(entry: Health): void {
  lastHealth = entry
}

/** 健康详情后缀：发生 ACL 拒绝后在 ready 报告 detail 上追加 '; deny=N'。 */
export function denySuffix(): string {
  return counters.deny > 0 ? '; deny=' + String(counters.deny) : ''
}

/** report 旁路捕获：不改 stream 的报告语义，只为 /health 提供最新状态快照。 */
export function withHealthCapture(source: SourceContextLike, entry: string): SourceContextLike {
  return {
    deployment: source.deployment,
    configured: () => source.configured(),
    config: <C,>(kind: string) => source.config<C>(kind),
    receive: (trigger: TriggerLike) => source.receive(trigger),
    threads: source.threads,
    report: (e: string, health: Health) => {
      if (e === entry) noteHealth(health)
      return source.report(e, health)
    },
  }
}

export interface HealthPayload {
  state: string
  detail: string
  at?: string
  counts: HealthCounters
  /** 最近 20 条发送失败（failure-log JSONL 尾部）。 */
  failures: FailureEntry[]
  dedup: { cap: number; stores: { key: string; count: number }[] }
}

/** GET /health 载荷组装（storeKeys=当前生效账号 id；失败日志取尾部 failureLimit 条）。 */
export async function buildHealthPayload(storeKeys: string[], stateDir?: string, failureLimit = 20): Promise<HealthPayload> {
  const failures = (await readSendFailures(stateDir)).slice(-failureLimit)
  const stores: { key: string; count: number }[] = []
  for (const key of storeKeys) {
    const st = await seenCount(key, stateDir)
    stores.push({ key, count: st.count })
  }
  return {
    state: lastHealth?.state ?? 'starting',
    detail: lastHealth?.detail ?? '',
    ...(lastHealth?.at !== undefined ? { at: lastHealth.at } : {}),
    counts: snapshotCounters(),
    failures,
    dedup: { cap: SEEN_CAP, stores },
  }
}
