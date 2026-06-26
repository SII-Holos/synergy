/**
 * Shell command wrappers that should be stripped before destructive analysis.
 * `timeout 10 rm -rf /` should be analyzed as `rm -rf /`.
 */
const COMMAND_WRAPPERS = ["timeout", "nice", "nohup", "exec", "command", "env", "xargs", "sudo", "time"]

/**
 * Split a compound shell command into its sub-commands for independent
 * destructive analysis. `rm -rf / && echo done` yields two sub-commands.
 */
export function splitCompoundCommands(command: string): string[] {
  const parts: string[] = []
  let current = ""
  let inSingle = false
  let inDouble = false
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]
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
      if (ch === "&" && command[i + 1] === "&") {
        parts.push(current)
        current = ""
        i++
        continue
      }
      if (ch === "|" && command[i + 1] === "|") {
        parts.push(current)
        current = ""
        i++
        continue
      }
      if (ch === ";" || ch === "|") {
        parts.push(current)
        current = ""
        continue
      }
    }
    current += ch
  }
  if (current.trim()) parts.push(current)
  return parts
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
