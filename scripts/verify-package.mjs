#!/usr/bin/env node
// 包完整性校验（CI 闸门最后一环，零依赖）：
//   1. package.json files[] 白名单每一项都存在
//   2. lib/index.js 含 sources.register( 与 kind 名（不带引号子串探针，防引号风格假阴性）
//   3. 有 ./client export 的仓：lib/client.js 必须存在且非空
//   4. cordis.patch.yml 的 - id: 与包名一致
//   5. locale/zh.json 与 en.json 可解析且顶层 key 集合一致
//   6. icon.svg 存在
//   7. package.json 存在 dsh.compatibility 兼容性声明
// 失败逐条打印并 exit 1；全部通过打印 verify-package: OK。
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()
const failures = []
const check = (ok, message) => { if (!ok) failures.push(message) }

let pkg
try {
  pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
} catch (error) {
  console.error('verify-package: package.json 不可解析: ' + String(error))
  process.exit(1)
}
const name = String(pkg.name ?? '')
// kind 名 = 包名后缀（dsh-superagent-dws → dws）
const kind = name.startsWith('dsh-superagent-') ? name.slice('dsh-superagent-'.length) : name
check(name.length > 0, 'package.json 缺少 name')

// 1. files[] 全部存在
const files = Array.isArray(pkg.files) ? pkg.files : []
check(files.length > 0, 'package.json files[] 为空')
for (const entry of files) {
  check(existsSync(join(root, String(entry))), 'files[] 缺失: ' + String(entry))
}

// 2. lib/index.js 产物探针
const indexPath = join(root, 'lib/index.js')
check(existsSync(indexPath), 'lib/index.js 不存在（先 pnpm build）')
if (existsSync(indexPath)) {
  const lib = readFileSync(indexPath, 'utf8')
  check(lib.includes('sources.register('), "lib/index.js 缺少 sources.register( 探针")
  check(kind.length > 0 && lib.includes(kind), 'lib/index.js 缺少 kind 名探针: ' + kind)
}

// 3. ./client export → lib/client.js 存在且非空
if (pkg.exports && pkg.exports['./client']) {
  const clientPath = join(root, 'lib/client.js')
  const ok = existsSync(clientPath) && statSync(clientPath).size > 0
  check(ok, './client export 已声明但 lib/client.js 缺失或为空')
}

// 4. cordis.patch.yml - id: 与包名一致
const patchPath = join(root, 'cordis.patch.yml')
if (existsSync(patchPath)) {
  const ids = readFileSync(patchPath, 'utf8').split('\n')
    .map((line) => line.match(/^\s*-\s*id:\s*(.+?)\s*$/))
    .filter(Boolean)
    .map((m) => m[1].replace(/^['"]|['"]$/g, ''))
  check(ids.includes(name), 'cordis.patch.yml - id: 应为 ' + name + '，实际: ' + (ids.join(', ') || '(无)'))
} else {
  check(false, 'cordis.patch.yml 不存在')
}

// 5. locale 双语可解析且顶层 key 集合一致
const readLocale = (file) => {
  try {
    return JSON.parse(readFileSync(join(root, file), 'utf8'))
  } catch (error) {
    failures.push(file + ' 不可解析: ' + String(error))
    return null
  }
}
const zh = readLocale('locale/zh.json')
const en = readLocale('locale/en.json')
if (zh && en) {
  const zhKeys = Object.keys(zh).sort().join(',')
  const enKeys = Object.keys(en).sort().join(',')
  check(zhKeys === enKeys, 'locale 顶层 key 不一致: zh=[' + zhKeys + '] en=[' + enKeys + ']')
}

// 6. icon.svg
check(existsSync(join(root, 'icon.svg')), 'icon.svg 不存在')

// 7. dsh.compatibility
check(Boolean(pkg.dsh && pkg.dsh.compatibility), 'package.json 缺少 dsh.compatibility 兼容性声明')

if (failures.length > 0) {
  for (const message of failures) console.error('verify-package: ' + message)
  process.exit(1)
}
console.log('verify-package: OK')
