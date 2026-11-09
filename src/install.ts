/** Silent multi-source installer for the dws CLI (npm package dingtalk-workspace-cli).
 *  Product decision by the package owner (2026-11-09): when the binary is missing the
 *  watcher installs it without an explicit click, trying npm registries in order and
 *  verifying the result. Every attempt is audited to the engine log; failures surface
 *  on the single dwsStream health entry. No credentials are involved or logged. */
import { execFile } from 'node:child_process'
import { dirname, join } from 'node:path'
import { binaryCandidates, probeBinary } from './dws-cli.ts'

const PACKAGE = 'dingtalk-workspace-cli'
/** npmmirror first (fast, reliable in CN), official registry as the authority fallback. */
const REGISTRIES = ['https://registry.npmmirror.com', 'https://registry.npmjs.org']
const INSTALL_TIMEOUT_MS = 300_000
const COOLDOWN_MS = 60_000
const MAX_ROUNDS = 3

export interface InstallState {
  phase: 'idle' | 'installing' | 'done' | 'failed'
  registry?: string
  attempt: number
  total: number
  startedAt?: string
  finishedAt?: string
  error?: string
  version?: string
}

/** Live binary fact the watcher refreshes each round and the panel card displays. */
export const binaryState: { path: string | null; version: string | null } = { path: null, version: null }

let state: InstallState = { phase: 'idle', attempt: 0, total: REGISTRIES.length }
let inFlight: Promise<{ path: string; version: string | null } | null> | null = null
let lastFinish = 0
let rounds = 0

export function installState(): InstallState {
  return { ...state }
}

/** Detection-only probe with a TTL cache: refreshes binaryState for the panel card
 *  without any install side effect (the /dws/api/state route polls this). */
let probeCache: { at: number; result: { path: string; version: string | null } | null } = { at: 0, result: null }
export async function probeCached(configBinary: string, ttlMs = 30_000): Promise<{ path: string; version: string | null } | null> {
  if (Date.now() - probeCache.at < ttlMs) return probeCache.result
  const result = await probeAll(configBinary)
  probeCache = { at: Date.now(), result }
  binaryState.path = result?.path ?? null
  binaryState.version = result?.version ?? null
  return result
}

function npmCandidates(): string[] {
  return [join(dirname(process.execPath), 'npm'), 'npm']
}

function runNpm(npmPath: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(npmPath, args, { timeout: INSTALL_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      if (error) reject(new Error(String((error as { message?: string }).message ?? error).slice(0, 200) + (stderr ? ' | ' + String(stderr).slice(0, 200) : '')))
      else resolve(String(stdout))
    })
  })
}

async function probeAll(configBinary: string): Promise<{ path: string; version: string | null } | null> {
  for (const candidate of binaryCandidates(configBinary)) {
    const version = await probeBinary(candidate)
    if (version !== null) return { path: candidate, version }
  }
  return null
}

/** Resolves the dws binary, silently installing it when missing. Returns null while
 *  unavailable (install failed, cooling down, or round budget exhausted). */
export async function ensureInstalled(configBinary: string): Promise<{ path: string; version: string | null } | null> {
  const found = await probeAll(configBinary)
  if (found) return found
  if (inFlight) return inFlight
  if (Date.now() - lastFinish < COOLDOWN_MS) return null
  if (rounds >= MAX_ROUNDS) return null
  rounds += 1
  inFlight = (async () => {
    state = { phase: 'installing', attempt: 0, total: REGISTRIES.length, startedAt: new Date().toISOString() }
    for (const registry of REGISTRIES) {
      state = { ...state, phase: 'installing', registry, attempt: state.attempt + 1 }
      for (const npmPath of npmCandidates()) {
        console.error(`[dws] silent install: ${npmPath} install -g ${PACKAGE} --registry ${registry} (attempt ${state.attempt}/${REGISTRIES.length})`)
        try { await runNpm(npmPath, ['install', '-g', PACKAGE + '@latest', '--registry', registry]) }
        catch (error) {
          console.error(`[dws] install failed via ${registry} (${npmPath}): ${String(error).slice(0, 240)}`)
          continue
        }
        const installed = await probeAll(configBinary)
        if (installed) {
          state = { phase: 'done', registry, attempt: state.attempt, total: REGISTRIES.length, finishedAt: new Date().toISOString(), version: installed.version ?? undefined }
          console.error(`[dws] silent install ok: ${installed.path} v${installed.version ?? '?'}`)
          return installed
        }
      }
    }
    state = { phase: 'failed', attempt: REGISTRIES.length, total: REGISTRIES.length, finishedAt: new Date().toISOString(), error: 'all registries failed; see engine log' }
    console.error('[dws] silent install failed across all registries')
    return null
  })()
  try { return await inFlight } finally { inFlight = null; lastFinish = Date.now() }
}
