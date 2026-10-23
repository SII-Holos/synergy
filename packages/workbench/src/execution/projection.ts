import type { Server } from "@ericsanchezok/synergy-server/server/server"
import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { applyProjectionPatch, projectionPatch } from "@ericsanchezok/synergy-util/projection-patch"
import { ExecutionService } from "./service"
import { ExecutionSchema } from "./schema"
import { z } from "zod"

export namespace ExecutionProjection {
  const checkpoints = RuntimeContext.state(
    () =>
      new Map<
        string,
        { sessionID: string; scopeID: string } & (
          { summary: ExecutionSchema.Summary } | { projection: ExecutionSchema.Projection }
        )
      >(),
  )
  export function checkpoint(sessionID: string, token: string) {
    const value = checkpoints().get(token)
    if (
      !value ||
      !("summary" in value) ||
      value.sessionID !== sessionID ||
      value.scopeID !== ScopeContext.current.scope.id
    )
      throw new Storage.NotFoundError({ message: "Execution checkpoint expired" })
    return value.summary
  }
  export function projectionCheckpoint(sessionID: string, token: string) {
    const value = checkpoints().get(token)
    if (
      !value ||
      !("projection" in value) ||
      value.sessionID !== sessionID ||
      value.scopeID !== ScopeContext.current.scope.id
    )
      throw new Storage.NotFoundError({ message: "Execution checkpoint expired" })
    return structuredClone(value.projection)
  }
  const Demand = z.enum(["root", "summary", "trajectory"])
  async function openDemand(...[interest, send, signal]: Parameters<Server.ViewProjectionContribution["open"]>) {
    const demands = z.array(Demand).min(1).parse(interest.demands)
    const scope = await Scope.resolve({ scopeID: interest.scopeID })
    const session = await Session.get(interest.sessionID)
    if (session.scope.id !== scope.id)
      throw new Storage.NotFoundError({ message: "Execution belongs to another Scope" })
    const controller = new AbortController()
    const abort = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
    abort.throwIfAborted()
    const trajectory = demands.includes("trajectory")
    const summary = trajectory || demands.includes("summary")
    const releases: Array<() => void> = []
    if (summary) releases.push(ExecutionService.subscribe(session.id, { trajectory }))
    let disposed = false
    let frameRevision = 0
    let token: string | undefined
    let previous: unknown
    let current: ExecutionSchema.Projection = {
      state: "root",
      sessionID: session.id,
      revision: 0,
      previousRevision: 0,
      contexts: [],
      contextTotal: 0,
    }
    const store = checkpoints()
    const dispose = () => {
      if (disposed) return
      disposed = true
      abort.removeEventListener("abort", dispose)
      controller.abort()
      for (const release of releases.splice(0)) release()
      if (token) store.delete(token)
      previous = undefined
    }
    abort.addEventListener("abort", dispose, { once: true })
    const publish = (value: ExecutionSchema.Projection) => {
      if (disposed) return
      value = ExecutionSchema.Projection.parse(value)
      current = value
      const patches = projectionPatch(previous, value)
      if (!patches.length) return
      const properties = {
        kind: "execution",
        sessionID: session.id,
        generation: interest.generation,
        revision: frameRevision + 1,
        previousRevision: frameRevision,
        patches,
        snapshot: undefined as string | undefined,
      }
      const frame = { scopeID: scope.id, payload: { type: "server.view.patch", properties } }
      if (Buffer.byteLength(JSON.stringify(frame)) > 64 * 1024) {
        if (token) store.delete(token)
        token = crypto.randomUUID()
        store.set(token, { scopeID: scope.id, sessionID: session.id, projection: structuredClone(value) })
        properties.patches = []
        properties.snapshot = token
      }
      previous = structuredClone(value)
      frameRevision++
      send(frame)
    }
    const scoped = <T>(fn: () => Promise<T>) => ScopeContext.provide({ scope, fn })
    try {
      const release = await scoped(() =>
        ExecutionService.observeRoot(
          session.id,
          (root) => {
            const selected = root.contexts.filter((context) => !interest.runID || context.runID === interest.runID)
            const visible = new Set(interest.nodeIDs)
            const contexts = selected.filter((context, index) => index < 30 || visible.has(context.nodeID))
            publish({
              ...current,
              revision: root.revision,
              previousRevision: current.revision,
              contexts,
              contextTotal: selected.length,
            })
          },
          abort,
        ),
      )
      if (disposed) release()
      else releases.push(release)
      if (summary && !disposed) {
        const releaseProgress = await scoped(() =>
          ExecutionService.observePreparation(session.id, (progress) => {
            if (current.state === "preparing") publish({ ...current, progress })
          }),
        )
        if (disposed) {
          releaseProgress()
          return { project() {}, dispose }
        }
        releases.push(releaseProgress)
        publish({ ...current, state: "preparing", progress: { stage: "metadata", prepared: 0 } })
        void scoped(async () => {
          const value = await ExecutionService.summary(session.id, undefined, abort)
          const rounds = interest.runID ? [await ExecutionService.summary(session.id, interest.runID, abort)] : []
          if (current.state === "ready" && current.summary.revision > value.revision) return
          publish({
            ...current,
            state: "ready",
            summary: value,
            detailPreviousRevision: value.revision,
            roundSummaries: rounds,
            upserts: [],
            processUpserts: [],
            processRemoved: [],
            removed: [],
          })
        }).catch((error) => {
          if (!disposed)
            publish({
              ...current,
              state: "failed",
              error: {
                kind: error instanceof Error ? error.name : "Error",
                message: "Unable to prepare execution summary",
                retryable: true,
              },
            })
        })
      }
    } catch (error) {
      dispose()
      throw error
    }
    return {
      project(event: Parameters<Awaited<ReturnType<Server.ViewProjectionContribution["open"]>>["project"]>[0]) {
        if (event.scopeID !== scope.id) return
        if (
          event.payload.type === "session.deleted" &&
          (event.payload.properties.info as Session.Info)?.id === session.id
        ) {
          dispose()
          return
        }
        if (!summary || event.payload.type !== "execution.updated" || event.payload.properties.sessionID !== session.id)
          return
        const value = ExecutionSchema.Updated.properties.parse(event.payload.properties)
        if (current.state === "ready" && value.summary.revision <= current.summary.revision) return
        const visible = interest.nodeIDs && new Set(interest.nodeIDs)
        publish({
          ...current,
          state: "ready",
          summary: value.summary,
          detailPreviousRevision: value.previousRevision ?? value.summary.revision,
          roundSummaries: value.roundSummaries.filter((round) => !interest.runID || round.runID === interest.runID),
          upserts: trajectory ? value.upserts.filter((node) => !visible || visible.has(node.id)) : [],
          processUpserts: trajectory ? (value.processUpserts ?? []) : [],
          processRemoved: trajectory ? (value.processRemoved ?? []) : [],
          removed: trajectory ? value.removed : [],
        })
      },
      dispose,
    }
  }
  export function baseline(summary: ExecutionSchema.Summary) {
    return {
      sessionID: summary.sessionID,
      revision: summary.revision,
      summary,
      roundSummaries: [],
      contextUpserts: [],
      upserts: [],
      processUpserts: [],
      processRemoved: [],
      removed: [],
      previousRevision: summary.revision,
    }
  }
  export function contribution(): Server.ViewProjectionContribution {
    return {
      kind: "execution",
      eventType: "execution.updated",
      legacy: ExecutionService.legacyClient,
      async open(interest, send, signal) {
        if (interest.demands) return openDemand(interest, send, signal)
        signal?.throwIfAborted()
        const scope = await Scope.resolve({ scopeID: interest.scopeID })
        const session = await Session.get(interest.sessionID)
        if (session.scope.id !== scope.id)
          throw new Storage.NotFoundError({ message: "Execution belongs to another Scope" })
        signal?.throwIfAborted()
        const release = ExecutionService.subscribe(session.id)
        let previous: unknown,
          revision = 0,
          token: string | undefined,
          disposed = false
        const store = checkpoints()
        const dispose = () => {
          if (disposed) return
          disposed = true
          signal?.removeEventListener("abort", dispose)
          release()
          if (token) store.delete(token)
          previous = undefined
        }
        signal?.addEventListener("abort", dispose, { once: true })
        const publish = (value: Record<string, unknown>) => {
          if (disposed) return
          const patches = projectionPatch(previous, value)
          if (!patches.length) return
          const properties = {
            kind: "execution",
            sessionID: session.id,
            generation: interest.generation,
            revision: revision + 1,
            previousRevision: revision,
            patches,
            snapshot: undefined as string | undefined,
          }
          const frame = { scopeID: scope.id, payload: { type: "server.view.patch", properties } }
          if (Buffer.byteLength(JSON.stringify(frame)) > 64 * 1024) {
            const summary = value.summary as ExecutionSchema.Summary
            if (token) store.delete(token)
            token = crypto.randomUUID()
            const snapshot = structuredClone(summary)
            store.set(token, { scopeID: scope.id, sessionID: session.id, summary: snapshot })
            previous = baseline(snapshot)
            properties.patches = []
            properties.snapshot = token
          } else previous = applyProjectionPatch(previous, patches)
          revision++
          send(frame)
        }
        try {
          const summary = await ScopeContext.provide({
            scope,
            fn: () => ExecutionService.summary(session.id, undefined, signal),
          })
          publish(baseline(summary))
        } catch (error) {
          dispose()
          throw error
        }
        return {
          project(event) {
            if (
              event.scopeID !== scope.id ||
              event.payload.type !== "execution.updated" ||
              event.payload.properties.sessionID !== session.id
            )
              return
            const value = event.payload.properties
            const priorRevision = (previous as { revision?: number } | undefined)?.revision ?? -1
            if (Number(value.revision) <= priorRevision) return
            const visible = interest.nodeIDs && new Set(interest.nodeIDs)
            const selected = {
              ...value,
              roundSummaries: (value.roundSummaries as ExecutionSchema.Summary[]).filter(
                (summary) => !interest.runID || summary.runID === interest.runID,
              ),
              contextUpserts: ((value.contextUpserts ?? []) as ExecutionSchema.ContextSnapshot[]).filter(
                (context) => !visible || visible.has(context.nodeID),
              ),
              upserts: (value.upserts as Array<{ id: string }>).filter((node) => !visible || visible.has(node.id)),
            }
            publish(selected)
          },
          dispose,
        }
      },
    }
  }
}
