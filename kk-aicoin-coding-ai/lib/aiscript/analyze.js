/**
 * AiScript semantic analyzer.
 *
 * Walks the AST produced by `parser.js` and reports rule violations drawn from
 * `data/aiscript_rules.json`. Every rule traces back to a documented fact: the
 * client's own function library, its language definition, or the "已知坑" list
 * in the extraction README. Nothing here guesses at runtime behaviour, and
 * nothing here produces performance numbers.
 *
 * Severity policy: a check only becomes an `error` when the platform's own
 * documentation states the construct is a compile error (wrong named-argument
 * case, repeated exclusive trade declarations, root-scope-only calls, unknown
 * function). Anything inferred is at most a `warning`.
 *
 * @module kk_aicoin_codingAI/aiscript/analyze
 */
import { ruleInfo } from '../data.js'

/** Fallback severities so analysis still works without the rule catalogue. */
const FALLBACK_SEVERITY = {
  UNKNOWN_FUNCTION: 'error',
  UNKNOWN_VARIABLE: 'error',
  ARITY_TOO_FEW: 'error',
  ARITY_TOO_MANY: 'error',
  UNKNOWN_NAMED_ARG: 'error',
  DUPLICATE_NAMED_ARG: 'error',
  NAMED_ARG_CASE: 'error',
  SINGLE_DECLARATION: 'error',
  ROOT_SCOPE_REQUIRED: 'error',
  DUPLICATE_TRADE_ID: 'error',
  MISSING_UNIQUE_ID: 'error',
  NAN_COMPARISON: 'error',
  SUSPICIOUS_DIVISION: 'error',
  CONFIG_ONCE: 'error',
  FOR_LOOP_LIMIT: 'error',
  HISTORY_LOOKBACK_LIMIT: 'error',
  INDEX_LENGTH_LIMIT: 'error',
  TIME_IS_FLOAT: 'error',
  DISPLAY_NON_CONSTANT: 'warning',
  INDEX_ON_NON_COLLECTION: 'warning',
  CONFIG_NOT_AT_TOP: 'warning',
  ASSIGN_IN_BLOCK_SHADOWS: 'warning',
  TYPE_HINT_MISMATCH: 'warning',
  TERNARY_TYPE_MISMATCH: 'warning',
  REQUIRE_CONDITION_FIRST_ARG: 'warning',
  NO_PLOT_OUTPUT: 'warning',
  NO_TRADE_SIGNAL: 'warning',
  UNUSED_VARIABLE: 'info',
  MISSING_VERSION_DIRECTIVE: 'info',
  TRAILING_SEMICOLON_OK: 'info',
  NO_POSITION_STATE: 'error',
  REPEATED_TRADE_RISK: 'error',
  STATE_NEVER_RESET: 'warning',
  EXIT_WITHOUT_ENTRY_RECORD: 'warning',
  NO_ENTRY_BAR_RECORD: 'info',
  PARSE_ERROR: 'error',
}

/** Calls that put marks on the chart. */
const PLOT_CALLS = new Set([
  'plot', 'plotColumn', 'plotText', 'plotShape', 'plotHist', 'plotCandle', 'plotOhlc',
  'fill', 'label.new', 'line.new', 'box.new',
])

/** Calls that enter/exit a position. */
const TRADE_CALLS = new Set([
  'enterLong', 'exitLong', 'enterShort', 'exitShort',
  'enterLongAmount', 'exitLongAmount', 'enterShortAmount', 'exitShortAmount',
  'enterLongPercent', 'exitLongPercent', 'enterShortPercent', 'exitShortPercent',
])

/** Calls that may appear at most once, at the very top of the script. */
const CONFIG_CALLS = new Set(['indicator', 'tradeConfig'])

/** Series-valued identifiers: `{}` on these is the classic confusion. */
const SERIES_BUILTINS = new Set([
  'open', 'high', 'low', 'close', 'volume', 'amount', 'time', 'timenow', 'timestart',
  'timeclose', 'timeend', 'hl2', 'hlc3', 'ohlc4', 'bar_index',
])

const HISTORY_LIMIT = 500
const INDEX_LIMIT = 1000
const LOOP_LIMIT = 500

/** Functions whose value is true only on the bar a transition happens. */
const EDGE_FUNCTIONS = new Set(['crossup', 'crossdown', 'cross', 'rising', 'falling', 'pivotlow', 'pivothigh'])

/** Dotted path of a Member chain: `strategy.position` -> "strategy.position". */
function memberPathOf(node) {
  if (!node) return ''
  if (node.kind === 'Identifier') return node.name
  if (node.kind === 'Member') {
    const base = memberPathOf(node.object)
    return base ? `${base}.${node.name}` : node.name
  }
  return ''
}

/** Visits every AST node (including nodes nested in arrays and branch objects). */
function visitAll(root, fn) {
  const stack = [root]
  while (stack.length) {
    const node = stack.pop()
    if (!node || typeof node !== 'object') continue
    if (Array.isArray(node)) {
      for (const item of node) stack.push(item)
      continue
    }
    if (typeof node.kind === 'string') fn(node)
    for (const key of Object.keys(node)) {
      if (key === 'loc' || key === 'token' || key === 'opToken' || key === 'nameToken' || key === 'paramTokens' || key === 'nameTokens') continue
      const value = node[key]
      if (value && typeof value === 'object') stack.push(value)
    }
  }
}

class Scope {
  constructor(parent, kind) {
    this.parent = parent
    this.kind = kind
    this.names = new Map()
  }

  declare(name, info) {
    this.names.set(name, info)
  }

  lookup(name) {
    let scope = this
    while (scope) {
      if (scope.names.has(name)) return { scope, info: scope.names.get(name) }
      scope = scope.parent
    }
    return null
  }

  get isRoot() {
    return this.parent === null
  }
}

/**
 * Analyze a parsed AiScript program.
 *
 * @param {object} ast - AST from {@link parse}.
 * @param {object} kb - knowledge base from `loadKnowledge`.
 * @param {object} [options] - `{ source, ignoreRules, includeInfo }`.
 * @returns {Array<object>} findings sorted by position.
 */
export function analyze(ast, kb, options = {}) {
  const findings = []
  const ignore = new Set(options.ignoreRules ?? [])

  const report = (ruleId, loc, extra = {}) => {
    if (ignore.has(ruleId)) return
    const info = ruleInfo(kb, ruleId)
    const severity = extra.severity ?? info.severity ?? FALLBACK_SEVERITY[ruleId] ?? 'warning'
    findings.push({
      ruleId,
      severity,
      title: info.title ?? ruleId,
      message: extra.message ?? info.message ?? ruleId,
      hint: extra.hint ?? info.hint ?? '',
      line: loc?.line ?? 1,
      column: loc?.column ?? 1,
      endLine: loc?.endLine ?? loc?.line ?? 1,
      endColumn: loc?.endColumn ?? loc?.column ?? 1,
      ...(extra.data === undefined ? {} : { data: extra.data }),
    })
  }

  if (!ast) return findings

  // ------------------------------------------------------------- pass 1
  // Collect every declared name first, so a reference that only resolves later
  // (or that we cannot place precisely) never becomes a false UNKNOWN_VARIABLE.
  const declaredAnywhere = new Set(kb.builtinVars)
  const userFunctions = new Map()
  const declarations = []
  /** Identifier -> its defining expression, for transitive condition analysis. */
  const definitions = new Map()
  /** Names declared with `var` / `varip`: the only cross-bar storage there is. */
  const varNames = new Set()
  /** Names written with `:=` or a compound assignment, i.e. state that changes. */
  const assignedNames = new Set()
  /** name -> the set of boolean literals it is ever assigned. */
  const boolAssignments = new Map()

  const noteBoolAssignment = (name, value) => {
    if (value?.kind !== 'Literal' || value.literalType !== 'bool') return
    const set = boolAssignments.get(name) ?? new Set()
    set.add(value.value ? 'true' : 'false')
    boolAssignments.set(name, set)
  }

  const collectPattern = (node) => {
    if (!node) return
    switch (node.kind) {
      case 'Program':
      case 'Block':
        for (const statement of node.body ?? []) collectPattern(statement)
        return
      case 'FuncDecl':
        userFunctions.set(node.name, node)
        declaredAnywhere.add(node.name)
        for (const param of node.params) declaredAnywhere.add(param)
        collectPattern(node.body)
        return
      case 'VarDecl':
        declaredAnywhere.add(node.name)
        declarations.push({ name: node.name, node, kind: node.keyword ?? 'plain' })
        if (node.init) definitions.set(node.name, node.init)
        if (node.keyword === 'var' || node.keyword === 'varip') {
          varNames.add(node.name)
          // Deliberately NOT counted as a boolean assignment: `var x = false` is
          // the initial value, not a reset. Only `:=` writes count, so that
          // "set to true and never set back to false" is actually detectable.
        }
        collectPattern(node.init)
        return
      case 'Destructure':
        for (const name of node.names) {
          declaredAnywhere.add(name)
          declarations.push({ name, node, kind: 'destructure' })
        }
        collectPattern(node.init)
        return
      case 'Assign':
        if (node.target?.kind === 'Identifier') {
          const target = node.target.name
          if (!declaredAnywhere.has(target)) {
            declaredAnywhere.add(target)
            declarations.push({ name: target, node, kind: 'assign' })
          }
          definitions.set(target, node.value)
          if (node.op !== '=') {
            assignedNames.add(target)
            noteBoolAssignment(target, node.value)
          }
        }
        collectPattern(node.value)
        return
      case 'ForC':
        collectPattern(node.init)
        collectPattern(node.cond)
        collectPattern(node.post)
        collectPattern(node.body)
        return
      case 'ForIn':
        declaredAnywhere.add(node.value)
        if (node.key) declaredAnywhere.add(node.key)
        declarations.push({ name: node.value, node, kind: 'loop' })
        if (node.key) declarations.push({ name: node.key, node, kind: 'loop' })
        collectPattern(node.iterable)
        collectPattern(node.body)
        return
      case 'If':
        for (const branch of node.branches) {
          collectPattern(branch.cond)
          collectPattern(branch.block)
        }
        collectPattern(node.elseBlock)
        return
      default:
        return
    }
  }
  collectPattern(ast)

  // ------------------------------------------------------------- pass 2
  const reads = new Set()
  const tradeCallCount = new Map()
  const tradeIds = new Map()
  let plots = 0
  let tradeSignals = 0
  let hasAnyTradeCall = false
  let sawTradeConfig = false
  const configCalls = []

  const markRead = (name) => reads.add(name)

  const resolveName = (name) => declaredAnywhere.has(name)

  const isBooleanish = (node) => {
    if (!node) return true
    if (node.kind === 'Literal') return node.literalType === 'bool'
    if (node.kind === 'Binary') {
      return ['equality', 'relational', 'logical'].includes(node.category)
    }
    if (node.kind === 'Unary') return isBooleanish(node.operand)
    if (node.kind === 'Ternary') return isBooleanish(node.then) && isBooleanish(node.else)
    if (node.kind === 'Paren') return isBooleanish(node.expr)
    if (node.kind === 'Identifier') return SERIES_BUILTINS.has(node.name) ? false : true
    if (node.kind === 'Call') return true
    if (node.kind === 'History') return false
    if (node.kind === 'Index' || node.kind === 'Member') return false
    if (node.kind === 'Update') return false
    // Array literals, dict literals and numbers are definitely not conditions.
    if (node.kind === 'ArrayLiteral' || node.kind === 'DictLiteral') return false
    return true
  }

  const literalKind = (node) => {
    if (!node) return 'unknown'
    if (node.kind === 'Literal') return node.literalType
    if (node.kind === 'Paren') return literalKind(node.expr)
    return 'unknown'
  }

  const arrayValued = new Set()
  for (const statement of ast.body ?? []) {
    if (statement.kind === 'VarDecl' && statement.init && isArrayProducing(statement.init)) {
      arrayValued.add(statement.name)
    }
    if (statement.kind === 'Assign' && statement.target?.kind === 'Identifier' && statement.value && isArrayProducing(statement.value)) {
      arrayValued.add(statement.target.name)
    }
  }

  // ---------------------------------------------------------------- walker
  const rootScope = new Scope(null, 'root')
  for (const name of declaredAnywhere) if (kb.builtinVars.has(name)) rootScope.declare(name, { builtin: true })

  const walkProgram = (node) => {
    for (const statement of node.body ?? []) walkStatement(statement, rootScope)
  }

  const walkBlock = (block, scope) => {
    if (!block) return
    const inner = new Scope(scope, 'block')
    for (const statement of block.body ?? []) walkStatement(statement, inner)
  }

  const atRootScope = (scope) => scope.kind === 'root'

  const walkStatement = (node, scope) => {
    if (!node) return
    switch (node.kind) {
      case 'Program':
        walkProgram(node)
        return
      case 'Block':
        walkBlock(node, scope)
        return
      case 'FuncDecl': {
        const fnScope = new Scope(scope, 'function')
        for (const param of node.params) fnScope.declare(param, { param: true })
        walkBlockInline(node.body, fnScope)
        return
      }
      case 'VarDecl':
        checkTimeTypeDecl(node)
        scope.declare(node.name, { node })
        walkExpr(node.init, scope)
        return
      case 'Destructure':
        for (const name of node.names) scope.declare(name, { node })
        walkExpr(node.init, scope)
        return
      case 'Assign': {
        if (node.target?.kind === 'Identifier') {
          const name = node.target.name
          if (node.op === '=') {
            const existing = scope.lookup(name)
            if (existing && existing.scope !== scope && !scope.isRoot) {
              report('ASSIGN_IN_BLOCK_SHADOWS', node.loc, {
                message: `在块内用 "=" 给外层变量 ${name} 赋值会新建局部变量，外层值不会改变；要修改外层变量必须用 ":="`,
                data: { name, op: node.op },
              })
            }
            scope.declare(name, { node, declared: true })
          } else {
            const existing = scope.lookup(name)
            if (!existing && !resolveName(name)) {
              report('UNKNOWN_VARIABLE', node.target.loc ?? node.loc, {
                message: `":=" 的赋值目标 ${name} 从未声明；第一次赋值请用 "="`,
                data: { name },
              })
            }
          }
        } else {
          walkExpr(node.target, scope)
        }
        walkExpr(node.value, scope)
        return
      }
      case 'If': {
        for (const branch of node.branches) {
          walkExpr(branch.cond, scope)
          walkBlock(branch.block, scope)
        }
        if (node.elseBlock) walkBlock(node.elseBlock, scope)
        return
      }
      case 'ForC': {
        const loopScope = new Scope(scope, 'block')
        walkStatement(node.init, loopScope)
        walkExpr(node.cond, loopScope)
        walkStatement(node.post, loopScope)
        checkLoopLimit(node, loopScope)
        walkBlock(node.body, loopScope)
        return
      }
      case 'ForIn': {
        const loopScope = new Scope(scope, 'block')
        loopScope.declare(node.value, { node })
        if (node.key) loopScope.declare(node.key, { node })
        walkExpr(node.iterable, loopScope)
        walkBlock(node.body, loopScope)
        return
      }
      case 'Return':
        walkExpr(node.value, scope)
        return
      case 'Break':
        return
      case 'ExprStatement':
        walkExpr(node.expr, scope)
        return
      default:
        return
    }
  }

  /** Walk a function body in the given scope without adding a second block. */
  const walkBlockInline = (block, scope) => {
    for (const statement of block?.body ?? []) walkStatement(statement, scope)
  }

  const walkExpr = (node, scope) => {
    if (!node) return
    switch (node.kind) {
      case 'Literal':
        return
      case 'Paren':
        walkExpr(node.expr, scope)
        return
      case 'Identifier': {
        const name = node.name
        if (node.typeKeyword) return
        if (kb.namespaces.has(name) || SERIES_BUILTINS.has(name) || resolveName(name)) {
          markRead(name)
          return
        }
        // Library entries count as defined: `circulatingsupply` is a zero-argument
        // entry used bare by the platform's own example.
        const libraryEntry = kb.byName?.get(name)
        if (libraryEntry) {
          markRead(name)
          if (/\(/.test(String(libraryEntry.signature ?? ''))) {
            report('UNKNOWN_VARIABLE', node.loc, {
              severity: 'info',
              message: `"${name}" 是函数库里的函数（签名 ${libraryEntry.signature}），这里被当作变量使用；如果要取值请确认客户端是否支持省略括号`,
              data: { name },
            })
          }
          return
        }
        report('UNKNOWN_VARIABLE', node.loc, {
          message: `未定义的标识符 "${name}"：既不是内置变量、函数库条目，也没有在本脚本中声明`,
          data: { name },
        })
        return
      }
      case 'Unary':
      case 'Update':
        walkExpr(node.operand ?? node.target, scope)
        return
      case 'Binary': {
        walkExpr(node.left, scope)
        walkExpr(node.right, scope)
        checkBinary(node)
        return
      }
      case 'Ternary': {
        walkExpr(node.cond, scope)
        walkExpr(node.then, scope)
        walkExpr(node.else, scope)
        const a = literalKind(node.then)
        const b = literalKind(node.else)
        if (a !== 'unknown' && b !== 'unknown' && a !== b && !(isNumeric(a) && isNumeric(b))) {
          report('TERNARY_TYPE_MISMATCH', node.loc, {
            message: `三元表达式两侧类型不同（${a} / ${b}），客户端可能拒绝或产生意外结果`,
            data: { then: a, else: b },
          })
        }
        return
      }
      case 'ArrayLiteral':
        for (const item of node.items ?? []) walkExpr(item, scope)
        return
      case 'DictLiteral':
        for (const entry of node.entries ?? []) walkExpr(entry.value, scope)
        return
      case 'Member': {
        if (node.object?.kind === 'Identifier' && kb.namespaces.has(node.object.name)) {
          markRead(node.object.name)
          return
        }
        walkExpr(node.object, scope)
        return
      }
      case 'History': {
        walkExpr(node.object, scope)
        walkExpr(node.index, scope)
        checkHistory(node, scope)
        return
      }
      case 'Index': {
        walkExpr(node.object, scope)
        walkExpr(node.index, scope)
        checkIndex(node)
        return
      }
      case 'Call':
        checkCall(node, scope)
        return
      default:
        return
    }
  }

  // ------------------------------------------------------------- call rules

  const checkCall = (node, scope) => {
    const text = node.calleeText || ''
    const userFn = userFunctions.get(text)
    const entry = kb.byCall.get(text)

    // Argument expressions always get walked, whatever the callee resolves to.
    for (const arg of node.args ?? []) {
      walkExpr(arg.kind === 'NamedArg' ? arg.value : arg, scope)
    }

    if (userFn) {
      checkUserFunctionArity(node, text, userFn)
      return
    }

    if (!entry) {
      if (text.includes('.')) {
        const base = text.split('.')[0]
        if (kb.namespaces.has(base)) {
          report('UNKNOWN_FUNCTION', node.loc, {
            severity: 'warning',
            message: `命名空间 "${base}" 里没有记录 "${text}"：函数库中没有该条目，请确认客户端版本`,
            data: { name: text, namespace: base },
          })
          return
        }
      }
      report('UNKNOWN_FUNCTION', node.loc, {
        message: `函数库中没有函数 "${text}"；请用 aicoin_library_search 核对名称拼写`,
        data: { name: text },
      })
      return
    }

    checkNamedArguments(node, entry)
    if (!entry.arityUnknown) checkArity(node, entry)

    if (PLOT_CALLS.has(entry.callName)) plots += 1
    if (TRADE_CALLS.has(entry.callName)) {
      tradeSignals += 1
      hasAnyTradeCall = true
      const count = (tradeCallCount.get(entry.callName) ?? 0) + 1
      tradeCallCount.set(entry.callName, count)

      // The single most valuable check in this file: a trade condition that is
      // neither edge-triggered nor position-state-guarded fires on EVERY bar the
      // condition holds, which is exactly how a "compiles fine" script ends up
      // opening and closing over and over.
      const condArg = (node.args ?? []).find((a) => a.kind !== 'NamedArg')
      if (condArg) {
        const facts = scanFacts(condArg)
        if (!facts.edge && !facts.state) {
          report('REPEATED_TRADE_RISK', condArg.loc ?? node.loc, {
            message:
              `${entry.callName} 的触发条件既不是边沿信号（crossup / crossdown / rising / falling），` +
              '也没有引用任何仓位状态变量 → 条件成立的每一根 K 线都会重复下单',
            hint: '改成「边沿信号 + 状态保护」，例如 crossup(fast, slow) and not in_long，并在平仓分支里把状态复位。',
            data: { name: entry.callName },
          })
        }
      }
      if (entry.flags.singleDeclaration && count > 1) {
        report('SINGLE_DECLARATION', node.loc, {
          message: `${entry.callName} 在脚本中出现了 ${count} 次；官方文档明确说每种指令最多声明一次，重复声明会产生编译错误`,
          hint: '改用带唯一 id 的 *Amount / *Percent 系列函数来多次下单。',
          data: { name: entry.callName, count },
        })
      }
      const idArg = (node.args ?? []).find((a) => a.kind === 'NamedArg' && a.name === 'id')
      if (entry.flags.requiresUniqueId) {
        if (!idArg) {
          report('MISSING_UNIQUE_ID', node.loc, {
            message: `${entry.callName} 需要唯一的 id 参数，否则无法在脚本内多次使用`,
            data: { name: entry.callName },
          })
        } else if (idArg.value?.kind === 'Literal' && idArg.value.literalType === 'string') {
          const value = idArg.value.value
          const previous = tradeIds.get(value)
          if (previous) {
            report('DUPLICATE_TRADE_ID', idArg.value.loc, {
              message: `交易指令 id "${value}" 重复使用（另见第 ${previous} 行）；id 必须唯一`,
              data: { id: value, firstLine: previous },
            })
          } else {
            tradeIds.set(value, idArg.value.loc?.line ?? 0)
          }
        }
      }
      if (!atRootScope(scope)) {
        report('ROOT_SCOPE_REQUIRED', node.loc, {
          message: `${entry.callName} 必须在根作用域调用，不能放在 if / for / 自定义函数内部`,
          data: { name: entry.callName },
        })
      }
    }

    if (entry.flags.rootScopeOnly && !atRootScope(scope)) {
      report('ROOT_SCOPE_REQUIRED', node.loc, {
        message: `${entry.callName} 必须在根作用域调用，不能放在 if / for / 自定义函数内部`,
        data: { name: entry.callName },
      })
    }

    if (CONFIG_CALLS.has(entry.callName)) {
      configCalls.push(node)
      if (entry.callName === 'tradeConfig') sawTradeConfig = true
    }

    if (entry.flags.conditionFirstParam) {
      const first = (node.args ?? []).find((a) => a.kind !== 'NamedArg')
      if (first && !isBooleanish(first)) {
        report('REQUIRE_CONDITION_FIRST_ARG', first.loc ?? node.loc, {
          message: `${entry.callName} 的第一个参数必须是布尔条件，这里看起来是数值/序列`,
          data: { name: entry.callName },
        })
      }
    }
  }

  const checkUserFunctionArity = (node, name, fnNode) => {
    const positional = (node.args ?? []).filter((a) => a.kind !== 'NamedArg')
    if (positional.length > fnNode.params.length) {
      report('ARITY_TOO_MANY', node.loc, {
        message: `自定义函数 ${name} 只接受 ${fnNode.params.length} 个参数，这里传了 ${positional.length} 个`,
        data: { name, expected: fnNode.params.length, actual: positional.length },
      })
    } else if (positional.length < fnNode.params.length) {
      report('ARITY_TOO_FEW', node.loc, {
        message: `自定义函数 ${name} 需要 ${fnNode.params.length} 个参数（${fnNode.params.join(', ')}），这里只传了 ${positional.length} 个`,
        data: { name, expected: fnNode.params.length, actual: positional.length },
      })
    }
  }

  /**
   * 收集表达式里引用到的标识符名（只看 Identifier，不追成员访问）。
   * 用于判断 `var int t0 = time` 这类「声明类型与初值类型冲突」。
   */
  const collectIdentifierNames = (node, out = new Set()) => {
    if (!node || typeof node !== 'object') return out
    if (Array.isArray(node)) {
      for (const item of node) collectIdentifierNames(item, out)
      return out
    }
    if (node.kind === 'Identifier') out.add(node.name)
    for (const key of Object.keys(node)) {
      if (key === 'loc' || key === 'nameToken') continue
      const value = node[key]
      if (value && typeof value === 'object') collectIdentifierNames(value, out)
    }
    return out
  }

  /** 客户端里 time 一系都是 float：写 `var int x = time` 会被服务端编译器拒绝。 */
  const FLOAT_TIME_NAMES = new Set(['time', 'timeclose', 'timenow', 'timestart', 'timeend'])

  const checkTimeTypeDecl = (node) => {
    if (node?.typeName !== 'int' || !node.init) return
    const names = collectIdentifierNames(node.init)
    const hit = [...FLOAT_TIME_NAMES].find((name) => names.has(name))
    if (!hit) return
    report('TIME_IS_FLOAT', node.loc, {
      message:
        `\`var int ${node.name} = ${hit}\` 会编译失败：客户端里 ${hit} 是浮点（float），`
        + '服务端返回 "cannot use float as type int in assignment"',
      hint: `改成 \`var float ${node.name} = ${hit}\`，或直接 \`var ${node.name} = ${hit}\` 让类型自动推导`,
      data: { name: node.name, source: hit },
    })
  }

  /**
   * `display` 只认字面量布尔。
   *
   * 2026-10-24 真机二分探针确认：传序列（`barstate.islast`、`a and b`）编译不报错，
   * 但整组绘图一个都不渲染（静默当 false）。静态校验器以前完全发现不了这个问题。
   */
  const checkDisplayConstant = (node, entry, arg) => {
    if (arg.name !== 'display') return
    const value = arg.value
    if (value?.kind === 'Literal' && value.literalType === 'bool') return
    report('DISPLAY_NON_CONSTANT', arg.loc ?? node.loc, {
      message:
        `${entry.callName} 的 display 只认字面量 true/false；传序列在客户端不报错，`
        + '但整组绘图会一个都不显示',
      hint:
        '要「只画最新一根」请用几何门控：非最新根让线的 x1 == x2（零长度不可见），'
        + '标签用空文本 + 透明底色；不要靠 display',
      data: { call: entry.callName },
    })
  }

  const checkNamedArguments = (node, entry) => {
    const params = new Map(entry.params.map((p) => [p.name, p]))
    const lower = new Map(entry.params.map((p) => [p.name.toLowerCase(), p.name]))
    const seen = new Set()
    for (const arg of node.args ?? []) {
      if (arg.kind !== 'NamedArg') continue
      const name = arg.name
      if (params.has(name)) {
        checkDisplayConstant(node, entry, arg)
        if (seen.has(name)) {
          report('DUPLICATE_NAMED_ARG', arg.loc, {
            message: `命名参数 "${name}" 重复传入`,
            data: { name },
          })
        }
        seen.add(name)
        continue
      }
      const canonical = lower.get(name.toLowerCase())
      if (canonical) {
        report('NAMED_ARG_CASE', arg.loc, {
          severity: 'error',
          message: `命名参数大小写错误："${name}" 应为 "${canonical}"；命名参数大小写敏感，写错会直接编译失败`,
          hint: `改成 ${canonical}=...`,
          data: { name, canonical },
        })
        continue
      }
      report('UNKNOWN_NAMED_ARG', arg.loc, {
        severity: 'warning',
        message: `${entry.callName} 没有名为 "${name}" 的参数`,
        hint: entry.params.length ? `可用参数：${entry.params.map((p) => p.name).join(', ')}` : '',
        data: { name, call: entry.callName },
      })
    }
  }

  const checkArity = (node, entry) => {
    const groups = entry.argGroups ?? []
    if (groups.length === 0) return
    const positional = (node.args ?? []).filter((a) => a.kind !== 'NamedArg')
    const namedNames = new Set((node.args ?? []).filter((a) => a.kind === 'NamedArg').map((a) => a.name))

    if (positional.length > groups.length) {
      report('ARITY_TOO_MANY', node.loc, {
        message: `${entry.callName} 最多接受 ${groups.length} 个参数，这里传了 ${positional.length} 个`,
        data: { name: entry.callName, expected: groups.length, actual: positional.length },
      })
      return
    }

    const missing = []
    for (let i = 0; i < groups.length; i += 1) {
      const group = groups[i]
      if (i < positional.length) continue
      if (group.names.some((n) => namedNames.has(n))) continue
      if (!group.required) continue
      missing.push(group.label)
    }
    if (missing.length) {
      report('ARITY_TOO_FEW', node.loc, {
        severity: 'warning',
        message: `${entry.callName} 的可能必要参数未传入：${missing.join(' / ')}`,
        hint:
          `签名：${entry.signature}。` +
          '该条目的官方参数表把这几项标为「必要参数」，但函数库自己的示例里也有省略它们的写法，' +
          '所以这里只作提醒：如果客户端接受就忽略，如果报错就按签名补齐。',
        data: { name: entry.callName, missing },
      })
    }
  }

  // ---------------------------------------------------------- other checks

  const checkBinary = (node) => {
    const op = node.op
    if (op === '==' || op === '!=') {
      if (isNanLiteral(node.left) || isNanLiteral(node.right)) {
        report('NAN_COMPARISON', node.loc, {
          message: `nan 不能用 ${op} 比较（nan == nan 恒为 false）；请使用 na(...) 判断`,
          data: { op },
        })
      }
    }
    if (op === '/' || op === '%') {
      if (node.right?.kind === 'Literal' && node.right.literalType === 'number' && node.right.value === 0) {
        report('SUSPICIOUS_DIVISION', node.right.loc ?? node.loc, {
          message: `除数为字面量 0（${op} 0），运行时会产生 nan 或无穷大`,
          data: { op },
        })
      }
    }
  }

  const checkHistory = (node, scope) => {
    if (node.index?.kind === 'Literal' && node.index.literalType === 'number') {
      const value = node.index.value
      if (value >= HISTORY_LIMIT) {
        report('HISTORY_LOOKBACK_LIMIT', node.index.loc ?? node.loc, {
          message: `历史引用 [${value}] 超过上限：[] 最多只能回溯最近 ${HISTORY_LIMIT} 个数据点`,
          data: { value, limit: HISTORY_LIMIT },
        })
      }
      if (value < 0) {
        report('HISTORY_LOOKBACK_LIMIT', node.index.loc ?? node.loc, {
          severity: 'warning',
          message: `历史引用下标为负数 [${value}]，官方文档只定义了 [0] 与正整数回溯`,
          data: { value },
        })
      }
    }
    // `array[i]` - arrays use `{}`, series use `[]`.
    if (node.object?.kind === 'Identifier' && arrayValued.has(node.object.name)) {
      report('INDEX_ON_NON_COLLECTION', node.loc, {
        severity: 'warning',
        message: `"${node.object.name}" 看起来是数组，数组下标应使用 {}（如 ${node.object.name}{0}），[] 是 K 线历史引用`,
        data: { name: node.object.name },
      })
    }
  }

  const checkIndex = (node) => {
    if (node.index?.kind === 'Literal' && node.index.literalType === 'number') {
      const value = node.index.value
      if (value >= INDEX_LIMIT) {
        report('INDEX_LENGTH_LIMIT', node.index.loc ?? node.loc, {
          message: `数组/字典下标 {${value}} 超过上限：最大长度 ${INDEX_LIMIT}，下标从 0 开始`,
          data: { value, limit: INDEX_LIMIT },
        })
      } else if (value < 0) {
        report('INDEX_LENGTH_LIMIT', node.index.loc ?? node.loc, {
          severity: 'warning',
          message: `数组下标为负数 {${value}}，官方文档下标从 0 开始`,
          data: { value },
        })
      }
    }
    const object = node.object
    if (object?.kind === 'Literal' && !(object.literalType === 'string')) {
      report('INDEX_ON_NON_COLLECTION', node.loc, {
        message: `对字面量使用下标 {} 运算符没有意义`,
        data: {},
      })
      return
    }
    if (object?.kind === 'Identifier' && SERIES_BUILTINS.has(object.name)) {
      report('INDEX_ON_NON_COLLECTION', node.loc, {
        severity: 'warning',
        message: `"${object.name}" 是序列数据，取历史值请用 []（如 ${object.name}[1]），{} 是数组/字典下标`,
        data: { name: object.name },
      })
    }
  }

  const checkLoopLimit = (node) => {
    const cond = node.cond
    if (!cond || cond.kind !== 'Binary' || !['relational', 'equality'].includes(cond.category)) return
    const literal = numericLiteral(cond.right) ?? numericLiteral(cond.left)
    if (literal === null) return
    const step = loopStep(node.post)
    const iterations = step > 0 ? Math.ceil(literal / step) : literal
    if (iterations > LOOP_LIMIT) {
      report('FOR_LOOP_LIMIT', cond.loc ?? node.loc, {
        message: `for 循环上界约 ${literal}（步长 ${step}）超过单次 ${LOOP_LIMIT} 次的上限，客户端会直接报错`,
        hint: `把循环次数压到 ${LOOP_LIMIT} 以内，或改用数组/序列函数批量计算。`,
        data: { upper: literal, step, iterations, limit: LOOP_LIMIT },
      })
    }
  }

  // ------------------------------------------------- position-state analysis
  /**
   * Names holding cross-bar position state: declared with `var`/`varip` AND
   * written with `:=`. A plain `var k = 2` constant is not position state.
   */
  const stateNames = new Set([...varNames].filter((name) => assignedNames.has(name)))

  let usesStrategyPosition = false
  visitAll(ast, (n) => {
    if (n.kind === 'Member' && memberPathOf(n).startsWith('strategy.')) usesStrategyPosition = true
  })

  /**
   * Does this expression respond to edges (`crossup`) or to recorded position
   * state? Identifiers are expanded to their defining expression, so
   * `enterLong(sig)` where `sig = crossup(a, b)` counts as edge-triggered, and
   * `exitLong(exit_all)` where `exit_all` mentions `in_long` counts as guarded.
   */
  const scanFacts = (root) => {
    const acc = { edge: false, state: false, strategyPosition: false, names: new Set() }
    const seen = new Set()
    const walk = (node) => {
      if (!node || typeof node !== 'object') return
      if (Array.isArray(node)) {
        for (const item of node) walk(item)
        return
      }
      if (typeof node.kind !== 'string') {
        for (const key of Object.keys(node)) {
          if (key === 'loc') continue
          walk(node[key])
        }
        return
      }
      switch (node.kind) {
        case 'Identifier': {
          if (stateNames.has(node.name)) {
            acc.state = true
            acc.names.add(node.name)
            return
          }
          if (seen.has(node.name)) return
          seen.add(node.name)
          const definition = definitions.get(node.name)
          if (definition) walk(definition)
          return
        }
        case 'Member': {
          const path = memberPathOf(node)
          if (path.startsWith('strategy.')) {
            acc.state = true
            acc.strategyPosition = true
          }
          if (path === 'barstate.isnew') acc.edge = true
          walk(node.object)
          return
        }
        case 'Call': {
          if (EDGE_FUNCTIONS.has(node.calleeText)) acc.edge = true
          for (const arg of node.args ?? []) walk(arg.kind === 'NamedArg' ? arg.value : arg)
          return
        }
        default: {
          for (const key of Object.keys(node)) {
            if (key === 'loc' || key === 'token' || key === 'opToken' || key === 'nameToken') continue
            walk(node[key])
          }
          return
        }
      }
    }
    walk(root)
    return acc
  }

  // ---------------------------------------------------------------- driver
  walkProgram(ast)

  // config placement / duplication. Each config CALL may appear once: `indicator`
  // once AND `tradeConfig` once is correct, `indicator` twice is not.
  const configByName = new Map()
  for (const call of configCalls) {
    const list = configByName.get(call.calleeText) ?? []
    list.push(call)
    configByName.set(call.calleeText, list)
  }
  for (const [callee, calls] of configByName) {
    if (calls.length < 2) continue
    const first = calls[0]
    for (const call of calls.slice(1)) {
      report('CONFIG_ONCE', call.loc, {
        message: `${callee} 只能调用一次（第 ${first.loc?.line ?? '?'} 行已经调用过）`,
        data: { name: callee },
      })
    }
  }
  // Only `indicator()` documents a hard "must be at the top of the script" rule.
  const topLevel = ast.body ?? []
  for (let i = 0; i < topLevel.length; i += 1) {
    const statement = topLevel[i]
    if (statement.kind !== 'ExprStatement') continue
    const call = statement.expr
    if (call?.kind !== 'Call' || call.calleeText !== 'indicator') continue
    if (i > 0) {
      report('CONFIG_NOT_AT_TOP', call.loc, {
        severity: 'warning',
        message: 'indicator 应该放在脚本最顶部，这里前面还有 ' + i + ' 条语句',
        data: { name: call.calleeText },
      })
    }
  }

  // ------------------------------------------------- position state machine
  if (hasAnyTradeCall) {
    const declNode = new Map(declarations.map((d) => [d.name, d.node]))
    const declaredNames = new Set(declarations.map((d) => d.name))
    const head = { line: 1, column: 1, endLine: 1, endColumn: 1 }

    if (stateNames.size === 0 && !usesStrategyPosition) {
      report('NO_POSITION_STATE', head, {
        message:
          '脚本有交易指令，但没有任何跨 K 线保持的仓位状态变量（var / varip），也没有读取 strategy.position：' +
          '脚本无从知道自己是否已经持仓',
        hint:
          '至少声明一个状态变量，例如 var in_long = false；开仓分支里 in_long := true，平仓分支里 in_long := false，' +
          '再让下单条件引用它。',
        data: {},
      })
    }

    for (const name of stateNames) {
      const assigned = boolAssignments.get(name)
      if (assigned && assigned.has('true') && !assigned.has('false')) {
        report('STATE_NEVER_RESET', declNode.get(name)?.loc ?? head, {
          message: `状态变量 ${name} 只被置为 true，脚本里从未被置回 false`,
          hint: `状态机必须能回到空仓：在平仓分支里写 ${name} := false，否则平仓之后它仍然认为自己持仓，永远不会再开仓。`,
          data: { name },
        })
      }
    }

    // Fixed-percentage stops need a recorded entry price to mean anything.
    const hasEntryPriceVar = [...declaredNames].some((name) => /(entry|avg|cost|hold)/i.test(name))
    let percentStopNode = null
    visitAll(ast, (n) => {
      if (percentStopNode) return
      if (n.kind !== 'Binary' || !['relational', 'equality'].includes(n.category)) return
      for (const side of [n.left, n.right]) {
        if (side?.kind !== 'Binary' || (side.op !== '*' && side.op !== '/')) continue
        const parts = [side.left, side.right]
        const hasPrice = parts.some((x) => x?.kind === 'Identifier' && SERIES_BUILTINS.has(x.name))
        const hasNumber = parts.some((x) => x?.kind === 'Literal' && x.literalType === 'number')
        if (hasPrice && hasNumber) percentStopNode = n
      }
    })
    if (percentStopNode && !usesStrategyPosition && !hasEntryPriceVar) {
      report('EXIT_WITHOUT_ENTRY_RECORD', percentStopNode.loc ?? head, {
        message:
          '出场条件按百分比或价格比例计算（例如 close * 0.98），但脚本既没有读取 strategy.position 的持仓均价，' +
          '也没有用变量记录入场价',
        hint: '开仓分支里记 entry_price := close（或读 strategy.position 的 long_price / short_price），止损止盈都基于这个记录值计算。',
        data: {},
      })
    }

    const hasEntryBarVar = [...declaredNames].some((name) => /(entry|open|last|signal|trade)_?(bar|index|time)/i.test(name))
    if (stateNames.size > 0 && !hasEntryBarVar) {
      report('NO_ENTRY_BAR_RECORD', head, {
        severity: 'info',
        message: '脚本记录了仓位状态，但没有记录开仓发生在哪一根 K 线，因此无法实现时间止损、最长持仓或平仓后冷却',
        hint: '开仓分支里记 entry_bar := bar_index，之后可用 bar_index - entry_bar >= N 做时间止损或冷却。',
        data: {},
      })
    }
  }

  // type hints
  const checkTypeHints = (node) => {
    if (node.kind === 'VarDecl') {
      const init = node.init
      if (init?.kind === 'Literal') {
        if (node.typeName === 'int' && init.literalType === 'number' && !Number.isInteger(init.value)) {
          report('TYPE_HINT_MISMATCH', node.loc, {
            message: `声明为 int 却赋值了非整数 ${init.raw ?? init.value}`,
            data: { type: node.typeName, literal: init.literalType },
          })
        }
        if (node.typeName === 'string' && init.literalType !== 'string') {
          report('TYPE_HINT_MISMATCH', node.loc, {
            message: `声明为 string 却赋值了 ${init.literalType}`,
            data: { type: node.typeName, literal: init.literalType },
          })
        }
        if (node.typeName === 'bool' && init.literalType !== 'bool' && init.literalType !== 'nan') {
          report('TYPE_HINT_MISMATCH', node.loc, {
            message: `声明为 bool 却赋值了 ${init.literalType}`,
            data: { type: node.typeName, literal: init.literalType },
          })
        }
      }
    }
    for (const child of childrenOf(node)) checkTypeHints(child)
  }
  checkTypeHints(ast)

  // unused variables
  for (const declaration of declarations) {
    if (!declaration.name) continue
    if (declaration.name.startsWith('_')) continue
    if (kb.builtinVars.has(declaration.name)) continue
    if (reads.has(declaration.name)) continue
    if (userFunctions.has(declaration.name)) continue
    report('UNUSED_VARIABLE', declaration.node.loc, {
      severity: 'info',
      message: `变量 "${declaration.name}" 声明后从未被使用`,
      data: { name: declaration.name },
    })
  }

  // output / signal sanity
  if (plots === 0) {
    report('NO_PLOT_OUTPUT', { line: 1, column: 1, endLine: 1, endColumn: 1 }, {
      severity: 'info',
      message: '脚本没有任何 plot / plotText / plotShape / line.new / label.new 等输出调用，指标在图表上不会显示任何内容',
      data: { plots },
    })
  }
  if (sawTradeConfig && tradeSignals === 0) {
    report('NO_TRADE_SIGNAL', { line: 1, column: 1, endLine: 1, endColumn: 1 }, {
      severity: 'info',
      message: '脚本调用了 tradeConfig 但没有调用任何 enter/exit 交易函数，策略不会产生任何信号',
      data: { tradeSignals },
    })
  }

  // version directive
  const source = String(options.source ?? '')
  if (source && !/@version\s*=/.test(source)) {
    report('MISSING_VERSION_DIRECTIVE', { line: 1, column: 1, endLine: 1, endColumn: 1 }, {
      severity: 'info',
      message: '建议在脚本首行写 // @version=2，函数库多数条目标注「语法版本需要 // @version=2」',
      data: {},
    })
  }
  if (source && /;\s*$/m.test(source)) {
    report('TRAILING_SEMICOLON_OK', { line: 1, column: 1, endLine: 1, endColumn: 1 }, {
      severity: 'info',
      message: '行尾分号是允许的：编辑器补全插入的 snippet 自带分号，客户端接受分号与换行两种语句结束方式',
      data: {},
    })
  }

  return findings
    .filter((f) => options.includeInfo !== false || f.severity !== 'info')
    .sort((a, b) => a.line - b.line || a.column - b.column || a.ruleId.localeCompare(b.ruleId))
}

/** Structural children of an AST node, for generic recursive passes. */
function childrenOf(node) {
  if (!node || typeof node !== 'object') return []
  const out = []
  for (const key of Object.keys(node)) {
    if (key === 'loc' || key === 'token' || key === 'nameToken' || key === 'opToken' || key === 'paramTokens' || key === 'nameTokens') continue
    const value = node[key]
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item && typeof item === 'object' && typeof item.kind === 'string') out.push(item)
        else if (item && typeof item === 'object') {
          if (item.cond && item.block) {
            out.push(item.cond, item.block)
          }
        }
      }
      continue
    }
    if (value && typeof value === 'object' && typeof value.kind === 'string') out.push(value)
  }
  return out
}

function isNanLiteral(node) {
  if (!node) return false
  if (node.kind === 'Literal' && node.literalType === 'nan') return true
  if (node.kind === 'Identifier' && node.name === 'nan') return true
  return false
}

function isNumeric(kind) {
  return kind === 'number' || kind === 'nan'
}

function numericLiteral(node) {
  if (node?.kind === 'Literal' && node.literalType === 'number') return node.value
  return null
}

function loopStep(post) {
  if (!post) return 1
  if (post.kind === 'ExprStatement' && post.expr?.kind === 'Update') return 1
  if (post.kind === 'Update') return 1
  if (post.kind === 'Assign' && post.op === '+=') {
    const value = numericLiteral(post.value)
    if (value !== null && value > 0) return value
  }
  return 1
}

/** True when an initializer clearly produces a collection. */
function isArrayProducing(node) {
  if (!node) return false
  if (node.kind === 'ArrayLiteral' || node.kind === 'DictLiteral') return true
  if (node.kind === 'Paren') return isArrayProducing(node.expr)
  if (node.kind === 'Call') {
    const text = node.calleeText ?? ''
    return /^array_|^matrix_|^string_(split|join)$|^request$/.test(text)
  }
  return false
}
