import { Bus } from "@/bus"
import { BusEvent } from "@/bus/bus-event"
import { Config } from "@/config/config"
import { Identifier } from "@/id/id"
import { Instance } from "@/scope/instance"
import { SessionInteraction } from "@/session/interaction"
import { fn } from "@/util/fn"
import { Log } from "@/util/log"
import { Wildcard } from "@/util/wildcard"
import z from "zod"

export namespace PermissionNext {
  const log = Log.create({ service: "permission" })

  export const Action = z.enum(["allow", "deny", "ask"]).meta({
    ref: "PermissionAction",
  })
  export type Action = z.infer<typeof Action>

  export const Rule = z
    .object({
      permission: z.string(),
      pattern: z.string(),
      action: Action,
    })
    .meta({
      ref: "PermissionRule",
    })
  export type Rule = z.infer<typeof Rule>

  export const Ruleset = Rule.array().meta({
    ref: "PermissionRuleset",
  })
  export type Ruleset = z.infer<typeof Ruleset>

  export function fromConfig(permission: Config.Permission) {
    const ruleset: Ruleset = []
    for (const [key, value] of Object.entries(permission)) {
      if (typeof value === "string") {
        ruleset.push({
          permission: key,
          action: value,
          pattern: "*",
        })
        continue
      }
      ruleset.push(...Object.entries(value).map(([pattern, action]) => ({ permission: key, pattern, action })))
    }
    return ruleset
  }

  export function merge(...rulesets: Ruleset[]): Ruleset {
    return rulesets.flat()
  }

  export function unattendedRuleset(): Ruleset {
    return [{ permission: "question", pattern: "*", action: "deny" }]
  }

  export function sessionRuleset(session?: { interaction?: SessionInteraction.Info; permission?: Ruleset }): Ruleset {
    if (!session) return []
    return merge(
      session.permission ?? [],
      SessionInteraction.isUnattended(session.interaction) ? unattendedRuleset() : [],
    )
  }

  export const Request = z
    .object({
      id: Identifier.schema("permission"),
      sessionID: Identifier.schema("session"),
      permission: z.string(),
      patterns: z.string().array(),
      metadata: z.record(z.string(), z.any()),
      tool: z
        .object({
          messageID: z.string(),
          callID: z.string(),
        })
        .optional(),
    })
    .meta({
      ref: "PermissionRequest",
    })

  export type Request = z.infer<typeof Request>

  export const Reply = z.enum(["once", "reject"])
  export type Reply = z.infer<typeof Reply>

  export const Event = {
    Asked: BusEvent.define("permission.asked", Request),
    Replied: BusEvent.define(
      "permission.replied",
      z.object({
        sessionID: z.string(),
        requestID: z.string(),
        reply: Reply,
      }),
    ),
    AllowAllChanged: BusEvent.define(
      "permission.allowAll.changed",
      z.object({
        sessionID: z.string(),
        enabled: z.boolean(),
        sessions: z.array(
          z.object({
            sessionID: z.string(),
            enabled: z.boolean(),
          }),
        ),
      }),
    ),
  }

  const state = Instance.state(async () => {
    const pending: Record<
      string,
      {
        info: Request
        resolve: () => void
        reject: (e: any) => void
      }
    > = {}

    return {
      pending,
      allowAll: new Set<string>(),
      parents: new Map<string, string>(),
    }
  })

  export const ask = fn(
    Request.partial({ id: true }).extend({
      ruleset: Ruleset,
    }),
    async (input) => {
      const s = await state()
      const { ruleset, ...request } = input
      for (const pattern of request.patterns ?? []) {
        const rule = evaluate(request.permission, pattern, ruleset)
        log.info("evaluated", { permission: request.permission, pattern, action: rule })
        if (rule.action === "deny")
          throw new DeniedError(ruleset.filter((r) => Wildcard.match(request.permission, r.permission)))
        if (rule.action === "ask") {
          if (s.allowAll.size > 0 && (await hasAllowAll(s, request.sessionID))) {
            log.info("allow-all bypass", { sessionID: request.sessionID, permission: request.permission, pattern })
            continue
          }
          if (request.metadata?.sessionInteractionMode === "unattended") {
            log.info("unattended auto-approve", {
              sessionID: request.sessionID,
              permission: request.permission,
              pattern,
            })
            continue
          }
          const id = input.id ?? Identifier.ascending("permission")
          return new Promise<void>((resolve, reject) => {
            const info: Request = {
              id,
              ...request,
            }
            s.pending[id] = {
              info,
              resolve,
              reject,
            }
            Bus.publish(Event.Asked, info)
          })
        }
        if (rule.action === "allow") continue
      }
    },
  )

  export const reply = fn(
    z.object({
      requestID: Identifier.schema("permission"),
      reply: Reply,
      message: z.string().optional(),
    }),
    async (input) => {
      const s = await state()
      const existing = s.pending[input.requestID]
      if (!existing) return
      delete s.pending[input.requestID]
      Bus.publish(Event.Replied, {
        sessionID: existing.info.sessionID,
        requestID: existing.info.id,
        reply: input.reply,
      })
      if (input.reply === "reject") {
        existing.reject(input.message ? new CorrectedError(input.message) : new RejectedError())
        // Reject all other pending permissions for this session
        const sessionID = existing.info.sessionID
        for (const [id, pending] of Object.entries(s.pending)) {
          if (pending.info.sessionID === sessionID) {
            delete s.pending[id]
            Bus.publish(Event.Replied, {
              sessionID: pending.info.sessionID,
              requestID: pending.info.id,
              reply: "reject",
            })
            pending.reject(new RejectedError())
          }
        }
        return
      }
      if (input.reply === "once") {
        existing.resolve()
        return
      }
    },
  )

  export function evaluate(permission: string, pattern: string, ...rulesets: Ruleset[]): Rule {
    const merged = merge(...rulesets)
    log.info("evaluate", { permission, pattern, ruleset: merged })
    const match = merged.findLast(
      (rule) => Wildcard.match(permission, rule.permission) && Wildcard.match(pattern, rule.pattern),
    )
    return match ?? { action: "ask", permission, pattern: "*" }
  }

  const EDIT_TOOLS = ["edit", "write", "patch", "multiedit"]

  export function disabled(tools: string[], ruleset: Ruleset): Set<string> {
    const result = new Set<string>()
    for (const tool of tools) {
      const permission = EDIT_TOOLS.includes(tool) ? "edit" : tool

      const rule = ruleset.findLast((r) => Wildcard.match(permission, r.permission))
      if (!rule) continue
      if (rule.pattern === "*" && rule.action === "deny") result.add(tool)
    }
    return result
  }

  /** User rejected without message - halts execution */
  export class RejectedError extends Error {
    constructor() {
      super(`The user rejected permission to use this specific tool call.`)
    }
  }

  /** User rejected with message - continues with guidance */
  export class CorrectedError extends Error {
    constructor(message: string) {
      super(`The user rejected permission to use this specific tool call with the following feedback: ${message}`)
    }
  }

  /** Auto-rejected by config rule - halts execution */
  export class DeniedError extends Error {
    constructor(public readonly ruleset: Ruleset) {
      super(
        `The user has specified a rule which prevents you from using this specific tool call. Here are some of the relevant rules ${JSON.stringify(ruleset)}`,
      )
    }
  }

  export async function registerParent(childSessionID: string, parentSessionID: string) {
    const s = await state()
    s.parents.set(childSessionID, parentSessionID)
  }

  export async function setAllowAll(sessionID: string, enabled: boolean) {
    const s = await state()
    if (enabled) {
      s.allowAll.add(sessionID)
      for (const [id, entry] of Object.entries(s.pending)) {
        if (!(await hasAllowAll(s, entry.info.sessionID))) continue
        delete s.pending[id]
        Bus.publish(Event.Replied, { sessionID: entry.info.sessionID, requestID: id, reply: "once" })
        entry.resolve()
      }
    } else {
      s.allowAll.delete(sessionID)
    }
    const sessions = await affectedSessions(s, sessionID)
    Bus.publish(Event.AllowAllChanged, {
      sessionID,
      enabled,
      sessions: await Promise.all(
        sessions.map(async (sessionID) => ({ sessionID, enabled: await hasAllowAll(s, sessionID) })),
      ),
    })
  }

  export async function isAllowingAll(sessionID: string) {
    const s = await state()
    return hasAllowAll(s, sessionID)
  }

  async function affectedSessions(s: State, rootSessionID: string) {
    const { Session } = await import("@/session")
    const affected = new Set<string>([rootSessionID])
    const queue = [rootSessionID]
    while (queue.length > 0) {
      const current = queue.shift()!
      for (const child of await Session.children(current)) {
        if (affected.has(child.id)) continue
        affected.add(child.id)
        queue.push(child.id)
        s.parents.set(child.id, current)
      }
    }
    return Array.from(affected)
  }

  export function requestMetadata(input?: { interaction?: SessionInteraction.Info }) {
    if (!input?.interaction) return {}
    return {
      sessionInteractionMode: input.interaction.mode,
      sessionInteractionSource: input.interaction.source,
    }
  }

  type State = Awaited<ReturnType<typeof state>>

  async function hasAllowAll(s: State, sessionID: string): Promise<boolean> {
    let current: string | undefined = sessionID
    while (current) {
      if (s.allowAll.has(current)) return true
      current = await parentSessionID(s, current)
    }
    return false
  }

  async function parentSessionID(s: State, sessionID: string) {
    const cached = s.parents.get(sessionID)
    if (cached) return cached
    const { SessionManager } = await import("@/session/manager")
    const session = await SessionManager.getSession(sessionID)
    const parentID = session?.parentID
    if (parentID) s.parents.set(sessionID, parentID)
    return parentID
  }

  export async function list() {
    return state().then((x) => Object.values(x.pending).map((x) => x.info))
  }
}
