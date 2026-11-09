/** 浏览器 client bundle：在 superagent 引擎原生面板（127.0.0.1:3082）注册「钉钉登录」页。
 *
 *  形态：scripts/build-client.mjs 把本文件编译成 CJS 并包上
 *  window.__ModuleLoader__.load({ id: 'dsh-superagent-dws', factory: (require) => {...} })
 *  横幅产 lib/client.js（横幅 id 与 package.json 包名一致，与官方 client bundle 同款）。
 *  slots/locale 服务由宿主面板提供，react 从宿主模块表 require，零 npm 依赖。
 *
 *  注册面（与引擎官方 client 完全同构）：
 *  - slots.inject('main')              → 主面板页（安装状态 + 设备流登录状态机）
 *  - slots.inject('sidebar.panellist') → 侧栏入口（图标 + 标签）
 *
 *  数据面：同源 fetch /dws/api/*（src/panel.ts 注册在引擎 webserver 上，闸门与引擎
 *  管理 API 同款 sameOrigin）。页面 JS 有意不用模板字面量（全部字符串拼接）。
 */

interface ReactLike {
  createElement(type: unknown, props?: Record<string, unknown> | null, ...children: unknown[]): unknown
  Component: new (props: Record<string, unknown>) => ComponentLike
  useState<T>(initial: T): [T, (value: T | ((previous: T) => T)) => void]
  useEffect(effect: () => void | (() => void), deps?: unknown[]): void
}

interface ComponentLike {
  props: Record<string, unknown>
  state: Record<string, unknown>
  setState(patch: Record<string, unknown>): void
  render(): unknown
}

/** react 从宿主 ModuleLoader 的模块表 require（baseline external）。 */
const React = require('react') as ReactLike
// 「源设置」共享页壳（canonical vendored 副本）与 dws tab 内容
import { installSourcesSettingsPage } from './shell/shell.ts'
import { DwsSourcesTab } from './shell/tab.ts'
/** 本包版本（「关于」tab 更新检查用；发版时与 package.json 同步改）。 */
const LOCAL_VERSION = '0.2.0'

const NS = 'dshSuperagentDws'
const PANEL_ID = 'dsh-superagent-dws'
const API_BASE = '/dws/api'

const zh: Record<string, string> = { panel: '钉钉登录' }
const en: Record<string, string> = { panel: 'DingTalk Login' }

interface SlotsRegistryLike {
  inject(key: string, callback: () => () => void): () => void
  register(spec: Record<string, unknown>, component: unknown): () => void
}
interface LocaleFaceLike {
  register(namespace: string, dictionaries: { zh: Record<string, string>; en: Record<string, string> }): () => void
  bind(namespace: string): (key: string) => string
}
interface ClientContextLike {
  effect(fn: () => () => void, label: string): void
  slots: SlotsRegistryLike
  locale: LocaleFaceLike
}

export const inject: string[] = ['slots', 'locale']

interface BinaryInfo { path: string | null; version: string | null; missing: boolean }
interface InstallState { phase: string; registry?: string; attempt: number; total: number; error?: string; version?: string }
interface ProfileInfo { profile: string; corpName: string; userName: string; isCurrent: boolean }
interface LoginState { running: boolean; startedAt?: string; lines: string[]; done: boolean; error?: string; profiles: ProfileInfo[] }
interface StatePayload { binary: BinaryInfo; install: InstallState; login: LoginState; profiles: ProfileInfo[] }

/** 与引擎管理 API 同款请求头；同源请求，自定义头不触发 CORS 预检。 */
function requestHeaders(json: boolean): Record<string, string> {
  const headers: Record<string, string> = { 'x-orchestrator-request': '1' }
  if (json) headers['content-type'] = 'application/json'
  return headers
}

async function getJson(path: string): Promise<{ status: number; data: Record<string, unknown> | null }> {
  try {
    const res = await fetch(path, { headers: requestHeaders(false) })
    const text = await res.text()
    let data: Record<string, unknown> | null = null
    if (text) { try { data = JSON.parse(text) as Record<string, unknown> } catch { data = null } }
    return { status: res.status, data }
  } catch { return { status: 0, data: null } }
}

async function postJson(path: string): Promise<{ status: number; data: Record<string, unknown> | null }> {
  try {
    const res = await fetch(path, { method: 'POST', headers: requestHeaders(true) })
    const text = await res.text()
    let data: Record<string, unknown> | null = null
    if (text) { try { data = JSON.parse(text) as Record<string, unknown> } catch { data = null } }
    return { status: res.status, data }
  } catch { return { status: 0, data: null } }
}

function copyText(text: string, onDone: (ok: boolean) => void): void {
  const fallback = function (): void {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    let ok = false
    try { ok = document.execCommand('copy') } catch { ok = false }
    document.body.removeChild(ta)
    onDone(ok)
  }
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(function () { onDone(true) }, fallback)
  } else {
    fallback()
  }
}

const PAGE: Record<string, unknown> = { fontFamily: '-apple-system, "PingFang SC", sans-serif', fontSize: 14, lineHeight: 1.6, color: '#1f2328', maxWidth: '620px' }
const SUB: Record<string, string> = { color: '#656d76', fontSize: '13px', margin: '4px 0 12px' }
const BTN: Record<string, unknown> = { fontSize: 14, padding: '7px 16px', borderRadius: 6, border: '1px solid #d0d7de', background: '#f6f8fa', cursor: 'pointer', marginRight: 8 }
const PRE: Record<string, unknown> = { background: '#f6f8fa', border: '1px solid #eaeef2', borderRadius: 8, padding: 12, fontSize: 12, overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }
const ERR: Record<string, string> = { color: '#cf222e', fontSize: '13px', margin: '6px 0' }
const HINT: Record<string, string> = { color: '#656d76', fontSize: '12px' }
const OK: Record<string, string> = { color: '#1a7f37', fontSize: '13px' }
const ROW: Record<string, unknown> = { display: 'flex', alignItems: 'center', gap: 8, margin: '4px 0' }
const CARD: Record<string, unknown> = { border: '1px solid #eaeef2', borderRadius: 8, padding: '10px 14px', margin: '8px 0' }
const BOUNDARY_ERR: Record<string, unknown> = { color: '#cf222e', fontSize: '13px', border: '1px solid #ffd0cc', background: '#fff5f3', borderRadius: 8, padding: 12 }

function asState(data: Record<string, unknown> | null): StatePayload | null {
  if (!data || typeof data !== 'object') return null
  const binary = data.binary as BinaryInfo | undefined
  const install = data.install as InstallState | undefined
  const login = data.login as LoginState | undefined
  const profiles = data.profiles as ProfileInfo[] | undefined
  if (!binary || !install || !login || !Array.isArray(profiles)) return null
  return { binary, install, login, profiles }
}

/** 设备流输出里的 URL 自动变成可点链接（不引入 dangerouslySetInnerHTML）。 */
function renderLines(lines: string[]): unknown[] {
  const out: unknown[] = []
  for (const [index, line] of lines.entries()) {
    const match = /(https?:\/\/[^\s<>"']+)|(\b[A-Z0-9]{4,8}(?:-[A-Z0-9]{4,8})+\b)/.exec(line)
    if (!match || match.index === undefined) {
      out.push(React.createElement('div', { key: String(index) }, line))
      continue
    }
    const parts: unknown[] = []
    let cursor = 0
    let raw = match[0]
    let at = match.index
    // 单次切分足够：设备流一行最多一个 URL 或一个 user_code。
    parts.push(line.slice(cursor, at))
    if (raw.indexOf('http') === 0) {
      parts.push(React.createElement('a', { key: 'u', href: raw, target: '_blank', rel: 'noreferrer' }, raw))
    } else {
      parts.push(React.createElement('b', { key: 'c' }, raw))
    }
    parts.push(line.slice(at + raw.length))
    out.push(React.createElement('div', { key: String(index) }, parts))
  }
  return out
}

/** 登录/安装状态机页。 */
function LoginPage(): unknown {
  const stateState = React.useState(null as StatePayload | null)
  const data = stateState[0]
  const setData = stateState[1]
  const hintState = React.useState('')
  const hint = hintState[0]
  const setHint = hintState[1]
  React.useEffect(function () {
    let alive = true
    const tick = async function (): Promise<void> {
      const res = await getJson(API_BASE + '/state')
      if (alive && res.status === 200) {
        const parsed = asState(res.data)
        if (parsed) setData(parsed)
      }
    }
    void tick()
    const iv = setInterval(function () { void tick() }, 2000)
    return function () { alive = false; clearInterval(iv) }
  }, [])
  if (!data) {
    return React.createElement('div', { style: PAGE }, React.createElement('p', null, '正在连接引擎…'))
  }
  const children: unknown[] = []
  children.push(React.createElement('p', { key: 'intro', style: SUB }, '钉钉个人身份（dws CLI）：登录你的钉钉账号，把「你」的消息事件流接入引擎。'))
  // CLI 安装状态（M3：多源静默安装）
  if (data.binary.version) {
    children.push(React.createElement('p', { key: 'bin', style: OK }, '✅ dws CLI 已安装（v' + data.binary.version + '）'))
  } else {
    children.push(React.createElement('div', { key: 'bin-missing', style: CARD },
      React.createElement('p', { style: ERR }, '未检测到本机 dws CLI。'),
      React.createElement('button', { style: BTN, type: 'button', onClick: function () { void postJson(API_BASE + '/install') } }, '静默安装 dws CLI'),
      React.createElement('p', { style: HINT }, '自动按源尝试安装（npmmirror → npm 官方），完成后自动继续登录流程。'),
      data.install.phase === 'installing'
        ? React.createElement('p', { style: HINT }, '正在安装（源 ' + (data.install.registry ?? '') + '，第 ' + data.install.attempt + '/' + data.install.total + ' 次）…')
        : null,
      data.install.phase === 'failed' && data.install.error ? React.createElement('p', { style: ERR }, '安装失败：' + data.install.error) : null,
    ))
  }
  // 已登录账号
  children.push(React.createElement('h3', { key: 'h-accounts' }, '已登录账号'))
  if (data.profiles.length === 0) {
    children.push(React.createElement('p', { key: 'none', style: SUB }, '（无）——先登录一个账号。'))
  } else {
    for (const p of data.profiles) {
      children.push(React.createElement('div', { key: p.profile, style: ROW },
        React.createElement('code', null, p.profile),
        React.createElement('span', { style: HINT }, (p.corpName || '') + (p.userName ? ' · ' + p.userName : '') + (p.isCurrent ? '（当前）' : '')),
      ))
    }
  }
  // 登录状态机
  children.push(React.createElement('h3', { key: 'h-login' }, '登录新账号'))
  const login = data.login
  if (login.running) {
    children.push(React.createElement('div', { key: 'running' },
      React.createElement('p', null, '设备流进行中：在浏览器打开下面的链接，输入配对码完成授权。'),
      React.createElement('pre', { style: PRE }, renderLines(login.lines).length > 0 ? renderLines(login.lines) : '（等待输出…）'),
      React.createElement('button', { style: BTN, type: 'button', onClick: function () { void postJson(API_BASE + '/login/cancel') } }, '取消'),
    ))
  } else {
    children.push(React.createElement('div', { key: 'idle' },
      React.createElement('button', { style: BTN, type: 'button', onClick: function () { void postJson(API_BASE + '/login/start') } }, '登录新账号（设备流）'),
      login.done && login.error ? React.createElement('p', { style: ERR }, login.error) : null,
      login.done && !login.error ? React.createElement('p', { style: OK }, '登录完成。') : null,
    ))
  }
  if (login.done && login.profiles.length > 0) {
    const items: unknown[] = []
    for (const p of login.profiles) {
      items.push(React.createElement('div', { key: p.profile, style: ROW },
        React.createElement('code', null, p.profile),
        React.createElement('span', { style: HINT }, (p.corpName || '') + (p.userName ? ' · ' + p.userName : '')),
        React.createElement('button', { style: BTN, type: 'button', onClick: function () {
          copyText(p.profile, function (ok) { setHint(ok ? '已复制：' + p.profile : '复制失败，请手动选择文本复制') })
        } }, '复制 Profile'),
      ))
    }
    children.push(React.createElement('div', { key: 'new-profiles', style: CARD },
      React.createElement('p', null, '新登录的账号：'),
      items,
      React.createElement('p', { style: HINT }, '到 设置 → 来源 → 钉钉个人（dws）→ 钉钉账号 添加一行，把 Profile 粘贴进去（留空 = 当前登录账号）。保存后约 5 秒生效。'),
      hint ? React.createElement('p', { style: OK }, hint) : null,
    ))
  }
  children.push(React.createElement('p', { key: 'foot', style: HINT }, '凭据由 dws CLI 管理（macOS 钥匙串），本插件与面板不接触任何 token。'))
  return React.createElement('div', { style: PAGE }, children)
}

/** 错误边界：页面崩溃时显示一行诊断文字而不是让整个面板白屏。 */
class LoginErrorBoundary extends React.Component {
  constructor(props: Record<string, unknown>) {
    super(props)
    this.state = { error: '' }
  }
  static getDerivedStateFromError(error: unknown): Record<string, unknown> {
    const message = error instanceof Error ? error.message : String(error)
    return { error: message.slice(0, 300) }
  }
  render(): unknown {
    const error = String(this.state.error || '')
    if (error) {
      return React.createElement('div', { style: BOUNDARY_ERR }, '钉钉登录页崩溃：' + error + '（详情见浏览器控制台）')
    }
    return this.props.children !== undefined ? this.props.children : null
  }
}

/** 侧栏图标：闪电（DingTalk 意象）。 */
function DwsIcon(props: Record<string, unknown>): unknown {
  const size = typeof props.size === 'number' ? props.size : 16
  return React.createElement('svg', {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    'aria-hidden': true,
  },
    React.createElement('path', { d: 'M13 2 4.5 13.5h6L11 22l8.5-11.5h-6L13 2z' }),
  )
}

export function apply(ctx: ClientContextLike): void {
  const t = ctx.locale.bind(NS)
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-superagent-dws: dictionaries')
  ctx.effect(() => ctx.slots.inject('main', () => ctx.slots.register(
    { name: 'main', key: PANEL_ID, locale: NS, inject: () => ({}) },
    () => React.createElement(LoginErrorBoundary, null, React.createElement(LoginPage, null)),
  )), 'dsh-superagent-dws: main panel')
  ctx.effect(() => ctx.slots.inject('sidebar.panellist', () => ctx.slots.register(
    { name: 'sidebar.panellist', id: PANEL_ID, order: 11, label: () => t('panel'), locale: NS },
    DwsIcon,
  )), 'dsh-superagent-dws: sidebar entry')
  // 「源设置」共享页壳（契约 §4）：贡献 dws tab + 竞争注册页面（S1 throw 即退为贡献方）。
  ctx.effect(() => installSourcesSettingsPage(ctx, {
    kind: 'dws',
    order: 60,
    label: '钉钉(dws)',
    apiBase: '/dsh-dws/api',
    packageName: 'dsh-superagent-dws',
    localVersion: LOCAL_VERSION,
    React,
    renderTab: () => React.createElement(DwsSourcesTab, null),
  }), 'dsh-superagent-dws: sources settings shell')
}
