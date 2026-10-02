import type { MessageDescriptor } from "@lingui/core"
import { z } from "zod"
import type { SettingsState } from "./types"

export type SettingsDraftIssue = {
  page: "timeouts" | "email" | "memory" | "experience" | "mcp"
  field: string
  message: MessageDescriptor
}

const positive = { id: "settings.validation.positive", message: "Enter a number greater than zero." }
const nonNegative = { id: "settings.validation.nonNegative", message: "Enter zero or a positive number." }
const integer = { id: "settings.validation.integer", message: "Enter a whole number greater than zero." }
const workers = {
  id: "settings.validation.workers",
  message: "Enter a whole number from 1 to 64, or leave empty for automatic capacity.",
}
const overrides = {
  id: "settings.validation.toolOverrides",
  message: "Use a JSON object or one tool=seconds pair per line. Each timeout must be greater than zero.",
}
const overridesSchema = z.record(z.string().min(1), z.number().positive())

export function parseToolTimeoutOverrides(value: string): Record<string, number> | undefined {
  const input = value.trim()
  if (!input) return {}
  if (input.startsWith("{")) {
    try {
      const parsed = overridesSchema.safeParse(JSON.parse(input))
      return parsed.success ? parsed.data : undefined
    } catch {
      return undefined
    }
  }
  const result: Record<string, number> = {}
  for (const line of input.split(/\r?\n/).filter((line) => line.trim())) {
    const separator = line.indexOf("=")
    if (separator <= 0) return undefined
    const key = line.slice(0, separator).trim()
    const raw = line.slice(separator + 1).trim()
    if (!key || !raw) return undefined
    result[key] = Number(raw)
  }
  const parsed = overridesSchema.safeParse(result)
  return parsed.success ? parsed.data : undefined
}

export function validateSettingsDraft(state: SettingsState): SettingsDraftIssue[] {
  const issues: SettingsDraftIssue[] = []
  const check = (
    page: SettingsDraftIssue["page"],
    field: string,
    value: string,
    valid: (value: number) => boolean,
    message: MessageDescriptor,
  ) => {
    if (!value.trim()) return
    const number = Number(value)
    if (!Number.isFinite(number) || !valid(number)) issues.push({ page, field, message })
  }
  const runtime = state.runtime
  for (const field of ["invokeTimeout", "providerTtfbTimeout", "toolDefaultTimeout"] as const) {
    check("timeouts", field, runtime[field], (number) => number > 0, positive)
  }
  for (const field of ["providerIdleTimeout", "providerWallTimeout"] as const) {
    if (field === "providerIdleTimeout" && runtime[field].trim().toLowerCase() === "false") continue
    check("timeouts", field, runtime[field], (number) => number >= 0, nonNegative)
  }
  check(
    "timeouts",
    "agentWorkers",
    runtime.agentWorkers,
    (number) => Number.isInteger(number) && number >= 1 && number <= 64,
    workers,
  )
  check(
    "timeouts",
    "cortexConcurrency",
    runtime.cortexConcurrency,
    (number) => Number.isInteger(number) && number > 0,
    integer,
  )
  if (!parseToolTimeoutOverrides(runtime.toolOverrides))
    issues.push({ page: "timeouts", field: "toolOverrides", message: overrides })
  for (const field of ["smtpPort", "imapPort"] as const) {
    check("email", field, state.email[field], (number) => Number.isInteger(number) && number > 0, integer)
  }
  const probability = { id: "settings.validation.probability", message: "Enter a number from 0 to 1." }
  check(
    "memory",
    "memorySimThreshold",
    state.library.memorySimThreshold,
    (number) => number >= 0 && number <= 1,
    probability,
  )
  for (const field of ["experienceSimThreshold", "experienceEpsilon"] as const) {
    check("experience", field, state.library[field], (number) => number >= 0 && number <= 1, probability)
  }
  const names = state.mcps.entries.map((entry) => entry.key.trim())
  for (const [index, entry] of state.mcps.entries.entries()) {
    const field = (name: string) => `${index}.${name}`
    if (!entry.key.trim()) {
      issues.push({
        page: "mcp",
        field: field("key"),
        message: { id: "settings.mcp.validation.name", message: "Enter a server name." },
      })
    } else if (
      names.filter((name) => name === entry.key.trim()).length > 1 ||
      state.mcps.builtins.some((builtin) => builtin.name === entry.key.trim())
    ) {
      issues.push({
        page: "mcp",
        field: field("key"),
        message: {
          id: "settings.mcp.validation.duplicate",
          message: "Choose a name that is not used by another server.",
        },
      })
    }
    if (entry.type === "local" && !entry.command.trim()) {
      issues.push({
        page: "mcp",
        field: field("command"),
        message: { id: "settings.mcp.validation.command", message: "Enter the command that starts this server." },
      })
    }
    if (
      entry.type === "remote" &&
      (!URL.canParse(entry.url.trim()) || !["http:", "https:"].includes(new URL(entry.url.trim()).protocol))
    ) {
      issues.push({
        page: "mcp",
        field: field("url"),
        message: { id: "settings.mcp.validation.url", message: "Enter a complete HTTP or HTTPS server URL." },
      })
    }
    check("mcp", field("timeout"), entry.timeout, (number) => Number.isInteger(number) && number > 0, integer)
    const pairField = entry.type === "remote" ? "headers" : "environment"
    const separator = entry.type === "remote" ? ":" : "="
    const keys = new Set<string>()
    for (const line of entry[pairField].split(/\r?\n/)) {
      if (!line.trim() || line.trim() === separator) continue
      const position = line.indexOf(separator)
      const key = line.slice(0, position).trim()
      const normalizedKey = pairField === "headers" ? key.toLowerCase() : key
      if (position <= 0 || !key || keys.has(normalizedKey)) {
        issues.push({
          page: "mcp",
          field: field(pairField),
          message: { id: "settings.mcp.validation.pairs", message: "Give each entry a different, non-empty name." },
        })
        break
      }
      keys.add(normalizedKey)
    }
  }
  return issues
}
