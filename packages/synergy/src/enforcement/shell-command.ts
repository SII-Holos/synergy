/**
 * Shell command wrappers that should be stripped before destructive analysis.
 * `timeout 10 rm -rf /` should be analyzed as `rm -rf /`.
 */
const COMMAND_WRAPPERS = ["timeout", "nice", "nohup", "exec", "command", "env", "xargs", "sudo", "time"]

export type ShellCompoundOperator = "&&" | "||" | "|&" | "|" | ";;&" | ";;" | ";&" | ";" | "&"

export interface ShellCompoundLexResult {
  segments: string[]
  operators: ShellCompoundOperator[]
}

const COMPOUND_OPERATORS = [";;&", "&&", "||", "|&", ";;", ";&", "|", ";", "&"] as const
interface HeredocDelimiter {
  value: string
  stripTabs: boolean
  fd: string
  explicitFd: boolean
}

export type ShellQuote = "'" | '"' | undefined
export interface ShellWalkOptions {
  comments?: boolean
  backticks?: boolean
}

export interface ShellWalkContext {
  arithmetic: boolean
  commandSubstitutionDepth: number
  inBacktick: boolean
}

function isShellCommentStart(char: string, wordStarted: boolean): boolean {
  return char === "#" && !wordStarted
}

export function walkShellChars(
  command: string,
  visit: (char: string, index: number, quote: ShellQuote, context: ShellWalkContext) => number | false | void,
  options: ShellWalkOptions = {},
): boolean {
  let quote: ShellQuote
  let inComment = false
  let inBacktick = false
  let wordStarted = false
  let commandSubstitutionPending = false
  let commandSubstitutionDepth = 0
  const commandSubstitutionStarts: number[] = []
  let arithmeticPendingParens = 0
  let arithmeticParenDepth = 0
  let arithmeticBracketPending = false
  let arithmeticBracketDepth = 0
  let arithmeticCommand = false

  for (let index = 0; index < command.length; index++) {
    const char = command[index]
    if (options.comments && inComment) {
      if (char === "\n") {
        inComment = false
        wordStarted = false
      }
      continue
    }
    if (char === "\\" && quote !== "'") {
      wordStarted = true
      index++
      continue
    }
    if ((char === "'" || char === '"') && !inBacktick && (!quote || quote === char)) {
      quote = quote ? undefined : char
      wordStarted = true
      continue
    }
    if (options.backticks && !quote && char === "`") {
      const nextIndex = visit(char, index, quote, {
        arithmetic: arithmeticParenDepth > 0 || arithmeticBracketDepth > 0,
        commandSubstitutionDepth,
        inBacktick,
      })
      if (nextIndex === false) return false
      inBacktick = !inBacktick
      wordStarted = true
      continue
    }
    if (options.comments && !quote && !inBacktick && isShellCommentStart(char, wordStarted)) {
      inComment = true
      continue
    }

    const nextIndex = visit(char, index, quote, {
      arithmetic: arithmeticParenDepth > 0 || arithmeticBracketDepth > 0,
      commandSubstitutionDepth,
      inBacktick,
    })
    if (nextIndex === false) return false
    if (typeof nextIndex === "number") {
      wordStarted = true
      index = nextIndex
      continue
    }
    if ((!options.comments && !options.backticks) || quote || inBacktick) continue
    if (char === "$" && command.startsWith("$((", index)) {
      arithmeticPendingParens = 2
      arithmeticCommand = false
      wordStarted = true
      continue
    }
    if (arithmeticParenDepth === 0 && arithmeticPendingParens === 0 && isArithmeticCommandStart(command, index)) {
      arithmeticPendingParens = 2
      arithmeticCommand = true
    }
    if (char === "(" && arithmeticPendingParens > 0) {
      arithmeticPendingParens--
      arithmeticParenDepth++
      wordStarted = true
      continue
    }
    if (arithmeticParenDepth > 0) {
      if (char === "(") arithmeticParenDepth++
      if (char === ")") arithmeticParenDepth--
      wordStarted = arithmeticParenDepth === 0 ? !arithmeticCommand : !/\s/.test(char)
      continue
    }
    if (char === "$" && command[index + 1] === "[") {
      arithmeticBracketPending = true
      wordStarted = true
      continue
    }
    if (char === "[" && arithmeticBracketPending) {
      arithmeticBracketPending = false
      arithmeticBracketDepth = 1
      wordStarted = true
      continue
    }
    if (arithmeticBracketDepth > 0) {
      if (char === "[") arithmeticBracketDepth++
      if (char === "]") arithmeticBracketDepth--
      wordStarted = arithmeticBracketDepth === 0 ? true : !/\s/.test(char)
      continue
    }
    if (char === "$" && command[index + 1] === "(" && command[index + 2] !== "(") {
      commandSubstitutionPending = true
      wordStarted = true
      continue
    }
    if (char === "(" && commandSubstitutionPending) {
      commandSubstitutionPending = false
      commandSubstitutionDepth++
      commandSubstitutionStarts.push(commandSubstitutionDepth)
      wordStarted = false
      continue
    }
    if (commandSubstitutionDepth > 0 && char === "(") {
      commandSubstitutionDepth++
      wordStarted = false
      continue
    }
    if (commandSubstitutionDepth > 0 && char === ")") {
      const closingDepth = commandSubstitutionDepth--
      if (commandSubstitutionStarts.at(-1) === closingDepth) {
        commandSubstitutionStarts.pop()
        wordStarted = true
      } else {
        wordStarted = false
      }
      continue
    }
    wordStarted = !/\s/.test(char) && !/[()<>;&|]/.test(char)
  }
  return true
}

function isArithmeticCommandStart(command: string, index: number): boolean {
  if (command[index] !== "(" || command[index + 1] !== "(") return false
  const prefix = command.slice(Math.max(0, index - 64), index)
  return index === 0 || /[\s;&|({}]$/.test(prefix) || /(?:^|[\s;&|({}])(?:then|do|else|elif)\s*$/.test(prefix)
}

function heredocDelimiters(command: string, minimumIndex = 0): HeredocDelimiter[] {
  const delimiters: HeredocDelimiter[] = []
  walkShellChars(
    command,
    (char, index, quote, context) => {
      if (quote || context.inBacktick || context.arithmetic) return
      if (char !== "<" || command[index - 1] === "<" || command[index + 1] !== "<" || command[index + 2] === "<") return

      let fdStart = index
      while (fdStart > 0 && /\d/.test(command[fdStart - 1] ?? "")) fdStart--
      const fdCandidate = command.slice(fdStart, index)
      const explicitFd = fdCandidate.length > 0 && (fdStart === 0 || /[\s;&|()<>]/.test(command[fdStart - 1] ?? ""))

      let cursor = index + 2
      const stripTabs = command[cursor] === "-"
      if (stripTabs) cursor++
      while (command[cursor] === " " || command[cursor] === "\t") cursor++
      if (command[cursor] === "\\") cursor++

      let value = ""
      const delimiterQuote = command[cursor] === "'" || command[cursor] === '"' ? command[cursor++] : undefined
      while (cursor < command.length) {
        const delimiterChar = command[cursor]
        if (delimiterQuote ? delimiterChar === delimiterQuote : /[\s;&|<>()]/.test(delimiterChar)) break
        if (delimiterChar === "\\" && delimiterQuote === '"' && cursor + 1 < command.length) cursor++
        value += command[cursor++]
      }
      if (value && index >= minimumIndex) {
        delimiters.push({ value, stripTabs, fd: explicitFd ? fdCandidate : "0", explicitFd })
      }
      return delimiterQuote ? cursor : cursor - 1
    },
    { comments: true, backticks: true },
  )
  return delimiters
}

export interface ShellHeredocBody extends HeredocDelimiter {
  body: string
  header: string
  headerLine: number
  effective: boolean
}

export function extractShellHeredocBodies(command: string): ShellHeredocBody[] {
  const lines = command.split("\n")
  const bodies: ShellHeredocBody[] = []

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const headerLine = lineIndex
    const header = lines[lineIndex]
    const delimiters = heredocDelimiters(header)
    if (delimiters.length === 0) continue

    for (let delimiterIndex = 0; delimiterIndex < delimiters.length; delimiterIndex++) {
      const delimiter = delimiters[delimiterIndex]
      const bodyLines: string[] = []
      for (lineIndex++; lineIndex < lines.length; lineIndex++) {
        const line = lines[lineIndex]
        const candidate = delimiter.stripTabs ? line.replace(/^\t+/, "") : line
        if (candidate === delimiter.value) break
        bodyLines.push(line)
      }
      const effective = !delimiters.slice(delimiterIndex + 1).some((candidate) => candidate.fd === delimiter.fd)
      bodies.push({ ...delimiter, body: bodyLines.join("\n"), header, headerLine, effective })
    }
  }
  return bodies
}

function compoundOperatorAt(command: string, index: number): ShellCompoundOperator | undefined {
  const previous = command[index - 1]
  for (const operator of COMPOUND_OPERATORS) {
    if (!command.startsWith(operator, index)) continue
    if (operator === "&" && (previous === ">" || previous === "<" || command[index + 1] === ">")) continue
    if (operator === "|" && previous === ">") continue

    return operator
  }
  return undefined
}

/**
 * Lex the shell list/pipeline operators used by policy classification.
 * Operators inside quotes, escaped operators, and redirect file-descriptor
 * joins such as `2>&1` remain part of their command segment.
 */
export function lexCompoundCommands(command: string): ShellCompoundLexResult {
  const segments: string[] = []
  const operators: ShellCompoundOperator[] = []
  let current = ""
  let inSingle = false
  let inDouble = false
  let inBacktick = false
  let pendingNewline = false
  let inComment = false
  let wordStarted = false
  let currentLineCommentStart: number | undefined
  const commandSubstitutionStarts: number[] = []
  let commandSubstitutionDepth = 0
  let heredocs: HeredocDelimiter[] = []
  let heredocTargets: number[] | undefined
  const pendingHeredocs: HeredocDelimiter[] = []
  const pendingHeredocTargets: number[] = []
  let heredocLineStart = 0
  let arithmeticParenDepth = 0
  let arithmeticBracketDepth = 0
  let arithmeticCommand = false

  for (let i = 0; i < command.length; i++) {
    const ch = command[i]
    if (heredocs.length > 0) {
      current += ch
      if (ch !== "\n") continue

      const delimiter = heredocs[0]
      const line = current.slice(heredocLineStart, -1)
      const candidate = delimiter.stripTabs ? line.replace(/^\t+/, "") : line
      if (candidate === delimiter.value) {
        heredocs.shift()
        if (heredocTargets) {
          const target = heredocTargets.shift()
          if (target !== undefined) segments[target] += current.slice(0, -1)
          current = heredocs.length > 0 ? "\n" : ""
          heredocLineStart = current.length
          if (heredocs.length === 0) {
            heredocTargets = undefined
            pendingNewline = true
          }
        } else if (heredocs.length === 0 && commandSubstitutionDepth === 0) {
          if (current.trim()) segments.push(current.trim())
          current = ""
          pendingNewline = true
        }
      }
      heredocLineStart = current.length
      continue
    }
    if (inComment) {
      if (ch !== "\n") {
        current += ch
        continue
      }
      inComment = false
    }
    if (pendingNewline) {
      if (/\s/.test(ch)) continue
      // Defer the operator until content follows so trailing newlines do not create phantom list entries.
      operators.push(";")
      pendingNewline = false
    }
    if (ch === "\\" && !inSingle) {
      current += ch
      if (i + 1 < command.length) current += command[++i]
      wordStarted = true
      continue
    }
    if (ch === "`" && !inSingle) {
      inBacktick = !inBacktick
      current += ch
      wordStarted = true
      continue
    }
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle
      current += ch
      wordStarted = true
      continue
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble
      current += ch
      wordStarted = true
      continue
    }
    if (!inSingle && !inDouble && !inBacktick && arithmeticParenDepth > 0) {
      current += ch
      if (ch === "(") arithmeticParenDepth++
      if (ch === ")") arithmeticParenDepth--
      if (arithmeticParenDepth === 0 && arithmeticCommand) wordStarted = false
      continue
    }
    if (!inSingle && !inDouble && !inBacktick && arithmeticBracketDepth > 0) {
      current += ch
      if (ch === "[") arithmeticBracketDepth++
      if (ch === "]") arithmeticBracketDepth--
      continue
    }
    if (!inSingle && !inDouble && !inBacktick && ch === "$" && command.startsWith("$((", i)) {
      arithmeticParenDepth = 2
      arithmeticCommand = false
      current += "$(("
      wordStarted = true
      i += 2
      continue
    }
    if (!inSingle && !inDouble && !inBacktick && isArithmeticCommandStart(command, i)) {
      arithmeticParenDepth = 2
      arithmeticCommand = true
      current += "(("
      wordStarted = true
      i++
      continue
    }
    if (!inSingle && !inDouble && !inBacktick && ch === "$" && command[i + 1] === "[") {
      arithmeticBracketDepth = 1
      current += "$["
      wordStarted = true
      i++
      continue
    }
    if (!inSingle && !inDouble && !inBacktick && isShellCommentStart(ch, wordStarted)) {
      inComment = true
      currentLineCommentStart = current.length
      current += ch
      continue
    }
    if (!inSingle && ch === "$" && command[i + 1] === "(" && command[i + 2] !== "(") {
      commandSubstitutionDepth++
      commandSubstitutionStarts.push(commandSubstitutionDepth)
      wordStarted = false
      current += "$("
      i++
      continue
    }
    if (!inSingle && commandSubstitutionDepth > 0 && ch === "(") {
      commandSubstitutionDepth++
      wordStarted = false
      current += ch
      continue
    }
    if (!inSingle && commandSubstitutionDepth > 0 && ch === ")") {
      const closingDepth = commandSubstitutionDepth--
      current += ch
      if (commandSubstitutionStarts.at(-1) === closingDepth) {
        commandSubstitutionStarts.pop()
        wordStarted = true
      } else {
        wordStarted = false
      }
      continue
    }
    if (!inSingle && !inDouble && !inBacktick) {
      if (ch === "\n") {
        wordStarted = false
        const commentOnly =
          currentLineCommentStart !== undefined && current.slice(0, currentLineCommentStart).trim() === ""
        const heredocSource =
          currentLineCommentStart === undefined ? current : current.slice(0, currentLineCommentStart)
        currentLineCommentStart = undefined
        const currentHeredocs = heredocDelimiters(heredocSource, heredocSource.lastIndexOf("\n") + 1)
        if (commentOnly && commandSubstitutionDepth === 0) {
          current = ""
        } else if (commandSubstitutionDepth === 0 && (pendingHeredocs.length > 0 || currentHeredocs.length > 0)) {
          if (current.trim()) {
            const target = segments.length
            segments.push(current.trim())
            pendingHeredocs.push(...currentHeredocs)
            pendingHeredocTargets.push(...currentHeredocs.map(() => target))
          }
          heredocs = pendingHeredocs.splice(0)
          heredocTargets = pendingHeredocTargets.splice(0)
          current = "\n"
          heredocLineStart = current.length
        } else if (currentHeredocs.length > 0) {
          current += ch
          heredocs = currentHeredocs
          heredocLineStart = current.length
        } else if (commandSubstitutionDepth > 0) {
          current += ch
        } else if (current.trim()) {
          segments.push(current.trim())
          current = ""
          pendingNewline = true
        }
        continue
      }
      const nestedOperator = compoundOperatorAt(command, i)
      if (nestedOperator && commandSubstitutionDepth > 0) {
        current += nestedOperator
        wordStarted = false
        i += nestedOperator.length - 1
        continue
      }
      if (commandSubstitutionDepth === 0) {
        const operator = compoundOperatorAt(command, i)
        if (operator) {
          if (current.trim()) {
            const target = segments.length
            const currentHeredocs = heredocDelimiters(current, current.lastIndexOf("\n") + 1)
            segments.push(current.trim())
            pendingHeredocs.push(...currentHeredocs)
            pendingHeredocTargets.push(...currentHeredocs.map(() => target))
          }
          operators.push(operator)
          current = ""
          wordStarted = false
          i += operator.length - 1
          continue
        }
      }
    }
    current += ch
    wordStarted = !/\s/.test(ch) && !/[()<>]/.test(ch)
  }
  if (current && heredocTargets?.length) {
    const target = heredocTargets[0]
    if (target !== undefined) segments[target] += current
  } else if (
    current.trim() &&
    !(currentLineCommentStart !== undefined && current.slice(0, currentLineCommentStart).trim() === "")
  ) {
    segments.push(current.trim())
  }
  return { segments, operators }
}

/**
 * Split a compound shell command into its sub-commands for independent
 * destructive analysis. `rm -rf / && echo done` yields two sub-commands.
 */
export function splitCompoundCommands(command: string): string[] {
  return lexCompoundCommands(command).segments
}

/**
 * Strip leading wrapper commands (timeout, sudo, etc.) to reveal the actual
 * command being run.
 */
export function stripWrappers(command: string): string {
  let cmd = command.trim()
  let changed = true
  while (changed) {
    changed = false
    for (const wrapper of COMMAND_WRAPPERS) {
      const regex = new RegExp(`^${wrapper}\\s+`, "i")
      const match = cmd.match(regex)
      if (match) {
        cmd = cmd.slice(match[0].length)
        const nextTokenMatch = cmd.match(/^(\S+)\s+/)
        if (nextTokenMatch) {
          const nextToken = nextTokenMatch[1]
          if (/^(-|\d)/.test(nextToken)) {
            cmd = cmd.slice(nextTokenMatch[0].length)
          }
        }
        changed = true
        break
      }
    }
  }
  return cmd
}
