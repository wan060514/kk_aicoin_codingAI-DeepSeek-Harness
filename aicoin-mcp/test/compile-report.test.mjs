// `script/save` 返回体 → 编译结论 的纯函数测试（不联网、不碰 CDP）。
import assert from 'node:assert/strict'

import { buildCompileReport, summarizeCompileReport, sourceLineOf, caretOf } from '../src/compile-report.mjs'

const src = ['// @version=2', 'x = 1', 'var int t0 = time'].join('\n')

export const tests = [
  {
    name: 'compile-report › 编译失败时回填出错行原文与插入符',
    run() {
      const fail = buildCompileReport(src, {
        ok: false,
        httpStatus: 200,
        success: false,
        status: 0,
        message: '第 3 行第 10 列: cannot use float as type int in assignment',
        data: {
          compileResult: {
            errLine: 3,
            errColumn: 10,
            err: 'cannot use float as type int in assignment',
            pass: false,
            securityCount: '1',
            warnMessage: [],
          },
        },
      })
      assert.equal(fail.pass, false)
      assert.equal(fail.verified, true)
      assert.equal(fail.errLine, 3)
      assert.equal(fail.errColumn, 10)
      assert.equal(fail.sourceLine, 'var int t0 = time')
      assert.equal(fail.caret, '         ^')
      assert.equal(fail.securityCount, 1)
      assert.match(summarizeCompileReport(fail), /第 3 行第 10 列/)
    },
  },
  {
    name: 'compile-report › 通过时带警告/告警/交易标记，空消息被过滤',
    run() {
      const ok = buildCompileReport(src, {
        ok: true,
        data: {
          compileResult: {
            pass: true,
            securityCount: '2',
            hasAlert: false,
            hasTrade: true,
            warnMessage: [
              { line: '2', column: '0', message: '' },
              { line: '3', column: '5', message: '建议加 nz()' },
            ],
          },
        },
      })
      assert.equal(ok.pass, true)
      assert.equal(ok.err, null)
      assert.equal(ok.sourceLine, null)
      assert.equal(ok.hasTrade, true)
      assert.equal(ok.hasAlert, false)
      assert.equal(ok.warnings.length, 1)
      assert.equal(ok.warnings[0].line, 3)
      assert.match(summarizeCompileReport(ok), /编译通过.*2 个数据源.*1 条警告/)
    },
  },
  {
    name: 'compile-report › 接口层失败（无 compileResult）不会被误报成编译错误',
    run() {
      const apiFail = buildCompileReport(src, { ok: false, httpStatus: 200, status: 40014, message: '安全限制', data: null })
      assert.equal(apiFail.pass, false)
      assert.equal(apiFail.verified, false)
      assert.match(apiFail.hint, /多数据源/)
      assert.match(apiFail.note, /不是脚本编译失败/)
    },
  },
  {
    name: 'compile-report › 保存成功但没有 compileResult → pass 为 null 且提示无法确认',
    run() {
      const blind = buildCompileReport(src, { ok: true, status: 0, data: {} })
      assert.equal(blind.pass, null)
      assert.equal(blind.verified, false)
      assert.match(blind.note, /没有 compileResult/)
      assert.equal(summarizeCompileReport(blind), blind.note)
    },
  },
  {
    name: 'compile-report › 行号越界/tab 列对齐/脏入参都不抛异常',
    run() {
      assert.equal(sourceLineOf(src, 99), null)
      assert.equal(sourceLineOf(src, 1), '// @version=2')
      assert.equal(sourceLineOf(null, 1), null)
      assert.equal(caretOf(null, 3), null)
      assert.equal(caretOf('abc', null), null)
      assert.equal(caretOf('\tx', 2), ' ^')
      assert.equal(buildCompileReport(src, null).pass, null)
      assert.equal(buildCompileReport(src, {}).verified, false)
    },
  },
]

export default { tests }
