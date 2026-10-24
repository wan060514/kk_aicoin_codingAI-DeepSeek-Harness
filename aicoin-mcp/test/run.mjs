/**
 * test/run.mjs — 零依赖测试运行器。
 *
 * 用法：
 *   node test/run.mjs                # 跑全部 *.test.mjs
 *   node test/run.mjs cdp registry   # 只跑文件名包含 cdp / registry 的测试文件
 */

import { readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { AssertionError, withTimeout } from './helpers/harness.mjs'

const TEST_DIR = dirname(fileURLToPath(import.meta.url))
const useColor = process.stdout.isTTY && !process.env.NO_COLOR
const green = (s) => (useColor ? `\x1b[32m${s}\x1b[0m` : s)
const red = (s) => (useColor ? `\x1b[31m${s}\x1b[0m` : s)
const dim = (s) => (useColor ? `\x1b[2m${s}\x1b[0m` : s)
const bold = (s) => (useColor ? `\x1b[1m${s}\x1b[0m` : s)

const filters = process.argv.slice(2).filter((arg) => !arg.startsWith('-'))
const started = Date.now()

async function collectTestFiles() {
  const entries = await readdir(TEST_DIR, { withFileTypes: true })
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => name.endsWith('.test.mjs'))
    .filter((name) => name !== 'run.mjs')
    .filter((name) => (filters.length === 0 ? true : filters.some((f) => name.includes(f))))
    .sort()
}

let passed = 0
let failed = 0
/** @type {Array<{name: string, error: any}>} */
const failures = []

const files = await collectTestFiles()
if (files.length === 0) {
  console.error(red(`没有找到测试文件${filters.length ? `（过滤条件：${filters.join(', ')}）` : ''}`))
  process.exit(1)
}

console.log(bold(`\naicoin-mcp 测试套件 — ${files.length} 个测试文件\n`))

for (const file of files) {
  const filePath = join(TEST_DIR, file)
  let suite
  try {
    suite = await import(pathToFileURL(filePath).href)
  } catch (err) {
    failed += 1
    failures.push({ name: `${file}（导入失败）`, error: err })
    console.log(`${red('✗')} ${bold(file)} ${dim('导入测试文件失败')}`)
    console.log(red(String(err?.stack ?? err)))
    continue
  }

  const tests = Array.isArray(suite.tests) ? suite.tests : []
  if (tests.length === 0) {
    console.log(`${dim('·')} ${bold(file)} ${dim('（没有测试）')}`)
    continue
  }
  console.log(bold(file))

  for (const test of tests) {
    const testStarted = Date.now()
    try {
      await withTimeout(Promise.resolve().then(test.fn), test.timeoutMs, test.name)
      passed += 1
      console.log(`  ${green('✓')} ${test.name} ${dim(`${Date.now() - testStarted}ms`)}`)
    } catch (err) {
      failed += 1
      failures.push({ name: test.name, error: err })
      const isAssertion = err instanceof AssertionError
      console.log(`  ${red('✗')} ${test.name} ${dim(`${Date.now() - testStarted}ms`)}`)
      if (isAssertion) console.log(red(`      ${err.message}`))
      else console.log(red(String(err?.stack ?? err).split('\n').slice(0, 8).join('\n      ')))
    }
  }
}

const totalMs = Date.now() - started
console.log('')
if (failed === 0) {
  console.log(bold(green(`全部通过：${passed} 个测试，${totalMs}ms`)))
} else {
  console.log(bold(red(`失败 ${failed} 个 / 通过 ${passed} 个，${totalMs}ms`)))
  for (const failure of failures) {
    console.log(red(`  ✗ ${failure.name}`))
    console.log(red(`      ${failure.error?.message ?? failure.error}`))
  }
}
console.log('')

// 测试里会起 mock 服务器 / 子进程，显式退出避免残留句柄拖住进程
process.exit(failed === 0 ? 0 : 1)
