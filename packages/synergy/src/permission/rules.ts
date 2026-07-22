import { Storage } from "@/storage/storage"
import { StoragePath } from "@/storage/path"
import { Log } from "@/util/log"
import { Wildcard } from "@/util/wildcard"
import { splitCompoundCommands, stripWrappers } from "@/enforcement/shell-command"
import z from "zod"

export namespace PermissionRules {
  const log = Log.create({ service: "permission.rules" })

  export const Action = z.enum(["allow", "deny", "ask"])
  export type Action = z.infer<typeof Action>

  export const Rule = z.object({
    permission: z.string(),
    pattern: z.string(),
    action: Action,
    scope: z.enum(["managed", "user", "session"]).default("user"),
  })
  export type Rule = z.infer<typeof Rule>

  export const Ruleset = Rule.array()
  export type Ruleset = z.infer<typeof Ruleset>

  const sessionRules = new Map<string, Rule[]>()

  function firstStringPath(value: unknown): string | undefined {
    if (typeof value === "string") return value.length > 0 ? value : undefined
    if (!Array.isArray(value)) return undefined
    return value.find((item): item is string => typeof item === "string" && item.length > 0)
  }

  function firstPathArg(args: Record<string, any>): string | undefined {
    for (const value of [
      args.path,
      args.file_path,
      args.filePath,
      args.input_paths,
      args.output_path,
      args.outputPath,
    ]) {
      const path = firstStringPath(value)
      if (path) return path
    }
  }

  export function extractPattern(toolName: string, args: Record<string, any>): string {
    if (toolName === "bash") {
      const command = (args.command as string) ?? ""
      const subs = splitCompoundCommands(command)
      if (subs.length === 0) return "*"
      const stripped = stripWrappers(subs[0]).trim()
      const tokens = stripped.split(/\s+/).slice(0, 2)
      return tokens.length > 0 ? tokens.join(" ") + " *" : "*"
    }
    const path = firstPathArg(args)
    if (path) {
      const parts = path.replace(/^\.\//, "").split("/")
      if (parts.length > 1) {
        return parts.slice(0, Math.min(2, parts.length - 1)).join("/") + "/*"
      }
      return "*"
    }
    return "*"
  }

  export function evaluate(
    permission: string,
    pattern: string,
    ...rulesets: Ruleset[]
  ): { action: Action; rule?: Rule } {
    const merged = merge(...rulesets)
    const denyMatch = merged.findLast(
      (r) => Wildcard.match(permission, r.permission) && Wildcard.match(pattern, r.pattern) && r.action === "deny",
    )
    if (denyMatch) return { action: "deny", rule: denyMatch }

    const match = merged.findLast((r) => Wildcard.match(permission, r.permission) && Wildcard.match(pattern, r.pattern))
    if (match) return { action: match.action, rule: match }
    return { action: "ask" }
  }

  export function merge(...rulesets: Ruleset[]): Ruleset {
    return rulesets.flat()
  }

  export function addSessionRule(sessionID: string, rule: Omit<Rule, "scope">) {
    const rules = sessionRules.get(sessionID) ?? []
    rules.push({ ...rule, scope: "session" })
    sessionRules.set(sessionID, rules)
    log.info("added session rule", { sessionID, ...rule })
  }

  export function clearSessionRules(sessionID?: string) {
    if (sessionID) {
      sessionRules.delete(sessionID)
      return
    }
    sessionRules.clear()
  }

  export function sessionRuleset(sessionID?: string): Ruleset {
    if (!sessionID) return []
    return [...(sessionRules.get(sessionID) ?? [])]
  }

  let userRulesCache: Ruleset | undefined

  async function loadUserRules(): Promise<Ruleset> {
    if (userRulesCache) return userRulesCache
    try {
      const data = await Storage.read<Ruleset>(StoragePath.permissionRules())
      userRulesCache = Array.isArray(data) ? data : []
    } catch {
      userRulesCache = []
    }
    return userRulesCache
  }

  async function saveUserRules(rules: Ruleset) {
    userRulesCache = rules
    await Storage.write(StoragePath.permissionRules(), rules)
    log.info("saved user rules", { count: rules.length })
  }

  export async function addUserRule(rule: Omit<Rule, "scope">) {
    const current = await loadUserRules()
    const exists = current.some(
      (r) => r.permission === rule.permission && r.pattern === rule.pattern && r.action === rule.action,
    )
    if (!exists) {
      await saveUserRules([...current, { ...rule, scope: "user" }])
    }
  }

  export async function removeUserRule(permission: string, pattern: string) {
    const current = await loadUserRules()
    await saveUserRules(current.filter((r) => !(r.permission === permission && r.pattern === pattern)))
  }

  export async function userRuleset(): Promise<Ruleset> {
    return loadUserRules()
  }

  export async function listAllRules(): Promise<Ruleset> {
    return [...(await loadUserRules()), ...[...sessionRules.values()].flat()]
  }
}
