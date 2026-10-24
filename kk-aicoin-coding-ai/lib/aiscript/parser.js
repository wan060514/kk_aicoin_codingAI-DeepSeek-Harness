/**
 * AiScript recursive-descent parser.
 *
 * Grammar recovered from the client's own documentation corpus (334 library
 * entries) plus a real, platform-verified strategy script. The shapes that
 * matter and are NOT obvious:
 *
 *   - a user function is declared WITHOUT the `func` keyword in every official
 *     example: `func_avg(a, b) { ... }` (the `func` word also exists and is
 *     accepted as an optional prefix);
 *   - `[dif, dea, m] = macd(...)` is tuple destructuring, not an array literal;
 *   - `ary{i}` / `pos{"long_amount"}` is the `{ }` index operator, while
 *     `for key, value = range params {` ends in a BLOCK brace - the two are
 *     disambiguated by context, not by lookahead on `{` alone;
 *   - `range` is a prefix keyword operator valid only in a `for ... = range x`.
 *
 * The parser never throws to the caller: `parse()` returns `{ ast, errors }`.
 *
 * @module kk_aicoin_codingAI/aiscript/parser
 */
import { tokenize, TOKEN, TYPE_KEYWORDS, positionAt } from './lexer.js'

/** Raised internally for a syntax error; converted into a diagnostic. */
class ParseError extends Error {
  constructor(message, token) {
    super(message)
    this.name = 'ParseError'
    this.token = token
  }
}

const ASSIGN_OPS = new Set(['=', ':=', '+=', '-=', '*=', '/=', '%=', '^='])
const POSTFIX_STOP = new Set([')', ']', '}', ',', ';'])

const BINARY_LEVELS = [
  { ops: ['or', '||'], type: 'logical' },
  { ops: ['and', '&&'], type: 'logical' },
  { ops: ['==', '!='], type: 'equality' },
  { ops: ['<', '>', '<=', '>='], type: 'relational' },
  { ops: ['+', '-'], type: 'additive' },
  { ops: ['*', '/', '%'], type: 'multiplicative' },
  { ops: ['^'], type: 'power' },
]

/**
 * Parse AiScript source into an AST.
 *
 * @param {string} source - script text.
 * @returns {{ ast: object|null, errors: Array<object>, tokens: Array<object>, comments: Array<object> }}
 */
export function parse(source) {
  const { tokens: rawTokens, comments, lineCount } = tokenize(source)
  // Drop comment tokens; keep newlines so the parser can terminate statements.
  const tokens = rawTokens.filter((t) => t.type !== TOKEN.COMMENT)

  // Mark tokens that sit inside `(`/`[` so newlines there are continuations.
  let depth = 0
  for (const token of tokens) {
    token.inGroup = depth > 0
    if (token.type === TOKEN.PUNCT && (token.value === '(' || token.value === '[')) depth += 1
    else if (token.type === TOKEN.PUNCT && (token.value === ')' || token.value === ']')) depth = Math.max(0, depth - 1)
  }

  const parser = new Parser(tokens, source, comments, lineCount)
  try {
    const ast = parser.parseProgram()
    return { ast, errors: parser.errors, tokens, comments }
  } catch (error) {
    if (error instanceof ParseError) {
      return {
        ast: null,
        errors: [
          ...parser.errors,
          {
            kind: 'PARSE_ERROR',
            message: error.message,
            line: error.token?.line ?? 1,
            column: error.token?.column ?? 1,
            endLine: error.token?.line ?? 1,
            endColumn: (error.token?.column ?? 1) + 1,
          },
        ],
        tokens,
        comments,
      }
    }
    throw error
  }
}

class Parser {
  constructor(tokens, source, comments, lineCount) {
    this.tokens = tokens
    this.source = source
    this.comments = comments
    this.lineCount = lineCount
    this.i = 0
    this.errors = []
    /** >0 while inside an expression-level `{` dict literal (newlines elided). */
    this.groupDepth = 0
    /** true while a `{` must be read as a block, never as the index operator. */
    this.noBracePostfix = 0
    this.functionDepth = 0
  }

  // ---------------------------------------------------------------- cursor

  /** Skip newlines that are pure continuations (inside `()`/`[]`/dict literals). */
  sync() {
    while (this.tokens[this.i]?.type === TOKEN.NEWLINE && (this.tokens[this.i].inGroup || this.groupDepth > 0)) {
      this.i += 1
    }
  }

  cur() {
    this.sync()
    return this.tokens[this.i] ?? this.tokens[this.tokens.length - 1]
  }

  /** Look ahead `k` non-newline tokens without consuming. */
  peekWord(k = 0) {
    let idx = this.i
    let seen = 0
    while (idx < this.tokens.length) {
      const token = this.tokens[idx]
      if (token.type === TOKEN.NEWLINE) {
        idx += 1
        continue
      }
      if (seen === k) return token
      seen += 1
      idx += 1
    }
    return this.tokens[this.tokens.length - 1]
  }

  advance() {
    const token = this.cur()
    this.i += 1
    return token
  }

  skipNewlines() {
    while (this.tokens[this.i]?.type === TOKEN.NEWLINE) this.i += 1
  }

  at(value, type) {
    const token = this.cur()
    if (!token) return false
    if (type && token.type !== type) return false
    return token.value === value
  }

  eat(value) {
    if (this.at(value)) {
      this.i += 1
      return true
    }
    return false
  }

  expect(value, what) {
    const token = this.cur()
    const matches =
      (token.type === TOKEN.PUNCT || token.type === TOKEN.OPERATOR || token.type === TOKEN.KEYWORD) &&
      token.value === value
    if (matches) {
      this.i += 1
      return token
    }
    throw new ParseError(`期望 "${value}"${what ? `（${what}）` : ''}，实际是 ${describe(token)}`, token)
  }

  locFrom(token, endToken) {
    const end = endToken ?? this.tokens[Math.max(0, this.i - 1)] ?? token
    const endPos = positionAt(this.source, end.end)
    return {
      line: token.line,
      column: token.column,
      endLine: endPos.line,
      endColumn: endPos.column,
      start: token.start,
      end: end.end,
    }
  }

  // ------------------------------------------------------------- statements

  parseProgram() {
    const start = this.cur()
    const body = []
    for (;;) {
      this.skipNewlines()
      this.eat(';')
      this.skipNewlines()
      const token = this.cur()
      if (token.type === TOKEN.EOF) break
      const statement = this.parseStatement()
      if (statement) body.push(statement)
      this.skipNewlines()
      // `left = 5, right = 5` - the platform's own examples chain declarations
      // on one line with a comma.
      while (this.eat(',')) {
        this.skipNewlines()
        const next = this.cur()
        if (next.type === TOKEN.EOF || (next.type === TOKEN.PUNCT && next.value === '}')) break
        const chained = this.parseStatement()
        if (chained) body.push(chained)
        this.skipNewlines()
      }
      this.eat(';')
    }
    return { kind: 'Program', body, loc: this.locFrom(start) }
  }

  parseBlock() {
    const open = this.expect('{', '语句块开始')
    const body = []
    for (;;) {
      this.skipNewlines()
      this.eat(';')
      this.skipNewlines()
      const token = this.cur()
      if (token.type === TOKEN.EOF) throw new ParseError('语句块没有闭合：缺少 "}"', token)
      if (token.type === TOKEN.PUNCT && token.value === '}') break
      const statement = this.parseStatement()
      if (statement) body.push(statement)
      this.skipNewlines()
      while (this.eat(',')) {
        this.skipNewlines()
        const next = this.cur()
        if (next.type === TOKEN.EOF || (next.type === TOKEN.PUNCT && next.value === '}')) break
        const chained = this.parseStatement()
        if (chained) body.push(chained)
        this.skipNewlines()
      }
      this.eat(';')
    }
    const close = this.expect('}', '语句块结束')
    return { kind: 'Block', body, loc: this.locFrom(open, close) }
  }

  parseStatement() {
    const token = this.cur()

    if (token.type === TOKEN.KEYWORD) {
      if (token.value === 'var' || token.value === 'varip') return this.parseVarDecl()
      if (token.value === 'if') return this.parseIf()
      if (token.value === 'for') return this.parseFor()
      if (token.value === 'return') return this.parseReturn()
      if (token.value === 'break') {
        this.i += 1
        return { kind: 'Break', loc: this.locFrom(token) }
      }
      if (token.value === 'func') {
        const save = this.i
        this.i += 1
        const nameToken = this.cur()
        if (nameToken.type === TOKEN.IDENT && this.peekWord(1).type === TOKEN.PUNCT && this.peekWord(1).value === '(') {
          return this.parseFuncDecl(nameToken)
        }
        this.i = save
      }
      if (TYPE_KEYWORDS.includes(token.value) && this.looksLikeTypedDecl()) return this.parseVarDecl()
    }

    if (token.type === TOKEN.PUNCT && token.value === '[') {
      const destructure = this.tryParseDestructure()
      if (destructure) return destructure
    }

    if (token.type === TOKEN.IDENT && this.looksLikeFuncDecl()) return this.parseFuncDecl(token)

    // Soft keywords (`range`, `iff`, `class`, `finally`) are lexed as identifiers
    // because the platform's own examples use them as variable/function names.
    if (token.type === TOKEN.IDENT) {
      const assignment = this.tryParseAssignment()
      if (assignment) return assignment
    }

    // Plain expression statement. Reject a bare literal: it is almost always a
    // syntax error, and silently accepting it hides real mistakes.
    const expr = this.parseExpression()
    if (expr.kind === 'Literal') {
      throw new ParseError('孤立的字面量表达式不是有效语句', token)
    }
    return { kind: 'ExprStatement', expr, loc: expr.loc }
  }

  looksLikeTypedDecl() {
    const a = this.peekWord(1)
    if (a.type === TOKEN.PUNCT && a.value === '[') {
      const b = this.peekWord(2)
      const c = this.peekWord(3)
      return b?.value === ']' && c?.type === TOKEN.IDENT
    }
    return a.type === TOKEN.IDENT
  }

  /**
   * `name(a, b) {` is a function declaration; `name(a, b)` with anything else
   * after the closing paren is a call.
   */
  looksLikeFuncDecl() {
    if (this.peekWord(0).type !== TOKEN.IDENT) return false
    if (!(this.peekWord(1).type === TOKEN.PUNCT && this.peekWord(1).value === '(')) return false
    let k = 2
    for (;;) {
      const token = this.peekWord(k)
      if (!token) return false
      if (token.type === TOKEN.PUNCT && token.value === ')') {
        const after = this.peekWord(k + 1)
        return after?.type === TOKEN.PUNCT && after.value === '{'
      }
      if (token.type === TOKEN.EOF) return false
      if (token.type === TOKEN.IDENT) {
        k += 1
        const sep = this.peekWord(k)
        if (sep?.type === TOKEN.PUNCT && sep.value === ',') {
          k += 1
          continue
        }
        continue
      }
      return false
    }
  }

  parseFuncDecl(nameToken) {
    const name = nameToken.value
    // Both call sites stop ON the name token; consume it here.
    if (this.cur().type === TOKEN.IDENT && this.cur().value === name) this.i += 1
    this.expect('(', '函数参数表')
    const params = []
    const paramTokens = []
    while (!this.at(')')) {
      const token = this.cur()
      if (token.type !== TOKEN.IDENT) throw new ParseError(`函数参数必须是标识符，实际是 ${describe(token)}`, token)
      params.push(token.value)
      paramTokens.push(token)
      this.i += 1
      if (this.eat(',')) continue
      break
    }
    this.expect(')', '函数参数表结束')
    this.functionDepth += 1
    const body = this.parseBlock()
    this.functionDepth -= 1
    return { kind: 'FuncDecl', name, params, paramTokens, body, loc: this.locFrom(nameToken), nameToken }
  }

  parseVarDecl() {
    const start = this.cur()
    const keyword = this.advance().value // var | varip
    let typeName = null
    let arrayDepth = 0
    const token = this.cur()

    if (token.type === TOKEN.KEYWORD && TYPE_KEYWORDS.includes(token.value)) {
      typeName = token.value
      this.i += 1
    } else if (token.type === TOKEN.IDENT && ['int', 'float', 'bool', 'string', 'dict', 'any'].includes(token.value)) {
      // The lexer classifies these as keywords already; this branch is a guard.
      typeName = token.value
      this.i += 1
    }
    while (this.at('[') && this.peekWord(1)?.value === ']') {
      arrayDepth += 1
      this.i += 1
      this.i += 1
    }
    const nameToken = this.cur()
    if (nameToken.type !== TOKEN.IDENT) throw new ParseError(`变量声明缺少标识符，实际是 ${describe(nameToken)}`, nameToken)
    this.i += 1
    let init = null
    if (this.cur().type === TOKEN.OPERATOR && this.cur().value === '=') {
      this.i += 1
      this.skipNewlines()
      init = this.parseExpression()
    }
    return {
      kind: 'VarDecl',
      keyword,
      typeName,
      arrayDepth,
      name: nameToken.value,
      nameToken,
      init,
      loc: this.locFrom(start),
    }
  }

  /** `[a, b, c] = expr` */
  tryParseDestructure() {
    const save = this.i
    const start = this.cur()
    const names = []
    const nameTokens = []
    try {
      this.expect('[')
      while (!this.at(']')) {
        const token = this.cur()
        if (token.type !== TOKEN.IDENT) throw new ParseError('不是解构赋值', token)
        names.push(token.value)
        nameTokens.push(token)
        this.i += 1
        if (this.eat(',')) continue
        break
      }
      this.expect(']')
    } catch {
      this.i = save
      return null
    }
    if (!this.at('=')) {
      this.i = save
      return null
    }
    // Past this point the statement is a destructuring assignment: a failure in
    // the right-hand side is a real error and must not be silently swallowed.
    this.i += 1
    this.skipNewlines()
    const init = this.parseExpression()
    return { kind: 'Destructure', names, nameTokens, init, loc: this.locFrom(start) }
  }

  /** `target = expr`, `target := expr`, `target += expr`, ... */
  tryParseAssignment() {
    const save = this.i
    const start = this.cur()
    let target
    try {
      target = this.parseLValue()
    } catch {
      this.i = save
      return null
    }
    const token = this.cur()
    if (!(token.type === TOKEN.OPERATOR && ASSIGN_OPS.has(token.value))) {
      this.i = save
      return null
    }
    // Committed: the operator was recognised, so the value is required.
    this.i += 1
    this.skipNewlines()
    const value = this.parseExpression()
    return {
      kind: 'Assign',
      op: token.value,
      target,
      value,
      loc: this.locFrom(start),
      opToken: token,
    }
  }

  /** An assignable chain: `name`, `name.a`, `name[k]`, `name{0}`. */
  parseLValue() {
    const start = this.cur()
    if (start.type !== TOKEN.IDENT) throw new ParseError('不是赋值目标', start)
    this.i += 1
    let expr = { kind: 'Identifier', name: start.value, loc: this.locFrom(start), token: start }
    for (;;) {
      const token = this.cur()
      if (token.type === TOKEN.PUNCT && token.value === '.') {
        this.i += 1
        const nameToken = this.cur()
        if (nameToken.type !== TOKEN.IDENT && nameToken.type !== TOKEN.KEYWORD) {
          throw new ParseError('成员访问缺少名称', nameToken)
        }
        this.i += 1
        expr = { kind: 'Member', object: expr, name: nameToken.value, loc: this.locFrom(start), nameToken }
        continue
      }
      if (token.type === TOKEN.PUNCT && token.value === '[') {
        this.i += 1
        const index = this.parseExpression()
        this.expect(']')
        expr = { kind: 'History', object: expr, index, loc: this.locFrom(start) }
        continue
      }
      if (token.type === TOKEN.PUNCT && token.value === '{' && this.noBracePostfix === 0) {
        this.i += 1
        const index = this.parseExpression()
        this.expect('}')
        expr = { kind: 'Index', object: expr, index, loc: this.locFrom(start) }
        continue
      }
      break
    }
    return expr
  }

  parseIf() {
    const start = this.cur()
    this.i += 1
    const branches = []
    this.expect('(', 'if 条件')
    const cond = this.parseExpression()
    this.expect(')', 'if 条件结束')
    const block = this.parseBlock()
    branches.push({ cond, block })
    let elseBlock = null
    const save = this.i
    this.skipNewlines()
    if (this.at('else')) {
      this.i += 1
      this.skipNewlines()
      if (this.at('if')) {
        const nested = this.parseIf()
        elseBlock = { kind: 'Block', body: [nested], loc: nested.loc, implicit: true }
      } else {
        elseBlock = this.parseBlock()
      }
    } else {
      this.i = save
    }
    return { kind: 'If', branches, elseBlock, loc: this.locFrom(start) }
  }

  parseFor() {
    const start = this.cur()
    this.i += 1
    // Both `for (i = 0; i < 10; i++) { }` and `for i = 0; i < 10; i++ { }`
    // appear in the client's own documentation; the parentheses are optional.
    const hasParen = this.eat('(')

    const save = this.i
    this.noBracePostfix += 1
    try {
      const init = this.parseStatement()
      if (this.at(';')) {
        this.i += 1
        const cond = this.parseExpression()
        this.expect(';', 'for 头部第二段')
        const post = this.parseStatement()
        if (hasParen) this.expect(')', 'for 头部结束')
        this.noBracePostfix -= 1
        const body = this.parseBlock()
        return { kind: 'ForC', init, cond, post, body, loc: this.locFrom(start) }
      }
      this.i = save
      this.noBracePostfix -= 1
    } catch {
      this.i = save
      this.noBracePostfix = Math.max(0, this.noBracePostfix - 1)
    }

    // for key, value = range expr { }
    let key = null
    const first = this.cur()
    if (first.type !== TOKEN.IDENT) throw new ParseError(`for 循环缺少变量名，实际是 ${describe(first)}`, first)
    this.i += 1
    let value = first.value
    if (this.eat(',')) {
      const second = this.cur()
      if (second.type !== TOKEN.IDENT) throw new ParseError('for 循环第二个变量必须是标识符', second)
      this.i += 1
      key = first.value
      value = second.value
    }
    if (!this.at('=')) throw new ParseError('for 循环缺少 "="', this.cur())
    this.i += 1
    this.noBracePostfix += 1
    const iterable = this.parseExpression()
    this.noBracePostfix -= 1
    const afterIterable = this.cur()
    if (afterIterable.type === TOKEN.IDENT && afterIterable.value === 'to') {
      throw new ParseError(
        'AiScript 不支持 "for i = 0 to N" 写法；请使用 for (初始化; 条件; 步进) 或 for 变量 = range 集合',
        afterIterable,
      )
    }
    if (hasParen) this.expect(')', 'for 头部结束')
    const body = this.parseBlock()
    return { kind: 'ForIn', key, value, iterable, body, loc: this.locFrom(start) }
  }

  parseReturn() {
    const start = this.cur()
    this.i += 1
    const next = this.cur()
    const bare =
      next.type === TOKEN.NEWLINE ||
      next.type === TOKEN.EOF ||
      (next.type === TOKEN.PUNCT && next.value === '}')
    const value = bare ? null : this.parseExpression()
    return { kind: 'Return', value, loc: this.locFrom(start) }
  }

  // ------------------------------------------------------------ expressions

  parseExpression() {
    return this.parseTernary()
  }

  parseTernary() {
    const start = this.cur()
    const cond = this.parseBinary(0)
    if (this.cur().type === TOKEN.OPERATOR && this.cur().value === '?') {
      this.i += 1
      this.skipNewlines()
      const thenExpr = this.parseTernary()
      this.skipNewlines()
      this.expect(':', '三元表达式缺少 ":"')
      this.skipNewlines()
      const elseExpr = this.parseTernary()
      return { kind: 'Ternary', cond, then: thenExpr, else: elseExpr, loc: this.locFrom(start) }
    }
    return cond
  }

  parseBinary(level) {
    if (level >= BINARY_LEVELS.length) return this.parseUnary()
    const start = this.cur()
    let left = this.parseBinary(level + 1)
    const { ops, type } = BINARY_LEVELS[level]
    for (;;) {
      const token = this.cur()
      const isOp =
        (token.type === TOKEN.OPERATOR || token.type === TOKEN.KEYWORD) && ops.includes(token.value)
      if (!isOp) break
      const op = this.advance().value
      this.skipNewlines()
      const right = this.parseBinary(level + 1)
      left = { kind: 'Binary', op, category: type, left, right, loc: this.locFrom(start), opToken: token }
    }
    return left
  }

  parseUnary() {
    const token = this.cur()
    if (token.type === TOKEN.OPERATOR && (token.value === '++' || token.value === '--')) {
      this.i += 1
      const target = this.parseUnary()
      return { kind: 'Update', op: token.value, target, prefix: true, loc: this.locFrom(token), opToken: token }
    }
    if (token.type === TOKEN.OPERATOR && (token.value === '-' || token.value === '!')) {
      this.i += 1
      const operand = this.parseUnary()
      return { kind: 'Unary', op: token.value, operand, loc: this.locFrom(token), opToken: token }
    }
    if (token.type === TOKEN.OPERATOR && token.value === 'not') {
      this.i += 1
      const operand = this.parseUnary()
      return { kind: 'Unary', op: 'not', operand, loc: this.locFrom(token), opToken: token }
    }
    if (token.type === TOKEN.OPERATOR && token.value === '+') {
      this.i += 1
      const operand = this.parseUnary()
      return { kind: 'Unary', op: '+', operand, loc: this.locFrom(token), opToken: token }
    }
    if (token.type === TOKEN.IDENT && token.value === 'range' && isExpressionStart(this.peekWord(1))) {
      this.i += 1
      const operand = this.parseUnary()
      return { kind: 'Unary', op: 'range', operand, loc: this.locFrom(token), opToken: token }
    }
    return this.parsePostfix()
  }

  parsePostfix() {
    const start = this.cur()
    let expr = this.parsePrimary()
    for (;;) {
      const token = this.cur()
      if (token.type === TOKEN.PUNCT && token.value === '(') {
        const args = this.parseArguments()
        expr = { kind: 'Call', callee: expr, args, loc: this.locFrom(start), calleeText: calleeText(expr) }
        continue
      }
      if (token.type === TOKEN.PUNCT && token.value === '[') {
        this.i += 1
        const index = this.parseExpression()
        this.expect(']', '历史引用结束')
        expr = { kind: 'History', object: expr, index, loc: this.locFrom(start) }
        continue
      }
      if (token.type === TOKEN.PUNCT && token.value === '{' && this.noBracePostfix === 0) {
        this.i += 1
        this.groupDepth += 1
        const index = this.parseExpression()
        this.groupDepth -= 1
        this.expect('}', '下标结束')
        expr = { kind: 'Index', object: expr, index, loc: this.locFrom(start) }
        continue
      }
      if (token.type === TOKEN.PUNCT && token.value === '.') {
        this.i += 1
        const nameToken = this.cur()
        if (nameToken.type !== TOKEN.IDENT && nameToken.type !== TOKEN.KEYWORD) {
          throw new ParseError('成员访问缺少名称', nameToken)
        }
        this.i += 1
        expr = { kind: 'Member', object: expr, name: nameToken.value, loc: this.locFrom(start), nameToken }
        continue
      }
      if (token.type === TOKEN.OPERATOR && (token.value === '++' || token.value === '--')) {
        this.i += 1
        expr = { kind: 'Update', op: token.value, target: expr, prefix: false, loc: this.locFrom(start), opToken: token }
        continue
      }
      break
    }
    return expr
  }

  parseArguments() {
    this.expect('(', '参数表')
    this.groupDepth += 1
    const args = []
    while (!this.at(')')) {
      const token = this.cur()
      if (token.type === TOKEN.EOF) throw new ParseError('参数表没有闭合：缺少 ")"', token)
      // Named argument: `name = value` (but not `==`).
      const next = this.peekWord(1)
      if (token.type === TOKEN.IDENT && next.type === TOKEN.OPERATOR && next.value === '=') {
        this.i += 2
        this.skipNewlines()
        const value = this.parseExpression()
        args.push({ kind: 'NamedArg', name: token.value, nameToken: token, value, loc: this.locFrom(token) })
      } else {
        const value = this.parseExpression()
        args.push(value)
      }
      if (this.eat(',')) continue
      break
    }
    this.groupDepth -= 1
    this.expect(')', '参数表结束')
    return args
  }

  parsePrimary() {
    const token = this.cur()

    if (token.type === TOKEN.NUMBER) {
      this.i += 1
      return { kind: 'Literal', literalType: 'number', value: token.numeric, raw: token.value, loc: this.locFrom(token) }
    }
    if (token.type === TOKEN.STRING) {
      this.i += 1
      return { kind: 'Literal', literalType: 'string', value: token.value, raw: token.raw, loc: this.locFrom(token) }
    }
    if (token.type === TOKEN.KEYWORD && (token.value === 'true' || token.value === 'false')) {
      this.i += 1
      return { kind: 'Literal', literalType: 'bool', value: token.value === 'true', raw: token.value, loc: this.locFrom(token) }
    }
    if (token.type === TOKEN.KEYWORD && token.value === 'nan') {
      this.i += 1
      return { kind: 'Literal', literalType: 'nan', value: Number.NaN, raw: 'nan', loc: this.locFrom(token) }
    }
    if (token.type === TOKEN.IDENT) {
      this.i += 1
      return { kind: 'Identifier', name: token.value, loc: this.locFrom(token), token }
    }
    if (token.type === TOKEN.KEYWORD && TYPE_KEYWORDS.includes(token.value)) {
      // A type name used as an expression is not valid AiScript; surface it.
      this.i += 1
      return { kind: 'Identifier', name: token.value, loc: this.locFrom(token), token, typeKeyword: true }
    }
    if (token.type === TOKEN.PUNCT && token.value === '(') {
      this.i += 1
      this.groupDepth += 1
      const expr = this.parseExpression()
      this.groupDepth -= 1
      this.expect(')', '括号表达式结束')
      return { kind: 'Paren', expr, loc: this.locFrom(token) }
    }
    if (token.type === TOKEN.PUNCT && token.value === '[') {
      this.i += 1
      this.groupDepth += 1
      const items = []
      while (!this.at(']')) {
        items.push(this.parseExpression())
        if (this.eat(',')) continue
        break
      }
      this.groupDepth -= 1
      this.expect(']', '数组字面量结束')
      return { kind: 'ArrayLiteral', items, loc: this.locFrom(token) }
    }
    if (token.type === TOKEN.PUNCT && token.value === '{') {
      this.i += 1
      this.groupDepth += 1
      const entries = []
      while (!this.at('}')) {
        const keyToken = this.cur()
        let key
        if (keyToken.type === TOKEN.STRING) key = { kind: 'string', value: keyToken.value }
        else if (keyToken.type === TOKEN.IDENT || keyToken.type === TOKEN.KEYWORD) key = { kind: 'name', value: keyToken.value }
        else throw new ParseError(`字典键必须是字符串或标识符，实际是 ${describe(keyToken)}`, keyToken)
        this.i += 1
        this.expect(':', '字典键值分隔')
        const value = this.parseExpression()
        entries.push({ key, value, keyToken })
        if (this.eat(',')) continue
        break
      }
      this.groupDepth -= 1
      this.expect('}', '字典字面量结束')
      return { kind: 'DictLiteral', entries, loc: this.locFrom(token) }
    }
    if (token.type === TOKEN.ERROR) {
      throw new ParseError(
        token.reason === 'unterminated-string' ? '字符串没有闭合' : `无法识别的字符 "${token.value}"`,
        token,
      )
    }
    const unexpected = token.type === TOKEN.PUNCT && POSTFIX_STOP.has(token.value)
    throw new ParseError(
      unexpected ? `这里不应出现 "${token.value}"` : `表达式不完整，遇到 ${describe(token)}`,
      token,
    )
  }
}

/** Human-readable representation of a callee expression (`line.new`). */
function calleeText(expr) {  if (!expr) return ''
  if (expr.kind === 'Identifier') return expr.name
  if (expr.kind === 'Member') {
    const base = calleeText(expr.object)
    return base ? `${base}.${expr.name}` : expr.name
  }
  if (expr.kind === 'Paren') return calleeText(expr.expr)
  return ''
}

/** Describe a token for an error message. */
function describe(token) {
  if (!token) return '文件结尾'
  if (token.type === TOKEN.EOF) return '文件结尾'
  if (token.type === TOKEN.NEWLINE) return '换行'
  return `"${token.value}"`
}

/** True when a token can begin an expression (used by the soft `range` operator). */
function isExpressionStart(token) {
  if (!token) return false
  if (token.type === TOKEN.NUMBER || token.type === TOKEN.STRING || token.type === TOKEN.IDENT) return true
  if (token.type === TOKEN.KEYWORD) return ['true', 'false', 'nan', 'int', 'float', 'bool', 'string', 'dict'].includes(token.value)
  if (token.type === TOKEN.PUNCT) return ['(', '[', '{'].includes(token.value)
  if (token.type === TOKEN.OPERATOR) return ['-', '!', 'not', '++', '--'].includes(token.value)
  return false
}

export { ParseError, calleeText }
