import { createEffect, createMemo, onCleanup, untrack } from "solid-js"
import type { ResourceOpenController } from "@ericsanchezok/synergy-ui/context/resource-open"
import { useDialog } from "@ericsanchezok/synergy-ui/context/dialog"
import { WorkbenchView } from "@ericsanchezok/synergy-util/workbench-view"
import { AssetReference } from "@ericsanchezok/synergy-util/asset-reference"
import { useGlobalSDK } from "./global-sdk"
import { useSDK } from "@/context/sdk"
import { useParams } from "@/context/session-route"
import { useViewActivity } from "./view-residency"
import { useWorkbenchPanels } from "@/context/workbench"
import { useLayout } from "@/context/layout"
import { usePlatform } from "./platform"
import { workspacePresentation } from "./layout/workspace"
import { workspaceFileOwner, workspaceFilePath } from "./file/workspace"
import { useProjectFiles } from "@/context/file"
import { useNoteDocuments } from "@/components/note/documents"
import { useBrowserCatalog } from "@/components/workspace/browser/browser-catalog"
import { browserWorkbenchRoute } from "@/components/workspace/browser/browser-workbench-model"

const advertisements = new WeakMap<object, object>()

export function createWorkbenchViewExecutor(resources: ResourceOpenController) {
  const globalSDK = useGlobalSDK()
  if (!globalSDK.clientMessages || !resources.present) return
  const sdk = useSDK()
  const params = useParams()
  const active = useViewActivity()
  const workbench = useWorkbenchPanels()
  const layout = useLayout()
  const platform = usePlatform()
  const dialog = useDialog()
  const files = useProjectFiles()
  const notes = useNoteDocuments()
  const browser = useBrowserCatalog()
  const requests = new Map<string, { fingerprint: string; abort: AbortController; outcome?: WorkbenchView.Outcome }>()
  const known = new Map<string, string>()
  const owner = createMemo(() => {
    const interest = globalSDK.content.current().active
    return active() && params.id && interest?.scopeID === sdk.scopeID && interest.sessionID === params.id
      ? JSON.stringify([sdk.url, sdk.scopeID, params.id])
      : undefined
  })
  const targets = createMemo<WorkbenchView.TargetKind[]>(
    () => {
      if (!owner() || !globalSDK.connected()) return []
      const result: WorkbenchView.TargetKind[] = []
      if (workbench.getPanel("notes")) result.push("note")
      if (workbench.getPanel("file")) result.push("workspace-file")
      if (workbench.getPanel("browser") && platform.browserNative) result.push("browser-page")
      if (workbench.getPanel("attachment")) result.push("asset")
      return result
    },
    [],
    { equals: (left, right) => JSON.stringify(left) === JSON.stringify(right) },
  )
  createEffect(() => {
    const boundOwner = owner()
    const connected = globalSDK.connected()
    globalSDK.connectionGeneration()
    if (!boundOwner || !connected) return
    onCleanup(() => {
      for (const request of requests.values()) if (!request.outcome) request.abort.abort("superseded")
      known.clear()
    })
  })
  createEffect(() => {
    globalSDK.connectionGeneration()
    const connected = globalSDK.connected()
    if (!connected) {
      for (const request of requests.values()) request.abort.abort("cancelled")
      requests.clear()
      known.clear()
    }
  })
  createEffect(() => {
    const supported = targets()
    globalSDK.connectionGeneration()
    if (!supported.length) return
    const advertisement = {}
    advertisements.set(globalSDK, advertisement)
    globalSDK.clientMessages.send({
      type: "client.workbench.ready",
      properties: { version: WorkbenchView.VERSION, targets: supported },
    } satisfies WorkbenchView.ClientMessage)
    onCleanup(() => {
      if (advertisements.get(globalSDK) !== advertisement) return
      advertisements.delete(globalSDK)
      globalSDK.clientMessages.send({
        type: "client.workbench.ready",
        properties: { version: WorkbenchView.VERSION, targets: [] },
      } satisfies WorkbenchView.ClientMessage)
    })
  })
  const snapshot = (): WorkbenchView.View[] => {
    const result: WorkbenchView.View[] = []
    for (const surface of ["side", "bottom"] as const) {
      const state = workbench.surface(surface)
      for (const tab of state.savedTabs()) {
        let target: WorkbenchView.Target | undefined
        let contentState: WorkbenchView.View["contentState"] = "loading"
        if (tab.panelId === "notes" && tab.resourceId && tab.source) {
          target = { kind: "note", id: tab.resourceId }
          const document = notes.peek(tab.source, tab.resourceId)
          if (document?.deleted() || document?.error()) contentState = "unavailable"
          else if (document?.base()) contentState = "ready"
        }
        if (tab.panelId === "file" && tab.resourceId) {
          const workspace = workspaceFileOwner(tab)
          if (!workspace) continue
          const path = workspaceFilePath(tab.resourceId)
          target = { kind: "workspace-file", path }
          const document = files.peek(workspace, path)
          if (document?.deleted || document?.error) contentState = "unavailable"
          else if (document?.content && !document.loading && !document.stale) contentState = "ready"
        }
        if (tab.panelId === "browser" && tab.resourceId) {
          target = { kind: "browser-page", pageId: tab.resourceId }
          const route = browserWorkbenchRoute(tab.state)
          const catalog = route && browser.peek(route)
          const page = catalog?.store.session.pages.find((page) => page.id === tab.resourceId)
          if (!page || page.status !== "active" || page.navigation?.phase === "failed") contentState = "unavailable"
          else if (page.navigation?.phase === "completed") contentState = "ready"
        }
        if (tab.panelId === "attachment" && tab.resourceId && AssetReference.parse(tab.resourceId))
          target = { kind: "asset", url: tab.resourceId }
        if (!target) continue
        const supported = !!workbench.panelForTab(tab) && (tab.panelId !== "browser" || !!platform.browserNative)
        result.push({
          viewId: tab.id,
          target,
          surface,
          visible: supported && !!owner() && state.opened() && state.active() === tab.id,
          contentState: supported ? contentState : "unavailable",
        })
      }
    }
    return result
  }
  const resourceIdentities = () =>
    new Map(
      (["side", "bottom"] as const).flatMap((surface) =>
        workbench
          .surface(surface)
          .savedTabs()
          .map((tab) => [tab.id, JSON.stringify([surface, tab.panelId, tab.source, tab.resourceId])] as const),
      ),
    )
  const publishSnapshot = () => {
    const views = snapshot()
    const identities = resourceIdentities()
    for (const view of views) known.set(view.viewId, JSON.stringify([view.target, identities.get(view.viewId)]))
    return views
  }
  const blocked = () => {
    if (dialog.active) return "A dialog currently requires user attention."
    const side = workbench.surface("side")
    if (
      workspacePresentation(window.innerWidth - layout.sidebar.occupiedWidth(), side.size(), side.fullscreen()).overlay
    )
      return "Opening this resource requires a modal Workspace."
    if (document.activeElement instanceof Element && document.activeElement.closest('[data-ui-part="resource-panel"]'))
      return "Keyboard focus is inside the current resource."
  }
  const unsubscribe = globalSDK.clientMessages.subscribe((payload, reply) => {
    const parsed = WorkbenchView.ServerMessage.safeParse(payload)
    if (!parsed.success) return
    if (parsed.data.type === "server.workbench.cancel") {
      requests.get(parsed.data.properties.requestId)?.abort.abort("cancelled")
      return
    }
    const request = parsed.data.properties
    if (!owner() || !globalSDK.connected() || request.scopeID !== sdk.scopeID || request.sessionID !== params.id) return
    const send = (outcome: WorkbenchView.Outcome) =>
      reply({
        type: "client.workbench.receipt",
        properties: { requestId: request.requestId, outcome },
      } satisfies WorkbenchView.ClientMessage)
    const fingerprint = JSON.stringify(request)
    const previous = requests.get(request.requestId)
    if (previous) {
      if (previous.fingerprint !== fingerprint)
        send({ status: "blocked", reason: "The request ID was reused with different arguments." })
      else if (previous.outcome) send(previous.outcome)
      return
    }
    const entry = { fingerprint, abort: new AbortController(), outcome: undefined as WorkbenchView.Outcome | undefined }
    requests.set(request.requestId, entry)
    const finish = (outcome: WorkbenchView.Outcome) => {
      if (entry.outcome) return
      entry.outcome = outcome
      send(outcome)
    }
    const abort = () => finish({ status: entry.abort.signal.reason === "superseded" ? "superseded" : "cancelled" })
    entry.abort.signal.addEventListener("abort", abort, { once: true })
    const run = async (): Promise<WorkbenchView.Outcome> => {
      const command = request.command
      if (command.action === "status") {
        const previous = command.requestId ? requests.get(command.requestId) : undefined
        return {
          ...(command.requestId
            ? (previous?.outcome ?? { status: "unknown" as const })
            : { status: "applied" as const }),
          views: publishSnapshot(),
        }
      }
      const reason = blocked()
      if (reason) return { status: "blocked", reason }
      if (command.action === "hide") {
        const view = snapshot().find((view) => view.viewId === command.viewId)
        if (!view || !known.has(command.viewId))
          return { status: "unavailable", reason: "The view ID is not in this client's current snapshot." }
        if (
          known.get(command.viewId) !== JSON.stringify([view.target, resourceIdentities().get(view.viewId)]) ||
          !view.visible
        )
          return { status: "superseded", views: publishSnapshot() }
        workbench.surface(view.surface).close("agent")
        return { status: "applied", views: publishSnapshot() }
      }
      const captured = owner()
      const side = workbench.surface("side")
      const bottom = workbench.surface("bottom")
      const revision = side.selectionRevision()
      const bottomRevision = bottom.selectionRevision()
      const fullscreen = side.fullscreen()
      const current = () =>
        !entry.abort.signal.aborted &&
        owner() === captured &&
        side.selectionRevision() === revision &&
        bottom.selectionRevision() === bottomRevision &&
        side.fullscreen() === fullscreen &&
        !blocked()
      const result = await resources.present!(command.target, {
        origin: "agent",
        context: request.context,
        signal: entry.abort.signal,
        canCommit: current,
      })
      if (result.status === "opened" && result.view) {
        const views = publishSnapshot()
        if (views.some((view) => view.viewId === result.view!.viewId && view.visible))
          return { status: "applied", views }
        return { status: "unknown", reason: "The resource did not commit a selected view.", views }
      }
      if (result.status === "unavailable" || result.status === "blocked")
        return { status: result.status, reason: result.reason, views: publishSnapshot() }
      const reasonAfter = blocked()
      if (reasonAfter) return { status: "blocked", reason: reasonAfter }
      return { status: entry.abort.signal.aborted ? "cancelled" : "superseded", views: publishSnapshot() }
    }
    void untrack(run)
      .then(finish, (error: unknown) =>
        finish({
          status: "unavailable",
          reason: error instanceof Error ? error.message : "The resource view is unavailable.",
        }),
      )
      .finally(() => entry.abort.signal.removeEventListener("abort", abort))
  })
  onCleanup(() => {
    unsubscribe()
    for (const request of requests.values()) request.abort.abort("cancelled")
    requests.clear()
    known.clear()
  })
}
