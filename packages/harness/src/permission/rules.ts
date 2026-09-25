import { Lock } from "../util/lock"
import { RuntimeContext } from "../lifecycle/context"
import { Storage } from "../storage/storage"
import { StoragePath } from "../storage/path"
import { Log } from "../util/log"
import { Wildcard } from "../util/wildcard"
import { splitCompoundCommands, stripWrappers } from "../enforcement/shell-command"
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

  const runtimeState = RuntimeContext.state(() => ({
    sessionRules: new Map<string, Rule[]>(),
    userRulesCache: undefined as Ruleset | undefined,
  }))

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
    const instanceState = runtimeState()

    const rules = instanceState.sessionRules.get(sessionID) ?? []
    rules.push({ ...rule, scope: "session" })
    instanceState.sessionRules.set(sessionID, rules)
    log.info("added session rule", { sessionID, ...rule })
  }

  export function clearSessionRules(sessionID?: string) {
    const instanceState = runtimeState()

    if (sessionID) {
      instanceState.sessionRules.delete(sessionID)
      return
    }
    instanceState.sessionRules.clear()
  }

  export function sessionRuleset(sessionID?: string): Ruleset {
    const instanceState = runtimeState()

    if (!sessionID) return []
    return [...(instanceState.sessionRules.get(sessionID) ?? [])]
  }

  async function loadUserRules(): Promise<Ruleset> {
    const instanceState = runtimeState()

    if (instanceState.userRulesCache) return instanceState.userRulesCache
    try {
      const data = await Storage.read<Ruleset>(StoragePath.permissionRules())
      instanceState.userRulesCache = Array.isArray(data) ? data : []
    } catch (error) {
      if (!(error instanceof Storage.NotFoundError)) throw error
      instanceState.userRulesCache = []
    }
    return instanceState.userRulesCache
  }

  async function saveUserRules(rules: Ruleset) {
    const instanceState = runtimeState()

    await Storage.write(StoragePath.permissionRules(), rules)
    Storage.afterCommit(() => {
      instanceState.userRulesCache = rules
    })
    log.info("saved user rules", { count: rules.length })
  }

  export async function addUserRule(rule: Omit<Rule, "scope">) {
    return addUserRules([rule])
  }

  export async function addUserRules(rules: Omit<Rule, "scope">[]) {
    using lock = await Lock.write("permission-user-rules")
    await Storage.transaction(async () => {
      const current = await Storage.read<Ruleset>(StoragePath.permissionRules()).catch((error) => {
        if (error instanceof Storage.NotFoundError) return []
        throw error
      })
      const next = [...current]
      for (const rule of rules) {
        if (
          !next.some(
            (item) =>
              item.permission === rule.permission && item.pattern === rule.pattern && item.action === rule.action,
          )
        ) {
          next.push({ ...rule, scope: "user" })
        }
      }
      await saveUserRules(next)
    })
  }

  export async function removeUserRule(permission: string, pattern: string) {
    using lock = await Lock.write("permission-user-rules")
    const current = await loadUserRules()
    await saveUserRules(current.filter((r) => !(r.permission === permission && r.pattern === pattern)))
  }

  export async function userRuleset(): Promise<Ruleset> {
    return loadUserRules()
  }

  export async function listAllRules(): Promise<Ruleset> {
    const instanceState = runtimeState()

    return [...(await loadUserRules()), ...[...instanceState.sessionRules.values()].flat()]
  }
}
