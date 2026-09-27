/**
 * Conservative, zero-dependency BlockResolver for the hashline patcher.
 *
 * Routes by file extension to language-specific sub-resolvers
 * and returns null rather than guessing for unsupported files.
 */
import type { BlockResolver, BlockSpan } from "./types"

// ---------------------------------------------------------------------------
// Bracketed languages (C-family, JSON, Go, Rust, Java, C#)
// ---------------------------------------------------------------------------

const DECLARATION_KEYWORD_RE =
  /\b(?:function|class|if|for|while|switch|struct|enum|interface|type|impl|trait|fn|namespace|public|private|protected|static|export|const|let|var|import|def|match|case|try|catch|finally|else|elif|unless)\b/

function isDeclarationLine(line: string): boolean {
  const trimmed = line.trim()
  if (/^[{\[(]\s*$/.test(trimmed)) return true
  return DECLARATION_KEYWORD_RE.test(line)
}

function bracketBlockResolver(text: string, line: number): BlockSpan | null {
  const lines = text.split("\n")
  const count = lines.length
  const a = line - 1 // 0-indexed anchor

  if (a >= count || a < 0) return null

  const anchorText = lines[a]
  const trimmed = anchorText.trim()

  // Blank line — no block to resolve
  if (trimmed.length === 0) return null

  // Anchor is itself a closer
  if (/^\s*[)\]}]/.test(anchorText)) return null

  // Walk from anchor line downward to find first opener
  let depth = 0
  let started = false

  for (let i = a; i < count; i++) {
    const source = lines[i]

    for (let j = 0; j < source.length; j++) {
      const ch = source[j]

      if (ch === "{" || ch === "[" || ch === "(") {
        if (!started) {
          // The first opener determines whether we accept this as a block
          if (i === a) {
            // Opener on anchor line — always accept
            started = true
          } else if (i <= a + 3 && isDeclarationLine(source)) {
            // Opener within 3 lines below, line is declaration-ish
            started = true
          } else {
            // Opener too far or not from a declaration — anchor is a single statement
            return null
          }
        }
        depth++
      } else if (ch === "}" || ch === "]" || ch === ")") {
        if (started) {
          depth--
          if (depth === 0) {
            // Stack returned to 0 — block ends on this line
            const endLine = i + 1
            // Collapse single-line blocks: opener+closer on same line with nothing between
            if (endLine === line) return null
            return { start: line, end: endLine }
          }
        }
      }
    }
  }

  // Unbalanced — never guess
  return null
}

// ---------------------------------------------------------------------------
// Indentation-based languages (Python, YAML)
// ---------------------------------------------------------------------------

function indentLevel(line: string): number {
  return line.length - line.trimStart().length
}

function indentBlockResolver(text: string, line: number): BlockSpan | null {
  const lines = text.split("\n")
  const a = line - 1

  if (a >= lines.length || a < 0) return null
  if (lines[a].trim().length === 0) return null

  const anchorIndent = indentLevel(lines[a])
  let last = a

  for (let i = a + 1; i < lines.length; i++) {
    if (lines[i].trim().length === 0) continue
    if (indentLevel(lines[i]) <= anchorIndent) break
    last = i
  }

  if (last === a) return null
  return { start: line, end: last + 1 }
}

// ---------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------

const FENCE_RE = /^(```+|~~~+)/

function markdownBlockResolver(text: string, line: number): BlockSpan | null {
  const lines = text.split("\n")
  const a = line - 1

  if (a >= lines.length || a < 0) return null

  const anchorText = lines[a].trim()

  // Heading block
  const headingMatch = /^(#+)\s/.exec(anchorText)
  if (headingMatch) {
    const level = headingMatch[1].length
    for (let i = a + 1; i < lines.length; i++) {
      const m = /^(#+)\s/.exec(lines[i].trim())
      if (m && m[1].length <= level) {
        // Block ends on the line before this heading
        return { start: line, end: i }
      }
    }
    return { start: line, end: lines.length }
  }

  // Fenced code block
  const fenceMatch = FENCE_RE.exec(anchorText)
  if (fenceMatch) {
    const fence = fenceMatch[1]
    for (let i = a + 1; i < lines.length; i++) {
      const trimmed = lines[i].trim()
      const close = FENCE_RE.exec(trimmed)
      if (close && close[1] === fence) {
        return { start: line, end: i + 1 }
      }
    }
    return null // unclosed fence — return null
  }

  return null
}

// ---------------------------------------------------------------------------
// Extension routing
// ---------------------------------------------------------------------------

const BRACKET_EXTS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".json",
  ".jsonc",
  ".go",
  ".rs",
  ".java",
  ".cs",
  ".cpp",
  ".c",
])

const INDENT_EXTS = new Set([".py", ".yaml", ".yml"])

const MD_EXTS = new Set([".md", ".mdx"])

function extOf(path: string): string {
  const lower = path.toLowerCase()
  const dot = lower.lastIndexOf(".")
  return dot === -1 ? "" : lower.slice(dot)
}

// ---------------------------------------------------------------------------
// Public factory
// ---------------------------------------------------------------------------

export function createBlockResolver(): BlockResolver {
  return (req): BlockSpan | null => {
    const ext = extOf(req.path)
    if (BRACKET_EXTS.has(ext)) return bracketBlockResolver(req.text, req.line)
    if (INDENT_EXTS.has(ext)) return indentBlockResolver(req.text, req.line)
    if (MD_EXTS.has(ext)) return markdownBlockResolver(req.text, req.line)
    return null
  }
}
