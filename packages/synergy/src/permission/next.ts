import { Bus } from "@/bus"
import { BusEvent } from "@/bus/bus-event"
import { Config } from "@/config/config"
import { Identifier } from "@/id/id"
import { isNonBypassableMetadata } from "@/enforcement/capability"
import { PermissionRules } from "@/permission/rules"
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

  export const Reply = z.enum(["once", "session", "always", "reject"])
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
  }

  function isNonBypassable(request: { metadata?: Record<string, any> }): boolean {
    return isNonBypassableMetadata(request.metadata)
  }

  const state = Instance.state(async () => {
    const pending: Record<
      string,
      {
        info: Request
        resolve: () => void
        reject: (e: any) => void
        cleanup?: () => void
      }
    > = {}

    return {
      pending,
    }
  })

  export const ask = fn(
    Request.partial({ id: true }).extend({
      ruleset: Ruleset,
      signal: z.instanceof(AbortSignal).optional(),
    }),
    async (input) => {
      const s = await state()
      const { ruleset, signal, ...request } = input
      if (signal?.aborted) {
        throw new DOMException("The operation was aborted", "AbortError")
      }

      for (const pattern of request.patterns ?? []) {
        const rule = evaluate(request.permission, pattern, ruleset)
        if (rule.action === "deny")
          throw new DeniedError(ruleset.filter((r: Rule) => Wildcard.match(request.permission, r.permission)))
        if (rule.action === "ask" || (rule.action === "allow" && isNonBypassable(request))) {
          const id = input.id ?? Identifier.ascending("permission")
          const info: Request = { id, ...request }
          let resolvePending: (() => void) | undefined
          let rejectPending: ((e: any) => void) | undefined
          let cleanup: (() => void) | undefined
          const pendingPromise = new Promise<void>((resolve, reject) => {
            resolvePending = () => {
              cleanup?.()
              resolve()
            }
            rejectPending = (error) => {
              cleanup?.()
              reject(error)
            }
            if (signal) {
              const onAbort = () => {
                const pending = s.pending[id]
                if (!pending) return
                delete s.pending[id]
                Bus.publish(Event.Replied, {
                  sessionID: pending.info.sessionID,
                  requestID: pending.info.id,
                  reply: "reject",
                })
                pending.reject(new DOMException("The operation was aborted", "AbortError"))
              }
              if (signal.aborted) {
                onAbort()
                return
              }
              signal.addEventListener("abort", onAbort, { once: true })
              cleanup = () => signal.removeEventListener("abort", onAbort)
            }
          })
          s.pending[id] = { info, resolve: resolvePending!, reject: rejectPending!, cleanup }

          if (request.metadata?.sessionInteractionMode === "unattended" && !isNonBypassable(request)) {
            log.info("unattended auto-approve", {
              sessionID: request.sessionID,
              permission: request.permission,
              pattern,
            })
            delete s.pending[id]
            resolvePending!()
            continue
          }
          Bus.publish(Event.Asked, info)
          return pendingPromise
        }
        // allow and not nonBypassable → auto-resolve; continue to next pattern
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
      if (input.reply === "session" || input.reply === "always") {
        for (const pattern of existing.info.patterns) {
          const rule = {
            permission: existing.info.permission,
            pattern,
            action: "allow" as const,
          }
          if (input.reply === "session") {
            PermissionRules.addSessionRule(existing.info.sessionID, rule)
          } else {
            await PermissionRules.addUserRule(rule)
          }
        }
        existing.resolve()
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

  /**
   * Reject all pending permission entries for the given session.
   * Called by SessionInvoke.cancel() to prevent orphaned permissions
   * that would otherwise leave the tool suspended forever.
   */
  export async function clearForSession(sessionID: string) {
    const s = await state()
    for (const [id, pending] of Object.entries(s.pending)) {
      if (pending.info.sessionID === sessionID) {
        delete s.pending[id]
        Bus.publish(Event.Replied, {
          sessionID: pending.info.sessionID,
          requestID: pending.info.id,
          reply: "reject",
        })
        pending.reject(new DOMException("Session was cancelled", "AbortError"))
      }
    }
  }

  export function requestMetadata(input?: { interaction?: SessionInteraction.Info }) {
    if (!input?.interaction) return {}
    return {
      sessionInteractionMode: input.interaction.mode,
      sessionInteractionSource: input.interaction.source,
    }
  }

  export async function list() {
    return state().then((x) => Object.values(x.pending).map((x) => x.info))
  }
}
