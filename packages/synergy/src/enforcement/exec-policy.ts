export type PrefixRule = {
  action: "allow" | "forbid" | "ask"
  prefix: string[]
  source?: string
}

export type NetworkRule = {
  action: "allow" | "forbid"
  protocol: string
  host: string
  source?: string
}

export type RuleMatch = {
  action: "allow" | "ask" | "deny"
  matchedRule?: PrefixRule
  heuristic: boolean
}

export type AskForApproval = {
  mode: "never" | "on_failure" | "on_request" | "granular"
  rules?: boolean
  sandboxApproval?: boolean
}

export type ExecPolicyAmendment = {
  type: "execPolicy"
  commandPrefix: string[]
}

// ──────────────────────────────────────────────────────────────
// Heuristic classification
// ──────────────────────────────────────────────────────────────

const KNOWN_SAFE = new Set([
  "ls",
  "pwd",
  "echo",
  "cat",
  "head",
  "tail",
  "grep",
  "find",
  "which",
  "whoami",
  "date",
  "env",
  "printenv",
])

const KNOWN_DANGEROUS = new Set(["rm", "sudo", "chmod", "chown", "dd", "mkfs"])

function heuristicAction(command: string[]): "allow" | "ask" | "deny" {
  if (command.length === 0) return "ask"
  const base = command[0] ?? ""
  if (KNOWN_SAFE.has(base)) return "allow"
  if (KNOWN_DANGEROUS.has(base)) return "deny"
  return "ask"
}

// ──────────────────────────────────────────────────────────────
// Prefix rule matching
// ──────────────────────────────────────────────────────────────

function prefixLength(rule: PrefixRule): number {
  return rule.prefix.length
}

function prefixMatches(command: string[], rule: PrefixRule): boolean {
  if (rule.prefix.length > command.length) return false
  for (let i = 0; i < rule.prefix.length; i++) {
    if (rule.prefix[i] !== command[i]) return false
  }
  return true
}

function ruleActionToMatchAction(action: PrefixRule["action"]): RuleMatch["action"] {
  switch (action) {
    case "allow":
      return "allow"
    case "ask":
      return "ask"
    case "forbid":
      return "deny"
  }
}

export function evaluateCommand(command: string[], rules: PrefixRule[]): RuleMatch {
  let best: PrefixRule | null = null
  let bestLength = -1
  let bestIndex = -1

  for (let i = 0; i < rules.length; i++) {
    const rule = rules[i]
    if (!rule) continue
    const len = prefixLength(rule)
    if (len < bestLength) continue
    if (!prefixMatches(command, rule)) continue

    // Same length: last one wins (highest index)
    if (len === bestLength && i < bestIndex) continue

    best = rule
    bestLength = len
    bestIndex = i
  }

  if (best) {
    return {
      action: ruleActionToMatchAction(best.action),
      matchedRule: best,
      heuristic: false,
    }
  }

  return {
    action: heuristicAction(command),
    heuristic: true,
  }
}

// ──────────────────────────────────────────────────────────────
// Parsing
// ──────────────────────────────────────────────────────────────

const PREFIX_LINE_RE = /^(allow|forbid|ask|deny)\s+(.+)$/

function toPrefixAction(token: string): PrefixRule["action"] {
  if (token === "deny") return "forbid"
  return token as PrefixRule["action"]
}

export function parsePrefixRule(line: string, source?: { source: string }): PrefixRule | null {
  const match = PREFIX_LINE_RE.exec(line.trim())
  if (!match) return null

  const [, actionToken, rest] = match
  const prefix = rest.split(/\s+/).filter(Boolean)
  if (prefix.length === 0) return null

  return {
    action: toPrefixAction(actionToken),
    prefix,
    source: source?.source,
  }
}

const NETWORK_LINE_RE = /^network\s+(allow|forbid)\s+(\S+)\s+(\S+)$/

export function parseNetworkRule(line: string, source?: { source: string }): NetworkRule | null {
  const match = NETWORK_LINE_RE.exec(line.trim())
  if (!match) return null

  const [, action, protocol, host] = match

  return {
    action: action as NetworkRule["action"],
    protocol,
    host,
    source: source?.source,
  }
}

// ──────────────────────────────────────────────────────────────
// AskForApproval
// ──────────────────────────────────────────────────────────────

export function parseAskForApproval(value: string | object): AskForApproval {
  if (typeof value === "string") {
    switch (value) {
      case "never":
        return { mode: "never" }
      case "on_failure":
        return { mode: "on_failure" }
      case "on_request":
        return { mode: "on_request" }
      case "granular":
        return { mode: "granular", rules: true, sandboxApproval: true }
      default:
        return { mode: "never" }
    }
  }

  if (typeof value === "object" && value !== null) {
    const obj = value as Record<string, unknown>
    const mode = (obj.mode as AskForApproval["mode"]) ?? "never"
    return {
      mode,
      rules: obj.rules as boolean | undefined,
      sandboxApproval: obj.sandboxApproval as boolean | undefined,
    }
  }

  return { mode: "never" }
}

export function shouldPrompt(ask: AskForApproval, promptType: "rule" | "sandbox"): boolean {
  switch (ask.mode) {
    case "never":
      return false
    case "on_failure":
    case "on_request":
      return true
    case "granular": {
      if (promptType === "rule") return ask.rules !== false
      return ask.sandboxApproval !== false
    }
  }
}

// ──────────────────────────────────────────────────────────────
// Amendment generation
// ──────────────────────────────────────────────────────────────

export function generateAmendment(match: RuleMatch): ExecPolicyAmendment | null {
  if (match.action !== "ask") return null

  return {
    type: "execPolicy",
    commandPrefix: match.matchedRule?.prefix ?? [],
  }
}
