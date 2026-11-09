/** Panel same-origin routes for the dws install/login surface (/dws/api/*), gated
 *  exactly like the engine's own management API (Host loopback:<port> +
 *  x-orchestrator-request: 1 + Origin absent-or-same). The client bundle
 *  (lib/client.js) talks only to these routes; no credentials are involved. */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { listProfiles } from './dws-cli.ts'
import { ensureInstalled, installState, probeCached } from './install.ts'
import { LoginSessionManager } from './login-session.ts'

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

function sameOrigin(req: Pick<IncomingMessage, 'headers'>, port: number): boolean {
  const host = req.headers.host
  if (host !== '127.0.0.1:' + port && host !== 'localhost:' + port) return false
  return req.headers['x-orchestrator-request'] === '1' &&
    (req.headers.origin === undefined || req.headers.origin === 'http://' + host)
}

export interface PanelDeps {
  /** The configured dwsBinary value (install target resolution input). */
  configBinary: () => string
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

export function registerPanelRoutes(webServer: WebServerLike, deps: PanelDeps, sessions: LoginSessionManager): () => void {
  const handler = createPanelHandler(deps, sessions, webServer.port)
  return webServer.register({
    kind: 'prefix',
    path: '/dws',
    handler: (req, res) => {
      handler(req, res).catch((error: unknown) => {
        console.error('[dws-panel] request error: ' + String(error).slice(0, 200))
        respondJson(res, 400, { error: 'bad request' })
      })
    },
  })
}
