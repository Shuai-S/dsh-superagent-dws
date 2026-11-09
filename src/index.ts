/**
 * dsh-superagent-dws — personal-identity DingTalk Source for dsh-superagent.
 *
 * Registers the 'dws' Source kind through the same extension seam the bundled
 * watchers use (inject 'orchestrator'), keeps one `dws event consume` process
 * per configured account alive: the logged-in user's @-mentions, direct
 * messages and configured group messages arrive in real time, become Triggers,
 * and replies go back as the user via `dws chat message send`.
 *
 * The webServer seam carries the panel login/install surface (/dws/api/*, same
 * gate as the engine's management API) behind the client bundle's 钉钉登录 page.
 *
 * @module dsh-superagent-dws
 */
import type { Context } from '@deepseek-ai/cordis'
import type { OrchestratorLike } from './types.ts'
import { dwsKind, HEALTH_ENTRY, channelConfig } from './dws-kind.ts'
import { watch } from './stream.ts'
import { LoginSessionManager } from './login-session.ts'
import { registerPanelRoutes, type WebServerLike } from './panel.ts'

export const name: string = 'dsh-superagent-dws'
// webServer = 引擎面板 webserver（同源 /dws/api 路由 seam，与 wechat 绑定路由同款）。
export const inject: string[] = ['orchestrator', 'webServer']

export function apply(ctx: Context): void {
  const orchestrator = (ctx as unknown as { orchestrator: OrchestratorLike }).orchestrator
  ctx.effect(() => orchestrator.sources.register(dwsKind), 'dws: source kind')
  ctx.effect(() => {
    const source = orchestrator.context(dwsKind)
    const controller = new AbortController()
    const running = watch(source, controller.signal).catch((error: unknown) => {
      source.report(HEALTH_ENTRY, { state: 'error', detail: String(error).slice(0, 300) })
    })
    return async () => { controller.abort(); await running }
  })
  // 面板「钉钉登录」页：设备流登录会话 + 静默安装状态（M2/M3）。
  const sessions = new LoginSessionManager()
  const webServer = (ctx as unknown as { webServer?: WebServerLike }).webServer
  if (webServer) {
    ctx.effect(() => registerPanelRoutes(webServer, {
      configBinary: () => channelConfig.current?.config.dwsBinary ?? 'dws',
    }, sessions), 'dws: panel routes')
  }
}
export { dwsKind, DwsConfigSchema, HEALTH_ENTRY } from './dws-kind.ts'
// 面板登录会话（依赖可注入，纯状态转移可测）
export { LoginSessionManager } from './login-session.ts'
// NDJSON 信封解析纯函数（stream 内联最小导出，供单测）
export { extractBusiness, textOf, isoTime, richTextOf, collectMediaCodes, toTrigger } from './stream.ts'
// 入站持久去重（跨重启重放抑制）与出站失败日志（JSONL，无凭据）
export { seenHas, seenOrAdd, SEEN_CAP, seenFile } from './dedup.ts'
export { logSendFailure, readSendFailures, FAILURE_LOG_LIMIT, failureLogFile } from './failure-log.ts'
