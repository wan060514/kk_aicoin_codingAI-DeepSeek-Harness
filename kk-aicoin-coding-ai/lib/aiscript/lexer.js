/**
 * AiScript lexer.
 *
 * The token rules mirror the client's own Monaco/Monarch definition extracted
 * from AiCoin `dist/renderer/2776.js` (webpack module 0xf21f) - see
 * `research/editor-tokenizer.md`. Keeping the local lexer congruent with the
 * editor's tokenizer is what lets us claim "validated against the editor's own
 * language definition" instead of a hand-waved approximation.
 *
 * The lexer NEVER throws: it emits an `error` token and keeps going, so the
 * validator can always report a line/column instead of losing the whole file.
 *
 * @module kk_aicoin_codingAI/aiscript/lexer
 */

/**
 * The full keyword list exactly as the client's language definition declares it
 * (`HL` in webpack module 0xf21f). Exported for the language-reference tool.
 */
export const DECLARED_KEYWORDS = Object.freeze([
  'and', 'any', 'bool', 'break', 'class', 'dict', 'else', 'false', 'finally',
  'float', 'for', 'if', 'iff', 'int', 'nan', 'not', 'or', 'range', 'return',
  'string', 'true', 'var', 'varip',
])

/**
 * Subset the PARSER treats as reserved. The remainder of the declared list is
 * lexed as an identifier on purpose: the platform's own examples use `range`
 * as a variable name (`range = array_range(arr)`) and `iff` as a plain function
 * call, so reserving them would reject documentation-correct scripts.
 */
const RESERVED = new Set([
  'if', 'else', 'for', 'return', 'break', 'var', 'varip',
  'true', 'false', 'nan',
  'int', 'float', 'bool', 'string', 'dict', 'any',
])

/** Declared in the language definition but with no library documentation. */
export const RESERVED_NO_DOC = Object.freeze(['class', 'finally', 'any'])

/** Type keywords usable in a declaration: `int[] arr = [...]`. */
export const TYPE_KEYWORDS = Object.freeze(['int', 'float', 'bool', 'string', 'dict', 'any'])

/** Kept for callers that only need the declared keyword list. */
export const KEYWORDS = DECLARED_KEYWORDS

/**
 * `iff` is declared as a keyword but used as a callable function in the library
 * (`iff(condition, expr1, expr2)`), so it is lexed as an identifier.
 */
const OPERATOR_WORDS = new Set(['and', 'or', 'not'])

/** Multi-character operators, longest first so `:=` wins over `:`. */
const OPERATORS = Object.freeze([
  '<=', '>=', '==', '!=', '++', '--', '&&', '||',
  '+=', '-=', '*=', '/=', '%=', '^=', ':=',
  '+', '-', '*', '/', '%', '^', '!', '?', ':', '=', '<', '>',
])

/** Characters that stand alone as punctuation. */
const PUNCT = Object.freeze(['(', ')', '[', ']', '{', '}', ',', ';', '.'])

const ID_START = /[A-Za-z_\u4E00-\u9FAF$]/
const ID_PART = /[0-9A-Za-z_\u4E00-\u9FAF$]/

/** Token kinds produced by {@link tokenize}. */
export const TOKEN = Object.freeze({
  NUMBER: 'number',
  STRING: 'string',
  IDENT: 'identifier',
  KEYWORD: 'keyword',
  OPERATOR: 'operator',
  PUNCT: 'punct',
  COMMENT: 'comment',
  NEWLINE: 'newline',
  ERROR: 'error',
  EOF: 'eof',
})

/** Compute a 1-based line/column pair from a byte offset. */
function positionAt(source, offset) {
  let line = 1
  let lineStart = 0
  for (let i = 0; i < offset && i < source.length; i += 1) {
    if (source[i] === '\n') {
      line += 1
      lineStart = i + 1
    }
  }
  return { line, column: offset - lineStart + 1 }
}

/**
 * Split AiScript source into tokens.
 *
 * @param {string} source - script text.
 * @returns {{ tokens: Array<object>, comments: Array<object>, lineCount: number }}
 */
export function tokenize(source) {
  const text = String(source ?? '').replace(/\r\n?/g, '\n')
  const tokens = []
  const comments = []
  let i = 0
  let line = 1
  let lineStart = 0

  const push = (type, value, start, end, extra) => {
    tokens.push({
      type,
      value,
      start,
      end,
      line,
      column: start - lineStart + 1,
      ...(extra ?? {}),
    })
  }

  const advanceLines = (from, to) => {
    for (let k = from; k < to; k += 1) {
      if (text[k] === '\n') {
        line += 1
        lineStart = k + 1
      }
    }
  }

  while (i < text.length) {
    const ch = text[i]

    // ---- newline (statement terminator, kept as a token) ----
    if (ch === '\n') {
      push(TOKEN.NEWLINE, '\n', i, i + 1)
      i += 1
      line += 1
      lineStart = i
      continue
    }

    // ---- whitespace ----
    if (ch === ' ' || ch === '\t') {
      i += 1
      continue
    }

    // ---- comments ----
    if (ch === '/' && text[i + 1] === '/') {
      const start = i
      while (i < text.length && text[i] !== '\n') i += 1
      const value = text.slice(start, i)
      comments.push({ value, start, end: i, line, column: start - lineStart + 1, block: false })
      push(TOKEN.COMMENT, value, start, i, { block: false })
      continue
    }
    if (ch === '/' && text[i + 1] === '*') {
      const start = i
      i += 2
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i += 1
      i = Math.min(text.length, i + 2)
      const value = text.slice(start, i)
      const startLine = line
      const startColumn = start - lineStart + 1
      comments.push({ value, start, end: i, line: startLine, column: startColumn, block: true })
      advanceLines(start, i)
      tokens.push({ type: TOKEN.COMMENT, value, start, end: i, line: startLine, column: startColumn, block: true })
      continue
    }

    // ---- numbers ----
    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(text[i + 1] ?? ''))) {
      const start = i
      while (i < text.length && /[0-9]/.test(text[i])) i += 1
      if (text[i] === '.' && /[0-9]/.test(text[i + 1] ?? '')) {
        i += 1
        while (i < text.length && /[0-9]/.test(text[i])) i += 1
      } else if (text[i] === '.' && !/[A-Za-z_]/.test(text[i + 1] ?? '')) {
        // `1.` is a valid float literal
        i += 1
      }
      if (text[i] === 'e' || text[i] === 'E') {
        const save = i
        let k = i + 1
        if (text[k] === '+' || text[k] === '-') k += 1
        if (/[0-9]/.test(text[k] ?? '')) {
          k += 1
          while (k < text.length && /[0-9]/.test(text[k])) k += 1
          i = k
        } else {
          i = save
        }
      }
      const raw = text.slice(start, i)
      push(TOKEN.NUMBER, raw, start, i, { numeric: Number(raw) })
      continue
    }

    // ---- strings ('...', "...", `...`) ----
    if (ch === "'" || ch === '"' || ch === '`') {
      const start = i
      const quote = ch
      i += 1
      let closed = false
      let out = ''
      while (i < text.length) {
        const c = text[i]
        if (c === '\\') {
          out += text[i + 1] ?? ''
          i += 2
          continue
        }
        if (c === quote) {
          closed = true
          i += 1
          break
        }
        if (c === '\n') break
        out += c
        i += 1
      }
      const startLine = line
      const startColumn = start - lineStart + 1
      advanceLines(start, i)
      tokens.push({
        type: closed ? TOKEN.STRING : TOKEN.ERROR,
        value: closed ? out : text.slice(start, i),
        raw: text.slice(start, i),
        start,
        end: i,
        line: startLine,
        column: startColumn,
        ...(closed ? {} : { reason: 'unterminated-string' }),
      })
      continue
    }

    // ---- identifiers / keyword-operators ----
    if (ID_START.test(ch)) {
      const start = i
      i += 1
      while (i < text.length && ID_PART.test(text[i])) i += 1
      const word = text.slice(start, i)
      if (OPERATOR_WORDS.has(word)) push(TOKEN.OPERATOR, word, start, i)
      else if (RESERVED.has(word)) push(TOKEN.KEYWORD, word, start, i)
      else push(TOKEN.IDENT, word, start, i)
      continue
    }

    // ---- operators (longest match first) ----
    let matched = false
    for (const op of OPERATORS) {
      if (text.startsWith(op, i)) {
        push(TOKEN.OPERATOR, op, i, i + op.length)
        i += op.length
        matched = true
        break
      }
    }
    if (matched) continue

    // ---- punctuation ----
    if (PUNCT.includes(ch)) {
      push(TOKEN.PUNCT, ch, i, i + 1)
      i += 1
      continue
    }

    // ---- anything else is an error token, but we keep scanning ----
    push(TOKEN.ERROR, ch, i, i + 1, { reason: 'unexpected-character' })
    i += 1
  }

  push(TOKEN.EOF, '', text.length, text.length)
  return { tokens, comments, lineCount: line }
}

/** Re-export so callers do not need both modules for a position lookup. */
export { positionAt }
