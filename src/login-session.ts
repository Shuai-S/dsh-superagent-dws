/** Device-flow login session: spawns `dws auth login --device --no-browser`, streams
 *  its output for the panel card, and completes when a new profile appears in
 *  `dws profile list` (diffed against the pre-login set) or the process exits 0.
 *  One session at a time; 8 minute timeout; cancel kills the child (never kill -9
 *  semantics — SIGTERM lets the CLI clean its loopback listener). */
import { spawn, type ChildProcess } from 'node:child_process'
import { listProfiles, type DwsProfileInfo } from './dws-cli.ts'

const TIMEOUT_MS = 8 * 60_000
const POLL_MS = 3_000
const LINES_KEPT = 40

export interface LoginState {
  running: boolean
  startedAt?: string
  lines: string[]
  done: boolean
  error?: string
  /** Profiles that appeared during this session (the "add as account" candidates). */
  profiles: DwsProfileInfo[]
}

/** 依赖注入（纯状态转移测试用）：默认接真实 CLI 进程与 profile 读取，行为不变。 */
export interface LoginSessionDeps {
  listProfiles?: (binary: string) => Promise<DwsProfileInfo[]>
  spawn?: typeof spawn
}

export class LoginSessionManager {
  private readonly listProfilesFn: (binary: string) => Promise<DwsProfileInfo[]>
  private readonly spawnFn: typeof spawn
  private child: ChildProcess | null = null
  private lines: string[] = []
  private startedAt: string | undefined
  private running = false
  private done = false
  private error: string | undefined
  private profiles: DwsProfileInfo[] = []
  private before = new Set<string>()
  private timer: ReturnType<typeof setTimeout> | null = null
  private poller: ReturnType<typeof setInterval> | null = null
  private binary = ''

  constructor(deps: LoginSessionDeps = {}) {
    this.listProfilesFn = deps.listProfiles ?? listProfiles
    this.spawnFn = deps.spawn ?? spawn
  }

  async start(binary: string): Promise<void> {
    if (this.running) return
    this.binary = binary
    this.lines = []
    this.profiles = []
    this.error = undefined
    this.done = false
    this.startedAt = new Date().toISOString()
    const before = await this.listProfilesFn(binary)
    this.before = new Set(before.map((p) => p.profile))
    const child = this.spawnFn(binary, ['auth', 'login', '--device', '--no-browser'], { stdio: ['ignore', 'pipe', 'pipe'] })
    this.child = child
    this.running = true
    const onLine = (line: string): void => {
      const text = line.trim()
      if (!text) return
      this.lines.push(text.slice(0, 300))
      if (this.lines.length > LINES_KEPT) this.lines.splice(0, this.lines.length - LINES_KEPT)
    }
    child.stdout?.on('data', (chunk: Buffer) => { for (const line of String(chunk).split(/\r?\n/)) onLine(line) })
    child.stderr?.on('data', (chunk: Buffer) => { for (const line of String(chunk).split(/\r?\n/)) onLine(line) })
    child.once('exit', (code) => {
      if (this.done) return
      if (code === 0) void this.finish()
      else this.fail(`login process exited (code=${code})`)
    })
    child.once('error', (error: unknown) => { if (!this.done) this.fail(String(error).slice(0, 200)) })
    this.timer = setTimeout(() => this.fail('login-timeout'), TIMEOUT_MS)
    this.poller = setInterval(() => { void this.poll() }, POLL_MS)
  }

  private async poll(): Promise<void> {
    if (!this.running || this.done) return
    try {
      const now = await this.listProfilesFn(this.binary)
      if (now.some((p) => !this.before.has(p.profile))) await this.finish(now)
    } catch { /* transient profile read failures keep the session polling */ }
  }

  private async finish(current?: DwsProfileInfo[]): Promise<void> {
    if (this.done) return
    this.done = true
    this.running = false
    this.teardown()
    const now = current ?? await this.listProfilesFn(this.binary).catch(() => [] as DwsProfileInfo[])
    this.profiles = now.filter((p) => !this.before.has(p.profile))
    if (this.profiles.length === 0 && this.error === undefined) this.error = 'login finished but no new profile appeared'
  }

  private fail(message: string): void {
    if (this.done) return
    this.done = true
    this.running = false
    this.error = message
    this.teardown()
  }

  private teardown(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null }
    if (this.poller) { clearInterval(this.poller); this.poller = null }
    if (this.child) { try { this.child.kill('SIGTERM') } catch { /* already gone */ } this.child = null }
  }

  status(): LoginState {
    return { running: this.running, startedAt: this.startedAt, lines: [...this.lines], done: this.done, error: this.error, profiles: this.profiles }
  }

  cancel(): void {
    if (!this.running) return
    this.fail('cancelled')
  }
}
