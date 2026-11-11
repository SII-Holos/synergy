import { filePermissionNames } from "./file-permission"
import { Bus } from "../bus"
import { BusEvent } from "../bus/bus-event"
import { Config } from "../config/config"
import { isNonBypassableMetadata } from "../enforcement/capability"
import { Identifier } from "../id/id"
import { PermissionRules } from "./rules"
import { ScopedState } from "../scope/scoped-state"
import { ScopeContext } from "../scope/context"
import { SessionInteraction } from "../session/interaction"
import { SessionDecisionReceipts as Decisions } from "../session/decision-receipts"
import { Storage } from "../storage/storage"
import { ActorStamp } from "@ericsanchezok/synergy-util/actor-stamp"
import { RolloutExecution } from "../session/rollout/execution"
import { fn } from "../util/fn"
import { Log } from "../util/log"
import { Wildcard } from "../util/wildcard"
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
        actor: ActorStamp.Info.optional(),
      }),
    ),
  }
  function isNonBypassable(request: { metadata?: Record<string, any> }): boolean {
    return isNonBypassableMetadata(request.metadata)
  }

  const state = ScopedState.create(async () => {
    const pending: Record<
      string,
      {
        info: Request
        resolve: () => void
        reject: (e: any) => void
        cleanup?: () => void
        decision?: { receipt: Decisions.Receipt; settle: () => Promise<void> }
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

      const decisions = request.patterns.map((pattern) => evaluate(request.permission, pattern, ruleset))
      if (decisions.some((rule) => rule.action === "deny"))
        throw new DeniedError(
          ruleset.filter((r: Rule) =>
            filePermissionNames(request.permission).some((name) => Wildcard.match(name, r.permission)),
          ),
        )
      if (decisions.some((rule) => rule.action === "ask" || (rule.action === "allow" && isNonBypassable(request)))) {
        const id = input.id ?? Identifier.ascending("permission")
        if (s.pending[id]) throw new Error("Native permission request identity is already pending")
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
        const ready = Decisions.read({ sessionID: info.sessionID, requestID: id, kind: "permission" }).then((prior) => {
          if (prior) throw new Error("Native permission request is already resolved")
        })
        const entry = { info, resolve: resolvePending!, reject: rejectPending!, cleanup }
        s.pending[id] = entry

        return RolloutExecution.wait(() => {
          void ready.then(
            () => {
              if (s.pending[id] === entry) Bus.publish(Event.Asked, info)
            },
            (error) => {
              if (s.pending[id] !== entry) return
              delete s.pending[id]
              entry.reject(error)
            },
          )
          return pendingPromise
        })
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
      const first = s.pending[input.requestID]
      if (!first) return
      await decide({ ...input, sessionID: first.info.sessionID })
    },
  )

  export async function decide(input: {
    sessionID: string
    requestID: string
    reply: Reply
    message?: string
    actor?: ActorStamp.Info
  }): Promise<Decisions.Result> {
    const s = await state()
    const scope = ScopeContext.current.scope
    return Storage.transaction(async () => {
      const prior = await reconcile(input)
      if (prior) return { status: "already_resolved", receipt: prior }
      const existing = s.pending[input.requestID]
      if (!existing || existing.info.sessionID !== input.sessionID) return { status: "expired" }
      const selected =
        input.reply === "reject"
          ? Object.values(s.pending).filter((pending) => pending.info.sessionID === input.sessionID)
          : [existing]
      if (input.reply === "always")
        await PermissionRules.addUserRules(
          existing.info.patterns.map((pattern) => ({
            permission: existing.info.permission,
            pattern,
            action: "allow",
          })),
        )
      const receipt = await Decisions.record({
        sessionID: input.sessionID,
        requestID: input.requestID,
        actor: input.actor,
        outcome: { kind: "permission", reply: input.reply },
      })
      const decisions = [{ pending: existing, receipt }]
      for (const pending of selected) {
        if (pending !== existing)
          decisions.push({
            pending,
            receipt: await Decisions.record({
              sessionID: input.sessionID,
              requestID: pending.info.id,
              actor: input.actor,
              outcome: { kind: "permission", reply: "reject", causedBy: input.requestID },
            }),
          })
      }
      const settle = () =>
        ScopeContext.provide({
          scope,
          workspace: null,
          fn: () => {
            if (input.reply === "session" && s.pending[input.requestID] === existing)
              for (const pattern of existing.info.patterns)
                PermissionRules.addSessionRule(input.sessionID, {
                  permission: existing.info.permission,
                  pattern,
                  action: "allow",
                })
            for (const pending of selected) {
              if (s.pending[pending.info.id] !== pending) continue
              delete s.pending[pending.info.id]
              if (input.reply === "reject")
                pending.reject(
                  pending === existing && input.message ? new CorrectedError(input.message) : new RejectedError(),
                )
              else pending.resolve()
              Bus.publish(Event.Replied, {
                sessionID: input.sessionID,
                requestID: pending.info.id,
                reply: pending === existing ? input.reply : "reject",
                actor: input.actor,
              })
            }
          },
        })
      for (const { pending, receipt } of decisions) pending.decision = { receipt, settle }
      await Storage.transaction(
        async () => {
          Storage.afterCommit(settle)
        },
        {
          commitGuard() {
            if (selected.some((pending) => s.pending[pending.info.id] !== pending))
              throw new DOMException("Native permission request expired before commit", "AbortError")
          },
        },
      )
      return { status: "resolved", receipt }
    })
  }

  export async function reconcile(input: { sessionID: string; requestID: string }) {
    const s = await state()
    return Storage.transaction(async () => {
      const prior = await Decisions.read({ ...input, kind: "permission" })
      const candidate = s.pending[input.requestID]?.decision
      if (prior && candidate && JSON.stringify(candidate.receipt) === JSON.stringify(prior))
        Storage.afterCommit(() => {
          if (prior.outcome.kind === "permission" && prior.outcome.reply === "always")
            PermissionRules.invalidateUserRules()
          return candidate.settle()
        })
      return prior
    })
  }

  export function evaluate(permission: string, pattern: string, ...rulesets: Ruleset[]): Rule {
    const merged = merge(...rulesets)
    log.debug("evaluate", { permission, patternLength: pattern.length, rulesetCount: merged.length, mirror: true })
    const match = merged.findLast(
      (rule) =>
        filePermissionNames(permission).some((name) => Wildcard.match(name, rule.permission)) &&
        Wildcard.match(pattern, rule.pattern),
    )
    return match ?? { action: "ask", permission, pattern: "*" }
  }

  export function disabled(tools: string[], ruleset: Ruleset): Set<string> {
    const result = new Set<string>()
    for (const tool of tools) {
      const rule = ruleset.findLast((r) => filePermissionNames(tool).some((name) => Wildcard.match(name, r.permission)))
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

  export async function list() {
    return state().then((x) => Object.values(x.pending).map((x) => x.info))
  }

  export async function resolveAllForSessions(sessionIDs: string[]): Promise<number> {
    const s = await state()
    const set = new Set(sessionIDs)
    let count = 0
    for (const [id, pending] of Object.entries(s.pending)) {
      if (!set.has(pending.info.sessionID)) continue
      if (isNonBypassable(pending.info)) continue
      delete s.pending[id]
      Bus.publish(Event.Replied, {
        sessionID: pending.info.sessionID,
        requestID: pending.info.id,
        reply: "once",
      })
      pending.resolve()
      count++
    }
    return count
  }
}
