import { extractShellHeredocBodies, walkShellChars } from "../enforcement/shell-command"
import { Log } from "../util/log"
import { SecretVault } from "./vault"

const log = Log.create({ service: "secrets.resolve" })

export const TOKEN_PATTERN = /⟦sec:([0-9a-z]{12})⟧/g

function envName(id: string): string {
  return `SYNERGY_SEC_${id.toUpperCase()}`
}

export namespace SecretResolve {
  export interface Outcome<T> {
    /** Execution-only copy of the args with tokens resolved. */
    args: T
    /** Values injected into a local bash child's environment, keyed by variable name. */
    secretEnv?: Record<string, string>
    resolved: number
    denied: number
  }

  export interface Input {
    sessionID?: string
    tool: string
  }

  type Decision = { kind: "value"; value: string } | { kind: "denied"; marker: string } | { kind: "literal" }

  async function decide(id: string, input: Input): Promise<Decision> {
    const decision = await SecretVault.resolve(id, input)
    if ("value" in decision) return { kind: "value", value: decision.value }
    if (decision.reason === "missing") return { kind: "literal" }
    return { kind: "denied", marker: `⟦sec:${id}:DENIED⟧` }
  }

  /**
   * Resolve mask tokens in tool arguments immediately before execution, so
   * plaintext exists only inside the Control Plane execution window. The
   * caller must keep persisting the ORIGINAL tokenized args; the returned
   * args are an execution-only copy.
   *
   * Local bash: a token occupying a shell word (or an assignment value)
   * becomes a `${SYNERGY_SEC_*}` reference whose value is delivered through
   * the child environment; a token embedded in a longer word degrades to
   * literal substitution, which is the documented residual argv exposure.
   * Remote bash cannot receive a local child environment, so every token
   * degrades to literal substitution there. Every other tool: structural
   * substitution of tokens with plaintext. A policy denial substitutes a
   * visible marker and lets the operation proceed; a removed entry leaves
   * the token literal, matching what the model saw.
   */
  export async function transformArgs<T extends Record<string, unknown>>(args: T, input: Input): Promise<Outcome<T>> {
    const outcome: Outcome<T> = { args, resolved: 0, denied: 0 }
    if (input.tool === "bash" && typeof args.command === "string" && args.command.includes("⟦sec:")) {
      const remote = typeof args.targetID === "string" || typeof args.linkID === "string"
      const bash = await resolveBashCommand(args.command, input, remote)
      if (bash.command !== args.command) outcome.args = { ...args, command: bash.command }
      if (bash.secretEnv) outcome.secretEnv = bash.secretEnv
      outcome.resolved = bash.resolved
      outcome.denied = bash.denied
      return outcome
    }
    if (!JSON.stringify(args).includes("⟦sec:")) return outcome
    const clone = structuredClone(args)
    const counts = await substituteDeep(clone, input)
    outcome.args = clone
    outcome.resolved = counts.resolved
    outcome.denied = counts.denied
    return outcome
  }

  async function substituteDeep(node: unknown, input: Input): Promise<{ resolved: number; denied: number }> {
    let resolved = 0
    let denied = 0
    const visit = async (value: unknown): Promise<unknown> => {
      if (typeof value === "string") {
        if (!value.includes("⟦sec:")) return value
        return rewriteEmbedded(value, input, {
          resolved: () => resolved++,
          denied: () => denied++,
        })
      }
      if (Array.isArray(value)) {
        for (let i = 0; i < value.length; i++) value[i] = await visit(value[i])
        return value
      }
      if (value && typeof value === "object") {
        for (const [key, item] of Object.entries(value)) {
          ;(value as Record<string, unknown>)[key] = await visit(item)
        }
        return value
      }
      return value
    }
    await visit(node)
    return { resolved, denied }
  }

  interface Counts {
    resolved(): void
    denied(): void
  }

  /** Substitute tokens in place inside one string (non-bash tools). */
  async function rewriteEmbedded(text: string, input: Input, counts: Counts): Promise<string> {
    const matches = [...text.matchAll(TOKEN_PATTERN)]
    if (matches.length === 0) return text
    const decisions: Decision[] = []
    for (const match of matches) {
      const decision = await decide(match[1]!, input)
      if (decision.kind === "value") counts.resolved()
      else if (decision.kind === "denied") counts.denied()
      decisions.push(decision)
    }
    let out = ""
    let cursor = 0
    matches.forEach((match, i) => {
      const start = match.index!
      out += text.slice(cursor, start)
      const decision = decisions[i]!
      if (decision.kind === "value") out += decision.value
      else if (decision.kind === "denied") out += decision.marker
      else out += match[0]
      cursor = start + match[0].length
    })
    out += text.slice(cursor)
    return out
  }

  function isFreeBoundary(ch: string | undefined): boolean {
    return ch === undefined || /[\s|&;<>()=]/.test(ch)
  }

  async function resolveBashCommand(
    command: string,
    input: Input,
    remote: boolean,
  ): Promise<{ command: string; secretEnv?: Record<string, string>; resolved: number; denied: number }> {
    const matches = [...command.matchAll(TOKEN_PATTERN)]
    if (matches.length === 0) return { command, resolved: 0, denied: 0 }
    const decisions: Decision[] = []
    for (const match of matches) decisions.push(await decide(match[1]!, input))

    const expandable = new Set<number>()
    if (extractShellHeredocBodies(command).length === 0)
      walkShellChars(
        command,
        (char, index, quote, context) => {
          if (char === "⟦" && !quote && !context.inBacktick && !context.arithmetic && !context.commandSubstitutionDepth)
            expandable.add(index)
        },
        { comments: true, backticks: true },
      )
    const secretEnv: Record<string, string> = {}
    let out = ""
    let cursor = 0
    let resolved = 0
    let denied = 0
    matches.forEach((match, i) => {
      const start = match.index!
      const end = start + match[0].length
      const decision = decisions[i]!
      const standalone = isFreeBoundary(command[start - 1]) && isFreeBoundary(command[end])
      out += command.slice(cursor, start)
      if (decision.kind === "value") {
        resolved++
        if (standalone && expandable.has(start) && !remote) {
          const name = envName(match[1]!)
          secretEnv[name] = decision.value
          out += `"\${${name}}"`
        } else {
          if (!/^[A-Za-z0-9_./:@%+=,-]+$/.test(decision.value))
            throw new Error(
              "This secret requires a standalone unquoted token in local Bash; literal substitution would change shell syntax",
            )
          out += decision.value
        }
      } else if (decision.kind === "denied") {
        denied++
        out += decision.marker
      } else {
        out += match[0]
      }
      cursor = end
    })
    out += command.slice(cursor)
    log.debug("bash command resolved", {
      resolved,
      denied,
      injected: Object.keys(secretEnv).length,
      remote,
    })
    return {
      command: out,
      ...(Object.keys(secretEnv).length > 0 ? { secretEnv } : {}),
      resolved,
      denied,
    }
  }
}
