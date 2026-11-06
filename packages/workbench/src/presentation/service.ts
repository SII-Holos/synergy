import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { createHash } from "node:crypto"
import type { Server } from "@ericsanchezok/synergy-server/server/server"
import { ResourceReference } from "@ericsanchezok/synergy-util/resource-reference"
import { WorkbenchView } from "@ericsanchezok/synergy-util/workbench-view"

export namespace WorkbenchPresentation {
  export const DEFAULT_TIMEOUT_SECONDS = 30
  export type Caller = {
    scopeID: string
    sessionID: string
    requestId: string
    context?: ResourceReference.Context
    signal: AbortSignal
  }
  type Attempt = {
    signature: string
    caller: Pick<Caller, "scopeID" | "sessionID" | "requestId">
    command?: WorkbenchView.Command
    target?: WorkbenchView.Target
    promise: Promise<WorkbenchView.Result>
    result?: WorkbenchView.Result
    receipt: boolean
    settle?: (outcome: WorkbenchView.Outcome) => void
    cancel?: (reason: string) => void
  }
  type Client = {
    clientId: string
    send: (frame: Server.EventClientFrame) => boolean
    targets?: Set<WorkbenchView.TargetKind>
    active?: Server.EventClientActive
    attempts: Map<string, Attempt>
    views: Map<string, WorkbenchView.View>
  }
  const state = RuntimeContext.state(() => ({
    clients: new Map<string, Client>(),
    attempts: new Map<string, Attempt>(),
    disposed: false,
  }))
  const key = (caller: Pick<Caller, "scopeID" | "sessionID" | "requestId">) =>
    JSON.stringify([caller.scopeID, caller.sessionID, caller.requestId])
  const unknown = (reason: string): WorkbenchView.Outcome => ({ status: "unknown", reason })
  function targetIdentity(target: WorkbenchView.Target): string {
    const id =
      target.kind === "note"
        ? target.id
        : target.kind === "workspace-file"
          ? target.path
          : target.kind === "browser-page"
            ? target.pageId
            : target.url
    return JSON.stringify([target.kind, id])
  }

  export function init(): () => void {
    const instance = state()
    return () => {
      if (instance.disposed) return
      instance.disposed = true
      for (const client of instance.clients.values()) {
        for (const attempt of client.attempts.values())
          attempt.cancel?.("The Runtime is closing; no receipt confirms the effect.")
        client.attempts.clear()
        client.views.clear()
      }
      instance.clients.clear()
      instance.attempts.clear()
    }
  }

  export function contribution(): Server.EventClientContribution {
    const instance = state()
    return {
      connect({ clientId, send }) {
        const client: Client = { clientId, send, attempts: new Map(), views: new Map() }
        if (!instance.disposed) instance.clients.set(clientId, client)
        let disposed = instance.disposed
        return {
          receive(payload) {
            if (disposed || instance.disposed) return
            const parsed = WorkbenchView.ClientMessage.safeParse(payload)
            if (!parsed.success) return
            const message = parsed.data
            if (message.type === "client.workbench.ready") {
              client.targets = new Set(message.properties.targets)
              for (const attempt of client.attempts.values())
                if (attempt.command?.action === "open" && !client.targets.has(attempt.command.target.kind))
                  attempt.cancel?.("The frontend no longer supports this target; no receipt confirms the effect.")
              return
            }
            if (!client.active) return
            const attempt = client.attempts.get(key({ ...client.active, requestId: message.properties.requestId }))
            if (!attempt?.settle) return
            const outcome = message.properties.outcome
            if (outcome.status === "applied") {
              const views = outcome.views ?? []
              if (new Set(views.map((view) => view.viewId)).size !== views.length) return
              const command = attempt.command
              if (!command) return
              const target = attempt.target
              if (
                command.action === "open" &&
                (!target ||
                  !views.some((view) => view.visible && targetIdentity(view.target) === targetIdentity(target)))
              )
                return
              if (
                command.action === "hide" &&
                (!target ||
                  !views.some(
                    (view) =>
                      view.viewId === command.viewId &&
                      !view.visible &&
                      targetIdentity(view.target) === targetIdentity(target),
                  ))
              )
                return
              if (command.action === "status") client.views.clear()
              for (const view of views) client.views.set(view.viewId, view)
            }
            attempt.receipt = true
            attempt.settle(outcome)
          },
          active(active) {
            if (disposed || instance.disposed) return
            const previous = client.active
            client.active = active
            if (
              previous?.scopeID === active?.scopeID &&
              previous?.sessionID === active?.sessionID &&
              previous?.generation === active?.generation
            )
              return
            for (const attempt of client.attempts.values())
              attempt.cancel?.("The frontend changed its active view; no receipt confirms the effect.")
            client.views.clear()
          },
          dispose() {
            if (disposed) return
            disposed = true
            instance.clients.delete(clientId)
            for (const attempt of client.attempts.values()) {
              attempt.settle?.(unknown("The frontend disconnected; no receipt confirms the effect."))
              attempt.receipt = false
              attempt.result = {
                requestId: attempt.caller.requestId,
                ...unknown("The original frontend connection is gone; its receipt is no longer retained."),
              }
              attempt.promise = Promise.resolve(attempt.result)
            }
            client.attempts.clear()
            client.views.clear()
            client.targets = undefined
            client.active = undefined
          },
        }
      },
    }
  }

  export function request(parameters: WorkbenchView.Parameters, caller: Caller): Promise<WorkbenchView.Result> {
    const instance = state()
    const { input, clientId } = parameters
    if (input.action === "status" && input.requestId) {
      const attempt = instance.attempts.get(key({ ...caller, requestId: input.requestId }))
      return Promise.resolve(
        attempt?.receipt && attempt.result
          ? attempt.result
          : { requestId: input.requestId, ...unknown("No confirmed receipt is retained for this Scope and Session.") },
      )
    }
    const signature = createHash("sha256")
      .update(JSON.stringify({ parameters, context: caller.context }))
      .digest("hex")
    const identity = { scopeID: caller.scopeID, sessionID: caller.sessionID, requestId: caller.requestId }
    const existing = instance.attempts.get(key(caller))
    if (existing)
      return existing.signature === signature
        ? existing.result
          ? Promise.resolve(existing.result)
          : existing.promise
        : Promise.resolve({
            requestId: caller.requestId,
            status: "blocked",
            reason: "This tool call identity already has different arguments; it cannot be reused.",
          })
    const immediate = (outcome: WorkbenchView.Outcome) => {
      const result = { requestId: caller.requestId, ...outcome }
      const promise = Promise.resolve(result)
      if (!instance.disposed)
        instance.attempts.set(key(caller), { caller: identity, signature, promise, result, receipt: false })
      return promise
    }
    if (caller.signal.aborted) return immediate({ status: "cancelled", reason: "Cancelled before dispatch." })
    if (instance.disposed)
      return immediate({ status: "unavailable", reason: "The Workbench presentation service is closed." })
    if (input.action === "open" && input.target.kind === "workspace-file" && caller.context?.state !== "bound")
      return immediate({
        status: "blocked",
        reason:
          "Opening a Workspace file requires the caller Session's captured valid Workspace; a viewer's Workspace cannot be used.",
      })
    let target = input.action === "open" ? input.target : undefined
    if (target?.kind === "workspace-file") {
      const relative = ResourceReference.resolvePath(target.path, caller.context ?? { state: "none" })
      if (!relative)
        return immediate({ status: "blocked", reason: "The file is not inside the caller's captured Workspace." })
      target = { ...target, path: relative }
    }
    const clients = [...instance.clients.values()].filter(
      (client) =>
        client.active?.scopeID === caller.scopeID &&
        client.active.sessionID === caller.sessionID &&
        client.targets?.size &&
        (input.action !== "open" || client.targets.has(input.target.kind)),
    )
    const selected = clientId
      ? clients.find((client) => client.clientId === clientId)
      : clients.length === 1
        ? clients[0]
        : undefined
    if (!selected) {
      if (!clientId && clients.length > 1)
        return immediate({
          status: "ambiguous",
          reason: "Multiple eligible frontends show this Session. Choose a returned clientId; nothing was dispatched.",
          clients: clients.map((client) => ({ clientId: client.clientId })),
        })
      return immediate({
        status: "unavailable",
        reason: clientId
          ? "The selected clientId is not a ready, supported frontend actively showing this Scope and Session."
          : "No ready frontend supporting this target is actively showing this Scope and Session.",
      })
    }
    if (input.action === "hide") target = selected.views.get(input.viewId)?.target
    if (input.action === "hide" && !target)
      return immediate({
        status: "blocked",
        reason: "The selected frontend has no confirmed view with this viewId. Query current views before hiding it.",
      })
    let resolve!: (result: WorkbenchView.Result) => void
    const promise = new Promise<WorkbenchView.Result>((done) => {
      resolve = done
    })
    const attempt: Attempt = { caller: identity, command: input, target, signature, promise, receipt: false }
    instance.attempts.set(key(caller), attempt)
    selected.attempts.set(key(caller), attempt)
    let timer: ReturnType<typeof setTimeout> | undefined
    const aborted = () =>
      attempt.cancel?.("Cancelled after dispatch; without a frontend receipt the effect is unknown.")
    attempt.settle = (outcome) => {
      if (!attempt.settle) return
      clearTimeout(timer)
      caller.signal.removeEventListener("abort", aborted)
      attempt.settle = undefined
      attempt.cancel = undefined
      attempt.command = undefined
      attempt.target = undefined
      attempt.result = { requestId: caller.requestId, clientId: selected.clientId, ...outcome }
      resolve(attempt.result)
    }
    attempt.cancel = (reason) => {
      attempt.settle?.(unknown(reason))
      selected.send({
        scopeID: caller.scopeID,
        payload: { type: "server.workbench.cancel", properties: { requestId: caller.requestId } },
      })
    }
    caller.signal.addEventListener("abort", aborted, { once: true })
    const deadline = performance.now() + (parameters.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS) * 1000
    const wait = () => {
      const remaining = deadline - performance.now()
      if (remaining <= 0) {
        attempt.cancel?.(
          "The frontend receipt window expired; the effect is unknown. Check status without replaying the command.",
        )
        return
      }
      timer = setTimeout(wait, Math.min(remaining, 2_147_483_647))
      timer.unref()
    }
    wait()
    if (!attempt.settle) return promise
    if (
      !selected.send({
        scopeID: caller.scopeID,
        payload: {
          type: "server.workbench.request",
          properties: {
            requestId: caller.requestId,
            scopeID: caller.scopeID,
            sessionID: caller.sessionID,
            command: input,
            ...(caller.context && { context: caller.context }),
          },
        },
      })
    )
      attempt.cancel?.("The request could not be confirmed as sent; without a frontend receipt the effect is unknown.")
    return promise
  }
}
