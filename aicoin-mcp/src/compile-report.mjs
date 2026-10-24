/**
 * compile-report.mjs — 把 `upgrade/customIndicator/script/save` 的返回体翻译成「编译结论」。
 *
 * 为什么需要这一层：AiCoin 客户端**没有本地 AiScript 编译器**，真正的编译发生在服务端
 * 保存时，结果塞在 `data.compileResult` 里（2.16.27 客户端 bundle 静态确认的字段）：
 *
 *   { id, errLine, errColumn, err, pass, hasAlert, hasTrade, securityCount,
 *     warnMessage: [{ line, column, message }], updateAt }
 *
 * 失败时同一份 `compileResult` 也会带回来（客户端就是靠它把「第 N 行第 M 列: …」打到
 * 编辑器状态栏的），所以「保存 → 读编译结论 → 回填到源码行」可以一次调用闭环。
 *
 * 这个模块刻意不碰 CDP：纯函数，单测直接喂响应体即可。
 *
 * @module aicoin-mcp/compile-report
 */

/** 保存接口里见过的业务 status（客户端 bundle 里用十六进制字面量判断，这里换成十进制）。 */
export const SAVE_STATUS_HINTS = {
  40013: '服务端拒绝了这次保存（客户端会弹限制提示），通常与脚本数量/权限额度有关。',
  40014: '多数据源（security/跨周期）数量超过当前账号上限：减少 security() 调用，或升级 VIP。',
  40016: '该功能需要 VIP（客户端会弹 vipList 弹窗）。',
  10023: '该功能需要 VIP（客户端会弹 vipList 弹窗）。',
  62006: '编译需要 CHART_PRO 权益（data.compileResult.proData 是可用套餐列表）。',
}

/** 把可能是字符串/数字的字段读成数字，读不到给 null。 */
function asInt(value) {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

/** 取第 line 行原文（1 基），越界返回 null。 */
export function sourceLineOf(source, line) {
  if (typeof source !== 'string' || !line || line < 1) return null
  const lines = source.split(/\r?\n/)
  return line <= lines.length ? lines[line - 1] : null
}

/** 给源码行做一个插入符号提示，长度按列号对齐（列号也是 1 基）。 */
export function caretOf(lineText, column) {
  const col = asInt(column)
  if (!lineText || !col || col < 1) return null
  const pad = lineText.slice(0, col - 1).replace(/[^\t]/g, ' ')
  return `${pad}^`
}

/**
 * 归一化编译结论。
 *
 * @param {string} source AiScript 源码（用来回填出错行原文）
 * @param {object} response `saveIndicator` 的返回：`{ ok, httpStatus, success, status, message, data }`
 * @returns {object} 结构化结论；`pass` 为 `true/false/null`（null＝服务端没给编译结果）
 */
export function buildCompileReport(source, response = {}) {
  const body = response && typeof response === 'object' ? response : {}
  const data = body.data && typeof body.data === 'object' ? body.data : null
  const compile = (data && data.compileResult && typeof data.compileResult === 'object' && data.compileResult) || null

  const status = asInt(body.status)
  const httpStatus = asInt(body.httpStatus)
  const message = typeof body.message === 'string' && body.message ? body.message : null

  if (!compile) {
    // 保存失败但不是编译错误（配额/权限/网络），或者成功了但服务端没回 compileResult。
    const passed = body.ok === true || body.success === true
    return {
      pass: passed ? null : false,
      verified: false,
      err: passed ? null : message ?? '保存失败，但服务端没有返回编译结果',
      errLine: null,
      errColumn: null,
      sourceLine: null,
      caret: null,
      warnings: [],
      hasAlert: null,
      hasTrade: null,
      securityCount: null,
      status,
      httpStatus,
      message,
      hint: status !== null ? SAVE_STATUS_HINTS[status] ?? null : null,
      note: passed
        ? '保存接口返回成功，但没有 compileResult —— 无法确认编译通过（可能是旧版客户端或接口字段变化）'
        : '没有拿到 compileResult：这是接口层失败，不是脚本编译失败',
    }
  }

  const pass = compile.pass === true
  const errLine = asInt(compile.errLine)
  const errColumn = asInt(compile.errColumn)
  const err = typeof compile.err === 'string' && compile.err.trim() ? compile.err.trim() : pass ? null : '编译未通过（服务端未给出错误文本）'
  const warnings = Array.isArray(compile.warnMessage)
    ? compile.warnMessage
        .filter((item) => item && (item.message || item.line))
        .map((item) => ({
          line: asInt(item.line),
          column: asInt(item.column),
          message: String(item.message ?? '').trim(),
        }))
        .filter((item) => item.message && item.message !== '')
    : []
  const sourceLine = pass ? null : sourceLineOf(source, errLine)

  return {
    pass,
    verified: true,
    err,
    errLine,
    errColumn,
    sourceLine,
    caret: pass ? null : caretOf(sourceLine, errColumn),
    warnings,
    hasAlert: compile.hasAlert === undefined ? null : compile.hasAlert === true,
    hasTrade: compile.hasTrade === undefined ? null : compile.hasTrade === true,
    securityCount: asInt(compile.securityCount),
    status,
    httpStatus,
    message,
    hint: status !== null && !pass ? SAVE_STATUS_HINTS[status] ?? null : null,
    note: null,
  }
}

/** 把结论压成人类可读的一行（给工具返回值里的 `summary` 用）。 */
export function summarizeCompileReport(report) {
  if (!report || typeof report !== 'object') return '无编译结论'
  if (report.pass === true) {
    const bits = ['编译通过']
    if (report.securityCount !== null) bits.push(`${report.securityCount} 个数据源`)
    if (report.warnings.length > 0) bits.push(`${report.warnings.length} 条警告`)
    return bits.join('，')
  }
  if (report.pass === false) {
    const where = report.errLine ? `第 ${report.errLine} 行${report.errColumn ? `第 ${report.errColumn} 列` : ''}` : '位置未知'
    return `${where}: ${report.err ?? '编译失败'}`
  }
  return report.note ?? '没有编译结论'
}

export default { SAVE_STATUS_HINTS, buildCompileReport, summarizeCompileReport, sourceLineOf, caretOf }
