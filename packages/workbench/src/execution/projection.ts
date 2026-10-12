import type { Server } from "@ericsanchezok/synergy-server/server/server"
import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { applyProjectionPatch, projectionPatch } from "@ericsanchezok/synergy-util/projection-patch"
import { ExecutionService } from "./service"
import { ExecutionSchema } from "./schema"

export namespace ExecutionProjection {
  const checkpoints = RuntimeContext.state(
    () => new Map<string, { sessionID: string; scopeID: string; summary: ExecutionSchema.Summary }>(),
  )
  export function checkpoint(sessionID: string, token: string) {
    const value = checkpoints().get(token)
    if (!value || value.sessionID !== sessionID || value.scopeID !== ScopeContext.current.scope.id)
      throw new Storage.NotFoundError({ message: "Execution checkpoint expired" })
    return value.summary
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
            fn: () => ExecutionService.summary(session.id),
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
