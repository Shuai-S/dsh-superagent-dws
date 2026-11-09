#!/usr/bin/env node
/** 把 src/client.ts（含 vendored 壳/ tab 多文件导入）bundle 成 CJS 并包上 ModuleLoader 横幅 → lib/client.js。
 *
 *  client bundle 的横幅形状（window.__ModuleLoader__.load({ id, factory: (require) => {...} }) +
 *  module/exports intro + return module.exports footer）是浏览器 ModuleLoader 的装载契约
 *  （与官方 dsh-superagent、dsh-superagent-console 的 lib/client.js 逐字节同构）。
 *
 *  P-C'（契约 §4 依赖豁免）：页壳/ tab 为多文件 vendored .ts 导入，单文件 tsc 编译不再适用，
 *  改用 esbuild --bundle 产单文件（devDep，契约 §4 显式豁免）；react 保持 external——
 *  运行时从宿主模块表 require，零 npm 运行时依赖不变。
 *
 *  横幅 id 必须等于 package.json 的包名 dsh-superagent-dws（ModuleLoader 注册 id）。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const tmp = mkdtempSync(join(tmpdir(), 'dsh-dws-client-'))
try {
  const esbuild = (await import('esbuild')).default
  await esbuild.build({
    entryPoints: [join(root, 'src/client.ts')],
    bundle: true,
    format: 'cjs',
    platform: 'browser',
    external: ['react'],
    target: 'es2024',
    outfile: join(tmp, 'client.js'),
    logLevel: 'warning',
  })
  const body = readFileSync(join(tmp, 'client.js'), 'utf8')
  const banner = 'window.__ModuleLoader__.load({ id: "dsh-superagent-dws", factory: (require) => {'
  const intro = 'var module = { exports: {} }; var exports = module.exports;'
  const footer = 'return module.exports; } });'
  mkdirSync(join(root, 'lib'), { recursive: true })
  writeFileSync(join(root, 'lib', 'client.js'), banner + '\n' + intro + '\n' + body + '\n' + footer + '\n')
  console.log('[build-client] lib/client.js written (body ' + body.length + ' bytes)')
} finally {
  rmSync(tmp, { recursive: true, force: true })
}
