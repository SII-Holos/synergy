// Convert LaTeX-style delimiters to Markdown-style for KaTeX compatibility.
// Display math \[...\]: block ($$...$$) when standalone on a line, inline ($...$) when embedded.
// Inline math \(...\): always $...$
// Handles both single-escaped (\[, \() and double-escaped (\\[, \\() forms.
export function convertLatexDelimiters(text: string): string {
  text = text.replace(/\\\\\[([\s\S]*?)\\\\\]/g, displayMathReplacer)
  text = text.replace(/\\\[([\s\S]*?)\\\]/g, displayMathReplacer)

  text = text.replace(/\\\\\(([\s\S]*?)\\\\\)/g, (_, content) => `$${content}$`)
  text = text.replace(/\\\(([\s\S]*?)\\\)/g, (_, content) => `$${content}$`)

  return escapeTableMathPipes(text)
}

function escapeTableMathPipes(text: string): string {
  const lines = text.split("\n")
  let inTable = false

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const trimmed = line.trim()

    if (trimmed.startsWith("|") && trimmed.endsWith("|")) {
      inTable = true
    } else if (inTable && !trimmed.startsWith("|")) {
      inTable = false
    }

    if (!inTable || !line.includes("$")) continue

    lines[i] = line.replace(/\$\$([^$]*)\$\$|\$([^$]*)\$/g, (match, block, inline) => {
      const content = block ?? inline
      if (!content.includes("|")) return match
      const escaped = content.replaceAll("|", "\\vert ")
      return block !== undefined ? `$$${escaped}$$` : `$${escaped}$`
    })
  }

  return lines.join("\n")
}

function displayMathReplacer(match: string, content: string, offset: number, source: string): string {
  if (content.includes("\n") || isOnOwnLine(source, offset, match.length)) {
    return `$$\n${content.trim()}\n$$`
  }
  return `$${content}$`
}

function isOnOwnLine(text: string, offset: number, length: number): boolean {
  const lineStart = text.lastIndexOf("\n", offset - 1) + 1
  const lineEnd = text.indexOf("\n", offset + length)
  const prefix = text.slice(lineStart, offset)
  const suffix = text.slice(offset + length, lineEnd === -1 ? text.length : lineEnd)
  return prefix.trim() === "" && suffix.trim() === ""
}
