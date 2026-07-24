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

  for (let i = 0; i < command.length; i++) {
    const ch = command[i]
    if (ch === "\\" && !inSingle) {
      current += ch
      if (i + 1 < command.length) current += command[++i]
      continue
    }
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle
      current += ch
      continue
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble
      current += ch
      continue
    }
    if (!inSingle && !inDouble) {
      const operator = compoundOperatorAt(command, i)
      if (operator) {
        if (current.trim()) segments.push(current.trim())
        operators.push(operator)
        current = ""
        i += operator.length - 1
        continue
      }
    }
    current += ch
  }
  if (current.trim()) segments.push(current.trim())
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
