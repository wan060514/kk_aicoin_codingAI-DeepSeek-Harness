/**
 * test/helpers/harness.mjs — 零依赖测试脚手架（断言 + 等待 + 超时）。
 */

export class AssertionError extends Error {
  constructor(message) {
    super(message)
    this.name = 'AssertionError'
  }
}

export function formatValue(value) {
  if (typeof value === 'string') return JSON.stringify(value.length > 300 ? `${value.slice(0, 300)}…` : value)
  try {
    const text = JSON.stringify(value)
    return text === undefined ? String(value) : text.length > 300 ? `${text.slice(0, 300)}…` : text
  } catch {
    return String(value)
  }
}

export function assert(condition, message = '断言失败') {
  if (!condition) throw new AssertionError(message)
}

export function assertEqual(actual, expected, message = '') {
  if (!Object.is(actual, expected)) {
    throw new AssertionError(`${message || '值不相等'}：期望 ${formatValue(expected)}，实际 ${formatValue(actual)}`)
  }
}

export function assertDeepEqual(actual, expected, message = '') {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  if (a !== b) throw new AssertionError(`${message || '结构不相等'}：期望 ${b}，实际 ${a}`)
}

export function assertIncludes(haystack, needle, message = '') {
  const text = typeof haystack === 'string' ? haystack : JSON.stringify(haystack)
  if (!text.includes(needle)) {
    throw new AssertionError(`${message || '字符串未包含期望内容'}：${formatValue(text)} 不含 ${formatValue(needle)}`)
  }
}

export function assertNotIncludes(haystack, needle, message = '') {
  const text = typeof haystack === 'string' ? haystack : JSON.stringify(haystack)
  if (text.includes(needle)) {
    throw new AssertionError(`${message || '字符串不应包含'}：${formatValue(text)} 含 ${formatValue(needle)}`)
  }
}

export function assertMatch(value, pattern, message = '') {
  if (!pattern.test(String(value))) {
    throw new AssertionError(`${message || '不匹配正则'}：${formatValue(value)} 不匹配 ${pattern}`)
  }
}

export function assertType(value, type, message = '') {
  if (typeof value !== type) {
    throw new AssertionError(`${message || '类型不符'}：期望 ${type}，实际 ${typeof value}（${formatValue(value)}）`)
  }
}

/**
 * 断言 promise 会 reject，并可校验 code / 消息片段 / 错误类型。
 * @param {() => Promise<any>} fn
 * @param {{code?: string, includes?: string, name?: string, instanceOf?: Function}} [expect]
 */
export async function assertRejects(fn, expect = {}) {
  let error = null
  try {
    await fn()
  } catch (err) {
    error = err
  }
  if (!error) throw new AssertionError('期望抛出异常，但没有抛')
  if (expect.instanceOf && !(error instanceof expect.instanceOf)) {
    throw new AssertionError(`异常类型不符：期望 ${expect.instanceOf.name}，实际 ${error?.constructor?.name}（${error?.message}）`)
  }
  if (expect.name && error.name !== expect.name) {
    throw new AssertionError(`异常 name 不符：期望 ${expect.name}，实际 ${error.name}（${error.message}）`)
  }
  if (expect.code && error.code !== expect.code) {
    throw new AssertionError(`异常 code 不符：期望 ${expect.code}，实际 ${error.code}（${error.message}）`)
  }
  if (expect.includes) assertIncludes(String(error.message ?? ''), expect.includes)
  return error
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 超时保护：把 promise 包一层。 */
export function withTimeout(promise, timeoutMs, label = '操作') {
  let timer
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} 超时（${timeoutMs}ms）`)), timeoutMs)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

/** 轮询等待条件成立。 */
export async function waitFor(predicate, { timeoutMs = 5000, intervalMs = 20, label = '条件' } = {}) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await predicate()
    if (value) return value
    if (Date.now() > deadline) throw new AssertionError(`等待${label}超时（${timeoutMs}ms）`)
    await sleep(intervalMs)
  }
}

/** 收集一组测试。 */
export function createSuite(name) {
  /** @type {Array<{name: string, fn: Function, timeoutMs: number}>} */
  const tests = []
  return {
    name,
    tests,
    test(title, fn, options = {}) {
      tests.push({ name: `${name} › ${title}`, fn, timeoutMs: options.timeoutMs ?? 30000 })
    },
  }
}
