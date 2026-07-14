import { WorkflowTypes } from "./types"
import { Storage } from "../storage/storage"

/**
 * Guard predicate library. Each predicate is backed by a deterministic platform
 * fact (loop terminal state, worktree status, a recorded submission, an
 * acknowledged handoff, a resolved gate, budget). Charters may *compose* these
 * predicates but cannot invent new ones — an unknown predicate name fails
 * charter validation. There is deliberately no expression language: when a
 * charter needs a judgement these predicates cannot express, the fix is a new
 * predicate (platform code + test), not looser syntax.
 */
export namespace WorkflowGuards {
  export interface Context {
    scopeID: string
    run: WorkflowTypes.Run
    entity: WorkflowTypes.Entity
  }

  export interface Result {
    ok: boolean
    reason?: string
    retryable?: boolean
  }

  export type Predicate = (ctx: Context, args: Record<string, string>) => Promise<Result> | Result

  /**
   * Resolve an argument value. Only three prefixes are honoured; everything else
   * is a literal. This is the entire "expression" surface — intentionally tiny.
   */
  export function resolveArg(value: string, ctx: Context): string | undefined {
    if (value.startsWith("$entity.bindings.")) {
      return ctx.entity.bindings[value.slice("$entity.bindings.".length)]
    }
    if (value.startsWith("$entity.")) {
      const field = value.slice("$entity.".length)
      const raw = (ctx.entity as unknown as Record<string, unknown>)[field]
      return raw === undefined ? undefined : String(raw)
    }
    if (value.startsWith("$run.")) {
      const field = value.slice("$run.".length)
      const raw = (ctx.run as unknown as Record<string, unknown>)[field]
      return raw === undefined ? undefined : String(raw)
    }
    return value
  }

  const registry = new Map<string, Predicate>()

  export function register(name: string, predicate: Predicate): void {
    registry.set(name, predicate)
  }

  export function has(name: string): boolean {
    return registry.has(name)
  }

  export function names(): string[] {
    return [...registry.keys()]
  }

  export async function evaluate(name: string, ctx: Context, args: Record<string, string>): Promise<Result> {
    const predicate = registry.get(name)
    if (!predicate) return { ok: false, reason: `unknown predicate '${name}'` }
    return predicate(ctx, args)
  }

  export async function evaluateAll(ctx: Context, refs: WorkflowTypes.PredicateRef[]): Promise<Result> {
    for (const ref of refs) {
      const result = await evaluate(ref.name, ctx, ref.args)
      if (!result.ok) {
        return {
          ok: false,
          reason: `${ref.name}: ${result.reason ?? "failed"}`,
          retryable: result.retryable,
        }
      }
    }
    return { ok: true }
  }

  // --- Built-in predicates -------------------------------------------------

  register("loop_terminal", async (ctx, args) => {
    const loopID = resolveArg(args.loopID ?? "$entity.bindings.loopID", ctx)
    if (!loopID) return { ok: false, reason: "no loopID bound" }
    const { BlueprintLoopStore } = await import("../blueprint/loop-store")
    const loop = await BlueprintLoopStore.get(ctx.scopeID, loopID).catch((error) => {
      if (error instanceof Storage.NotFoundError) return undefined
      throw error
    })
    if (!loop) return { ok: false, reason: `loop ${loopID} not found` }
    const wanted = args.status ?? "completed"
    if (loop.status !== wanted) return { ok: false, reason: `loop is ${loop.status}, not ${wanted}` }
    return { ok: true }
  })

  register("submission_recorded", (ctx, args) => {
    const kind = args.kind
    const verdict = args.verdict
    const fresh = args.fresh === "true"
    const since = fresh ? ctx.entity.time.stateEntered : 0
    const match = ctx.entity.submissions.find(
      (s) => (!kind || s.kind === kind) && (!verdict || s.verdict === verdict) && s.time >= since,
    )
    if (!match) {
      return {
        ok: false,
        reason: `no ${fresh ? "fresh " : ""}submission (kind=${kind ?? "any"}, verdict=${verdict ?? "any"})`,
      }
    }
    return { ok: true }
  })

  register("handoff_acked", async (ctx, args) => {
    const handoffID = resolveArg(args.handoffID ?? "$entity.pendingHandoffID", ctx) ?? ctx.entity.pendingHandoffID
    if (!handoffID) return { ok: false, reason: "no handoff to await" }
    const { WorkflowRunStore } = await import("./store")
    const events = await WorkflowRunStore.listEvents(ctx.scopeID, ctx.run.id)
    const acked = events.some((e) => e.kind === "handoff_acked" && e.data?.handoffID === handoffID)
    if (acked) return { ok: true }
    const { WorkflowBridge } = await import("./bridge")
    const projected = await WorkflowBridge.projectPersistedHandoffAck(
      { scopeID: ctx.scopeID, runID: ctx.run.id, entityID: ctx.entity.id, handoffID },
      { evaluate: false },
    )
    return projected ? { ok: true } : { ok: false, reason: `handoff ${handoffID} not acknowledged` }
  })

  register("worktree_clean", async (ctx, args) => {
    const seatSessionID = resolveArg(args.sessionID ?? "$entity.bindings.seatSessionID", ctx)
    if (!seatSessionID) return { ok: false, reason: "no seat session bound" }
    const { Worktree } = await import("../project/worktree")
    const status = await Worktree.status(seatSessionID).catch((error) => {
      if (error instanceof Storage.NotFoundError || error instanceof Worktree.NotFoundError) return undefined
      throw error
    })
    if (!status) return { ok: false, reason: "worktree status unavailable" }
    return status.dirty === false ? { ok: true } : { ok: false, reason: "worktree has uncommitted changes" }
  })

  register("worktree_ahead", async (ctx, args) => {
    const seatSessionID = resolveArg(args.sessionID ?? "$entity.bindings.seatSessionID", ctx)
    const baseCommit = resolveArg(args.baseCommit ?? "$entity.bindings.baseCommit", ctx)
    if (!seatSessionID) return { ok: false, reason: "no seat session bound" }
    const { Worktree } = await import("../project/worktree")
    const status = await Worktree.status(seatSessionID).catch((error) => {
      if (error instanceof Storage.NotFoundError || error instanceof Worktree.NotFoundError) return undefined
      throw error
    })
    if (!status?.path) return { ok: false, reason: "worktree status unavailable" }
    if (!baseCommit) {
      // No base to diff against — accept a recorded resultCommit as evidence.
      return ctx.entity.bindings.resultCommit
        ? { ok: true }
        : { ok: false, reason: "no base commit and no result commit recorded" }
    }
    const { $ } = await import("bun")
    const counted = await $`git rev-list --count ${baseCommit}..HEAD`.cwd(status.path).quiet().nothrow()
    const ahead = Number(counted.stdout.toString().trim())
    if (!Number.isFinite(ahead)) return { ok: false, reason: "unable to count commits ahead of base" }
    return ahead > 0 ? { ok: true } : { ok: false, reason: "no commits beyond base" }
  })

  register("session_idle", async (ctx, args) => {
    const seat = args.seat
    const binding = ctx.run.seats.find((s) => s.seat === seat && s.status === "idle")
    if (!binding) return { ok: false, reason: `no idle instance of seat '${seat}'`, retryable: true }
    return { ok: true }
  })

  // Whether the seat pool has an instance free to take new work. Unlike
  // session_idle this also accepts never-yet-used ("unbound") instances, so the
  // first entity to reach a seat can be assigned before any session exists.
  register("seat_available", (ctx, args) => {
    const seat = args.seat
    const free = ctx.run.seats.some((s) => s.seat === seat && (s.status === "idle" || s.status === "unbound"))
    return free ? { ok: true } : { ok: false, reason: `no free instance of seat '${seat}'`, retryable: true }
  })

  register("gate_resolved", (ctx, args) => {
    const gateName = args.gate
    const accept = (args.accept ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
    const gate = [...ctx.run.gates]
      .reverse()
      .find((g) => g.gate === gateName && g.entityID === ctx.entity.id && g.status === "resolved")
    if (!gate) return { ok: false, reason: `gate '${gateName}' not resolved` }
    if (accept.length > 0 && (!gate.resolution || !accept.includes(gate.resolution))) {
      return { ok: false, reason: `gate resolution '${gate.resolution}' not in [${accept.join(",")}]` }
    }
    return { ok: true }
  })

  register("budget_available", (ctx) => {
    const { maxModelCalls, used } = ctx.run.budget
    if (maxModelCalls === 0) return { ok: true }
    return used < maxModelCalls ? { ok: true } : { ok: false, reason: "model-call budget exhausted" }
  })

  register("note_exists", async (ctx, args) => {
    const noteID = resolveArg(args.noteID ?? "", ctx)
    if (!noteID) return { ok: false, reason: "no note id" }
    const { NoteStore } = await import("../note")
    const note = await NoteStore.getAny(ctx.scopeID, noteID).catch((error) => {
      if (error instanceof Storage.NotFoundError) return undefined
      throw error
    })
    return note ? { ok: true } : { ok: false, reason: `note ${noteID} missing` }
  })
}
