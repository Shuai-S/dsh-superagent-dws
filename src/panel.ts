/** Panel same-origin routes for the dws install/login surface (/dws/api/*), gated
 *  exactly like the engine's own management API (Host loopback:<port> +
 *  x-orchestrator-request: 1 + Origin absent-or-same). The client bundle
 *  (lib/client.js) talks only to these routes; no credentials are involved. */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { TriggerLike } from './types.ts'
import type { EffectiveAccount, HealthHolder } from './dws-kind.ts'
import { listProfiles } from './dws-cli.ts'
import { ensureInstalled, installState, probeCached } from './install.ts'
import { LoginSessionManager } from './login-session.ts'
import { registerContractRoutes } from './deliver.ts'

export interface WebServerLike {
  readonly port: number
  register(route: {
    kind: 'exact' | 'prefix'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }): () => void
}

const MAX_BODY_BYTES = 8 * 1024

function respondJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) { res.end(); return }
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

/** 引擎同款同源闸门（deliver.ts 契约路由复用；与 wechat bind-panel.ts sameOrigin 同语义）。 */
export function sameOrigin(req: Pick<IncomingMessage, 'headers'>, port: number): boolean {
  const host = req.headers.host
  if (host !== '127.0.0.1:' + port && host !== 'localhost:' + port) return false
  return req.headers['x-orchestrator-request'] === '1' &&
    (req.headers.origin === undefined || req.headers.origin === 'http://' + host)
}

export interface PanelDeps {
  /** The configured dwsBinary value (install target resolution input). */
  configBinary: () => string
  /** 契约路由（P-B）：engine receive 与 channelConfig 持有器；测试可注入 stateDir/sendImpl。 */
  receive: (trigger: TriggerLike) => unknown | Promise<unknown>
  holder: () => HealthHolder | undefined
  /** 测试注入：契约路由 targets/失败日志根目录。 */
  stateDir?: string
  /** 测试注入：deliver/test 发送实现（缺省 sendDwsMessage 真链路）。 */
  sendImpl?: (binary: string, account: EffectiveAccount, address: Record<string, string>, text: string, key: string) => Promise<void>
}

export function createPanelHandler(deps: PanelDeps, sessions: LoginSessionManager, port: number): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    if (!sameOrigin(req, port)) { respondJson(res, 403, { error: 'Same-origin management request required' }); return }
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (!url.pathname.startsWith('/dws/')) { respondJson(res, 404, { error: 'not found' }); return }
    const path = url.pathname.slice('/dws'.length)
    if (path === '/api/state' && req.method === 'GET') {
      // 先做带缓存的实时探测再快照，否则卡片会把已安装显示成未检测（watch 未跑时装态为空）。
      await probeCached(deps.configBinary()).catch(() => null)
      const profiles = await listProfiles(deps.configBinary()).catch(() => [])
      respondJson(res, 200, {
        binary: binarySnapshot(),
        install: installState(),
        login: sessions.status(),
        profiles: profiles.map((p) => ({ profile: p.profile, corpName: p.corpName ?? '', userName: p.userName ?? '', isCurrent: p.isCurrent === true })),
      })
      return
    }
    if (path === '/api/install' && req.method === 'POST') {
      void ensureInstalled(deps.configBinary()).catch(() => null)
      respondJson(res, 202, { started: true })
      return
    }
    if (path === '/api/login/start' && req.method === 'POST') {
      await sessions.start(deps.configBinary())
      respondJson(res, 202, { started: true })
      return
    }
    if (path === '/api/login/cancel' && req.method === 'POST') {
      sessions.cancel()
      respondJson(res, 200, { ok: true })
      return
    }
    respondJson(res, 404, { error: 'not found' })
  }
}

/** binarySnapshot lives in install.ts; imported lazily to avoid a cycle at module init. */
import { binaryState } from './install.ts'
function binarySnapshot(): { path: string | null; version: string | null; missing: boolean } {
  return { path: binaryState.path, version: binaryState.version, missing: binaryState.path === null }
}

/** 在引擎 webserver 上注册 /dws 面板路由 + 契约路由（同一 register 调用面追加，
 *  契约 §1 统一前缀 /dsh-dws/api 与既有 /dws/api 面板路由并存，闸门同款 sameOrigin），
 *  返回卸载 disposer（同时卸两组路由）。 */
export function registerPanelRoutes(webServer: WebServerLike, deps: PanelDeps, sessions: LoginSessionManager): () => void {
  const handler = createPanelHandler(deps, sessions, webServer.port)
  const unbindPanel = webServer.register({
    kind: 'prefix',
    path: '/dws',
    handler: (req, res) => {
      handler(req, res).catch((error: unknown) => {
        console.error('[dws-panel] request error: ' + String(error).slice(0, 200))
        respondJson(res, 400, { error: 'bad request' })
      })
    },
  })
  const unbindApi = registerContractRoutes(webServer, {
    receive: deps.receive,
    holder: deps.holder,
    ...(deps.stateDir !== undefined ? { stateDir: deps.stateDir } : {}),
    ...(deps.sendImpl !== undefined ? { sendImpl: deps.sendImpl } : {}),
  })
  return () => {
    unbindPanel()
    unbindApi()
  }
}
