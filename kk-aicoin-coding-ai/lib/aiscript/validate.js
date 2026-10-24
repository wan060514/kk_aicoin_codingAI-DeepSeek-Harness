/**
 * Public validation API: source text in, diagnostics out.
 *
 * @module kk_aicoin_codingAI/aiscript/validate
 */
import { parse } from './parser.js'
import { analyze } from './analyze.js'
import { ruleInfo } from '../data.js'

const PARSE_FALLBACK = {
  id: 'PARSE_ERROR',
  severity: 'error',
  title: '语法错误',
  message: '脚本无法解析',
  hint: '按提示的“行:列”位置修正语法后重新校验。',
}

/**
 * Validate AiScript source.
 *
 * @param {string} source - script text.
 * @param {object} kb - knowledge base from `loadKnowledge`.
 * @param {object} [options] - `{ ignoreRules, includeInfo }`.
 * @returns {{ ok: boolean, diagnostics: Array<object>, stats: object }}
 */
export function validateScript(source, kb, options = {}) {
  const text = String(source ?? '')
  const { ast, errors, comments, tokens } = parse(text)

  const diagnostics = []

  for (const error of errors) {
    const info = kb?.rulesById?.get('PARSE_ERROR') ?? PARSE_FALLBACK
    diagnostics.push({
      ruleId: 'PARSE_ERROR',
      severity: 'error',
      title: info.title ?? PARSE_FALLBACK.title,
      message: error.message,
      hint: info.hint ?? PARSE_FALLBACK.hint,
      line: error.line,
      column: error.column,
      endLine: error.endLine ?? error.line,
      endColumn: error.endColumn ?? error.column,
    })
  }

  if (ast) {
    diagnostics.push(...analyze(ast, kb, { ...options, source: text }))
  }

  diagnostics.sort((a, b) => a.line - b.line || a.column - b.column || a.ruleId.localeCompare(b.ruleId))

  const counts = { error: 0, warning: 0, info: 0 }
  for (const d of diagnostics) counts[d.severity] = (counts[d.severity] ?? 0) + 1

  const lines = text.split(/\r?\n/).length
  const stats = {
    lines,
    tokens: tokens?.length ?? 0,
    comments: comments?.length ?? 0,
    parseErrors: errors.length,
    errors: counts.error,
    warnings: counts.warning,
    infos: counts.info,
    ok: (counts.error ?? 0) === 0,
  }

  return { ok: stats.ok, diagnostics, stats, ast }
}

/** One diagnostic as a single human line. */
export function formatDiagnostic(diagnostic, source) {
  const severity = { error: '错误', warning: '警告', info: '提示' }[diagnostic.severity] ?? diagnostic.severity
  const head = `${diagnostic.line}:${diagnostic.column}  [${severity}] ${diagnostic.ruleId}  ${diagnostic.message}`
  const parts = [head]
  if (diagnostic.hint) parts.push(`      ↳ ${diagnostic.hint}`)
  if (source) {
    const line = String(source).split(/\r?\n/)[diagnostic.line - 1]
    if (line !== undefined) {
      const trimmed = line.replace(/\t/g, '  ')
      parts.push(`      ${diagnostic.line} | ${trimmed.slice(0, 200)}`)
      const caretPad = Math.max(0, (diagnostic.column ?? 1) - 1)
      const span = Math.max(1, Math.min(20, (diagnostic.endColumn ?? diagnostic.column + 1) - diagnostic.column))
      parts.push(`      ${' '.repeat(String(diagnostic.line).length)} | ${' '.repeat(caretPad)}${'^'.repeat(span)}`)
    }
  }
  return parts.join('\n')
}

/** Render a full validation report for a tool result or a delivery file. */
export function renderReport(result, { source, title = 'AiScript 静态校验报告' } = {}) {
  const lines = [`# ${title}`, '']
  const { stats } = result
  lines.push(`- 结论：${result.ok ? '通过（无 error 级问题）' : '未通过'}`)
  lines.push(`- 统计：${stats.lines} 行 · 错误 ${stats.errors} · 警告 ${stats.warnings} · 提示 ${stats.infos}`)
  lines.push('- 说明：本报告来自离线静态分析（词法 / 语法 / 语义 / 函数库签名比对），不含任何回测或收益数据。')
  lines.push('')
  if (!result.diagnostics.length) {
    lines.push('未发现问题。')
    return lines.join('\n')
  }
  lines.push('| 行:列 | 级别 | 规则 | 说明 |')
  lines.push('| --- | --- | --- | --- |')
  for (const d of result.diagnostics) {
    lines.push(`| ${d.line}:${d.column} | ${d.severity} | ${d.ruleId} | ${String(d.message).replace(/\|/g, '\\|')} |`)
  }
  lines.push('')
  if (source) {
    lines.push('## 明细')
    lines.push('```text')
    for (const d of result.diagnostics) lines.push(formatDiagnostic(d, source))
    lines.push('```')
  }
  return lines.join('\n')
}

/** Rule catalogue lookup that tolerates a missing KB. */
export function describeRule(kb, id) {
  return kb?.rulesById?.get(id) ?? { id, severity: 'warning', title: id, message: id, hint: '' }
}

export { ruleInfo }
