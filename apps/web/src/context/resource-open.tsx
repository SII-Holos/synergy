import { toolFeatureAvailable, toolRequiredFeatures } from "@ericsanchezok/synergy-ui/tool-result-presentation"
import { useGlobalSDK } from "./global-sdk"
import { ResourceReference } from "@ericsanchezok/synergy-util/resource-reference"
import { AssetReference } from "@ericsanchezok/synergy-util/asset-reference"
import { catalogFileWorkspace, workspaceFileResource } from "./file/workspace"
import { createWorkbenchViewExecutor } from "./workbench-view"
import type { WorkbenchView } from "@ericsanchezok/synergy-util/workbench-view"
import { buildWorkspaceFileBrowserUrl } from "@/utils/workspace-file-url"
import { generateUUID } from "@ericsanchezok/synergy-util/uuid"
import { useNoteDocuments } from "@/components/note/documents"
import { noteReferenceExcerpt, resolveNoteReference } from "./note-reference"
import { createResourcePreviewCache } from "./resource-preview-cache"
import { fileWriteErrorMessage } from "./file/errors"
import { usePlatform } from "./platform"
import {
  BROWSER_PROTOCOL_VERSION,
  BrowserNativePresentationCapabilityResultSchema,
  type BrowserNativePresentationCapabilityResult,
} from "@ericsanchezok/synergy-browser-core"
import { Dialog } from "@ericsanchezok/synergy-ui/dialog"
import { List } from "@ericsanchezok/synergy-ui/list"
import { usePluginHost } from "@/plugin/host"
import { useParams } from "@/context/session-route"
import { toolReviewSource } from "./tool-review-target"
import { createEffect, createSignal, lazy, Suspense, onCleanup, onMount, type ParentProps } from "solid-js"
import { useLingui } from "@lingui/solid"
import { showToast } from "@ericsanchezok/synergy-ui/toast"
import { copyTextToClipboard } from "@ericsanchezok/synergy-ui/clipboard"
import {
  ResourceOpenProvider as BaseResourceOpenProvider,
  type OpenableResource,
  type ResourceOpenResult,
  type ResourceOpenOptions,
  type ResourcePreview,
  type ToolReviewTarget,
  type ToolActivityTarget,
  type ActivityDetailTarget,
} from "@ericsanchezok/synergy-ui/context/resource-open"
import { ImagePreview, type ImagePreviewImage } from "@ericsanchezok/synergy-ui/image-preview"
import {
  attachmentCopyReference,
  attachmentFromReference,
  attachmentReferenceContext,
  attachmentSourcePath,
  isImageAttachment,
  resolveAttachmentOpenTarget,
  resolveAttachmentUrl,
  resolveImagePreviewImage,
  type AttachmentFile,
} from "@ericsanchezok/synergy-ui/attachment-card"
import { useDialog } from "@ericsanchezok/synergy-ui/context/dialog"
import { createSessionDataView } from "@ericsanchezok/synergy-ui/context/session-data-view"
import { useFile, useProjectFiles } from "@/context/file"
import { useSDK } from "@/context/sdk"
import { useWorkbenchPanels } from "@/context/workbench"
import { attachmentWorkbenchPanelInit } from "@/components/attachment-workbench/model"
import { classifyResourcePreview } from "@/components/resource-preview"
import { executionDetailState } from "@/components/session/execution-detail-model"
import type { ToolPart } from "@ericsanchezok/synergy-sdk/client"
import { supportsToolResource, toolResourceTarget } from "./tool-resource-target"
import { sameWorkbenchResource } from "./workbench/panel-model"
import type { WorkbenchPanelTab } from "@/plugin/registries/workbench-panel-registry"
import { useSync } from "@/context/sync"
import { draftTransitionKey, useSessionTransition } from "@/context/session-transition"
import { isOptimisticMessagePending } from "./session-optimistic-message"
import { useBrowserCatalog } from "@/components/workspace/browser/browser-catalog"
import {
  browserWorkbenchRoute,
  browserPageTab,
  browserURLTitle,
  sameBrowserCatalog,
  type BrowserWorkbenchRoute,
} from "@/components/workspace/browser/browser-workbench-model"

const DraftAttachmentPreview = lazy(() =>
  import("@/components/attachment-workbench/draft-preview").then((module) => ({
    default: module.DraftAttachmentPreview,
  })),
)

function stripQueryAndHash(input: string) {
  const hashIndex = input.indexOf("#")
  const queryIndex = input.indexOf("?")
  if (hashIndex !== -1 && queryIndex !== -1) return input.slice(0, Math.min(hashIndex, queryIndex))
  if (hashIndex !== -1) return input.slice(0, hashIndex)
  if (queryIndex !== -1) return input.slice(0, queryIndex)
  return input
}

function attachmentPath(file: AttachmentFile) {
  const target = file.url ? ResourceReference.parse(file.url) : undefined
  return attachmentSourcePath(file) ?? (target?.kind === "workspace-file" ? target.path : undefined)
}

function filenameFor(resource: { filename?: string; url?: string; path?: string }) {
  if (resource.filename) return resource.filename
  const value = resource.path ?? resource.url
  if (!value) return "file"
  return stripQueryAndHash(value).split("/").filter(Boolean).at(-1) ?? "file"
}

function previewableImageUrl(input: { url: string; mime?: string }): string | undefined {
  if (input.url.startsWith("data:")) return input.url.startsWith("data:image/") ? input.url : undefined
  if (input.url.startsWith("blob:")) return input.url
  try {
    const url = new URL(input.url)
    return url.protocol === "http:" || url.protocol === "https:" ? input.url : undefined
  } catch {
    return undefined
  }
}

function previewImageForUrl(input: { url: string; mime?: string; filename?: string }): ImagePreviewImage | undefined {
  const src = previewableImageUrl(input)
  if (!src) return undefined
  const filename = filenameFor(input)
  return {
    id: src,
    src,
    filename,
    mime: input.mime ?? "image/*",
    alt: filename,
    downloadUrl: src,
    externalUrl: /^https?:/i.test(src) ? src : undefined,
  }
}

export function ResourceOpenProvider(props: ParentProps) {
  const dialog = useDialog()
  const showResourceDialog: typeof dialog.show = (content, onClose) =>
    dialog.show(() => <BaseResourceOpenProvider value={controller}>{content()}</BaseResourceOpenProvider>, onClose)
  const file = useFile()
  const projectFiles = useProjectFiles()
  const platform = usePlatform()
  let resourceRequest: AbortController | undefined
  const sdk = useSDK()
  const globalSDK = useGlobalSDK()
  const sync = useSync()
  const canonicalView = createSessionDataView(sync.data)
  const transitions = useSessionTransition()
  const workbench = useWorkbenchPanels()
  const plugins = usePluginHost()
  const params = useParams()
  const browserCatalog = useBrowserCatalog()
  const noteDocuments = useNoteDocuments()
  const previewCache = createResourcePreviewCache<ResourcePreview>()
  const notePreviewTargets = createResourcePreviewCache<Awaited<ReturnType<typeof resolveNoteReference>>>()
  let nativeCapability:
    | {
        bridge: NonNullable<typeof platform.browserNative>
        serverUrl: string
        selection: ReturnType<typeof globalSDK.capabilities.current>
        value?: BrowserNativePresentationCapabilityResult
        pending: Promise<BrowserNativePresentationCapabilityResult>
      }
    | undefined
  const readNativeCapability = (bridge: NonNullable<typeof platform.browserNative>) => {
    const serverUrl = sdk.url
    const selection = globalSDK.capabilities.current()
    if (
      nativeCapability?.bridge === bridge &&
      nativeCapability.serverUrl === serverUrl &&
      nativeCapability.selection === selection
    )
      return nativeCapability.value ?? nativeCapability.pending
    const entry = {
      bridge,
      serverUrl,
      selection,
      value: undefined as BrowserNativePresentationCapabilityResult | undefined,
      pending: bridge.presentationCapability({ protocolVersion: BROWSER_PROTOCOL_VERSION, serverUrl }),
    }
    nativeCapability = entry
    void entry.pending.then(
      (value) => {
        const result = BrowserNativePresentationCapabilityResultSchema.safeParse(value)
        if (result.success && !result.data.error && result.data.managedLocal && result.data.status === "ready")
          entry.value = result.data
        else if (nativeCapability === entry) nativeCapability = undefined
      },
      () => {
        if (nativeCapability === entry) nativeCapability = undefined
      },
    )
    return entry.pending
  }
  createEffect(() => {
    const bridge = platform.browserNative
    if (globalSDK.capabilities.has("browser") && bridge)
      void Promise.resolve(readNativeCapability(bridge)).catch(() => undefined)
  })
  const [previewEpoch, setPreviewEpoch] = createSignal(0)
  const ownerKey = () => JSON.stringify([sdk.url, sdk.scopeKey, params.id])
  const contextKey = () => JSON.stringify([ownerKey(), previewEpoch(), workbench.surface("side").selectionRevision()])
  let pending: AbortController | undefined
  const [resourceSelection, setResourceSelection] = createSignal<{
    owner: string
    target: ToolActivityTarget
    tab: Pick<WorkbenchPanelTab, "id" | "panelId" | "resourceId" | "source">
  }>()
  createEffect(() => {
    ownerKey()
    globalSDK.capabilities.current()
    previewCache.clear()
    notePreviewTargets.clear()
    setPreviewEpoch((epoch) => epoch + 1)
    pending?.abort()
    resourceRequest?.abort()
    setResourceSelection(undefined)
  })
  onCleanup(() => {
    pending?.abort()
    resourceRequest?.abort()
    previewCache.clear()
    notePreviewTargets.clear()
  })
  onCleanup(
    globalSDK.event.listen(({ details }) => {
      if (!["note.updated", "note.deleted", "file.watcher.updated", "workspace.updated"].includes(details.type)) return
      previewCache.clear()
      notePreviewTargets.clear()
      setPreviewEpoch((epoch) => epoch + 1)
    }),
  )
  const { _ } = useLingui()
  const [openedResource, setOpenedResource] = createSignal<{
    session: string
    tabID: string
    origin?: () => HTMLElement | undefined
  }>()
  let disposed = false
  let draftDialog: string | undefined
  onCleanup(() => {
    disposed = true
    if (draftDialog) dialog.close(draftDialog)
  })
  createEffect(() => {
    const opened = openedResource()
    if (!opened) return
    if (!workbench.isCurrent(opened.session)) {
      setOpenedResource(undefined)
      return
    }
    const side = workbench.surface("side")
    if (side.opened() && side.tabs().some((tab) => tab.id === opened.tabID)) return
    setOpenedResource(undefined)
    queueMicrotask(() => {
      const origin = opened.origin?.()
      if (origin?.isConnected) origin.focus({ preventScroll: true })
    })
  })

  const openAttachmentPanel = async (
    attachment: AttachmentFile,
    init: NonNullable<ReturnType<typeof attachmentWorkbenchPanelInit>>,
    options?: ResourceOpenOptions,
  ) => {
    const session = workbench.sessionKey()
    const owner = ownerKey()
    const origin = document.activeElement instanceof HTMLElement ? document.activeElement : undefined
    const side = workbench.surface("side")
    const selectionRevision = side.selectionRevision()
    if (options?.signal?.aborted) return false
    const tab = await workbench.openPanel("attachment", {
      canCommit: () =>
        !disposed &&
        !options?.signal?.aborted &&
        options?.canCommit?.() !== false &&
        ownerKey() === owner &&
        side.selectionRevision() === selectionRevision,
      intent: options?.origin,
      reuseExisting: options?.origin !== "agent" && !options?.newTab,
      forceNew: options?.newTab,
      init: {
        ...init,
        state: {
          ...(init.state as object),
          referenceContext: options?.context,
          location: options?.location,
          navigation: Date.now(),
        },
      },
    })
    if (disposed || options?.signal?.aborted || ownerKey() !== owner || !workbench.isCurrent(session)) return false
    if (!tab) {
      if (side.selectionRevision() !== selectionRevision) return false
      throw new Error(_({ id: "app.reference.unavailable", message: "The resource is unavailable." }))
    }
    if (options?.origin !== "agent")
      setOpenedResource({ session, tabID: tab.id, origin: options?.focusTarget ?? (() => origin) })
    return tab
  }

  const openActivityDetail = (target: ActivityDetailTarget, part?: ToolPart) => {
    const resolved =
      part ??
      (target.kind === "tool"
        ? (canonicalView
            .partsFor(target.messageID)
            .find((value) => value.id === target.partID && value.type === "tool") as ToolPart | undefined)
        : undefined)
    if (resolved && !toolFeatureAvailable(resolved, globalSDK.capabilities.has)) return false
    if (params.id !== target.sessionID) return false
    pending?.abort()
    setResourceSelection(undefined)
    void workbench.openPanel("execution-detail", {
      reuseExisting: true,
      init: {
        state: {
          server: sdk.url,
          scope: sdk.scopeKey,
          ...target,
          ...(resolved ? { requiredFeatures: toolRequiredFeatures(resolved) } : {}),
        },
      },
    })
    return true
  }
  const openToolActivity = (target: ToolActivityTarget, part?: ToolPart) => {
    if (params.id !== target.sessionID || (part && !toolFeatureAvailable(part, globalSDK.capabilities.has)))
      return false
    if (part && !supportsToolResource(part.tool)) return openActivityDetail({ ...target, kind: "tool" }, part)
    pending?.abort()
    const request = new AbortController()
    pending = request
    const owner = ownerKey()
    const client = sdk.client
    const scopeID = sdk.scopeID
    const side = workbench.surface("side")
    const active = side.active()
    const opened = side.opened()
    const selectionRevision = side.selectionRevision()
    const current = () =>
      !request.signal.aborted &&
      ownerKey() === owner &&
      side.selectionRevision() === selectionRevision &&
      side.active() === active &&
      side.opened() === opened
    const matches = (value: ToolPart) =>
      value.id === target.partID &&
      value.messageID === target.messageID &&
      value.sessionID === target.sessionID &&
      (!target.callID || value.callID === target.callID)
    const fallback = (value?: ToolPart) => {
      if (current()) openActivityDetail({ ...target, kind: "tool" }, value)
    }
    void (async () => {
      try {
        let value = part
        let resource = value && matches(value) ? toolResourceTarget(value) : undefined
        if (
          !resource &&
          (!value || (value.state.status === "completed" && Object.keys(value.state.metadata ?? {}).length === 0))
        ) {
          const result = await client.session.toolActivity(target, { signal: request.signal, throwOnError: true })
          if (!current()) return
          value = result.data?.part
          resource = value && matches(value) ? toolResourceTarget(value) : undefined
        }
        if (value && !toolFeatureAvailable(value, globalSDK.capabilities.has)) return
        if (!resource || !workbench.getPanel(resource.panelId)) return fallback(value)
        let source = resource.source
        if (resource.panelId === "notes") {
          const note = await resolveNoteReference(client, scopeID, resource.resourceId, request.signal)
          if (!current()) return
          source = note.scopeID
          const existing = side
            .tabs()
            .find((tab) => tab.panelId === "notes" && tab.resourceId === resource!.resourceId && tab.source === source)
          if (existing) {
            setResourceSelection({
              owner,
              target,
              tab: {
                id: existing.id,
                panelId: existing.panelId,
                resourceId: existing.resourceId,
                source: existing.source,
              },
            })
            workbench.activateTab("side", existing.id)
            return
          }
        }
        if (!current()) return
        const tab = await workbench.openPanel(resource.panelId, {
          activate: false,
          canCommit: current,
          init: { resourceId: resource.resourceId, ...(source ? { source } : {}) },
        })
        if (!tab) return fallback(value)
        if (
          request.signal.aborted ||
          ownerKey() !== owner ||
          side.selectionRevision() !== selectionRevision ||
          (side.active() !== active && side.active() !== tab.id) ||
          side.opened() !== opened
        )
          return
        setResourceSelection({
          owner,
          target,
          tab: { id: tab.id, panelId: tab.panelId, resourceId: tab.resourceId, source: tab.source },
        })
        workbench.activateTab("side", tab.id)
      } catch {
        fallback(part)
      }
    })()
    return true
  }
  const isActivityDetailSelected = (target: ActivityDetailTarget) => {
    const side = workbench.surface("side")
    if (!side.opened()) return false
    const tab = side.tabs().find((tab) => tab.id === side.active() && tab.panelId === "execution-detail")
    const state = executionDetailState(tab?.state, { server: sdk.url, scope: sdk.scopeKey, sessionID: params.id ?? "" })
    return (
      state?.sessionID === target.sessionID &&
      state.messageID === target.messageID &&
      state.kind === target.kind &&
      (target.kind !== "tool" ||
        (state.kind === "tool" && state.partID === target.partID && (!target.callID || state.callID === target.callID)))
    )
  }
  const isToolActivitySelected = (target: ToolActivityTarget) => {
    if (isActivityDetailSelected({ ...target, kind: "tool" })) return true
    const selected = resourceSelection()
    const side = workbench.surface("side")
    const active = side.tabs().find((tab) => tab.id === side.active())
    return (
      !!selected &&
      selected.owner === ownerKey() &&
      side.opened() &&
      active?.id === selected.tab.id &&
      sameWorkbenchResource(active, selected.tab.panelId, selected.tab) &&
      selected.target.sessionID === target.sessionID &&
      selected.target.messageID === target.messageID &&
      selected.target.partID === target.partID &&
      (!target.callID || selected.target.callID === target.callID)
    )
  }

  const openToolReview = (target: ToolReviewTarget) => {
    void workbench.openPanel("session-review", {
      reuseExisting: true,
      init: { source: toolReviewSource(target), resourceId: target.path ?? "" },
    })
    return true
  }

  const workspaceTarget = (path: string, context = ResourceReference.capture(file.workspace)) => {
    if (context.state !== "bound")
      throw new Error(
        _({
          id: "app.reference.noWorkspace",
          message: "The source workspace is unavailable. Choose a workspace to open this reference.",
        }),
      )
    const normalized = ResourceReference.resolvePath(path, context)
    if (normalized === undefined)
      throw new Error(
        _({ id: "app.reference.outsideWorkspace", message: "This path is outside the reference’s workspace." }),
      )
    const record = sync.data.workspaces.find((item) => item.id === context.workspace.id)
    const workspace = record
      ? catalogFileWorkspace(record)
      : file.workspace?.id === context.workspace.id
        ? file.workspace
        : undefined
    if (!workspace || workspace.generation !== context.workspace.generation)
      throw new Error(
        _({
          id: "app.reference.workspaceChanged",
          message: "The source workspace was removed or its binding changed.",
        }),
      )
    return { path: normalized, workspace }
  }

  const chooseWorkspace = (signal: AbortSignal) =>
    new Promise<ResourceReference.Context | undefined>((resolve) => {
      if (signal.aborted) return resolve(undefined)
      const id = showResourceDialog(
        () => (
          <Dialog
            title={_({ id: "app.reference.chooseWorkspace", message: "Choose the reference’s workspace" })}
            size="list"
          >
            <List
              items={sync.data.workspaces
                .filter((record) => record.scopeID === sdk.scopeID)
                .flatMap((record) => {
                  const value = catalogFileWorkspace(record)
                  return value ? [value] : []
                })}
              key={(item) => item.id}
              search={{
                placeholder: _({ id: "app.reference.searchWorkspace", message: "Search workspaces" }),
                autofocus: true,
              }}
              filterKeys={["path", "name", "id"]}
              onSelect={(workspace) => {
                resolve(workspace ? ResourceReference.capture(workspace) : undefined)
                dialog.close(id)
              }}
            >
              {(workspace) => (
                <span>{workspace.path || (typeof workspace.name === "string" ? workspace.name : workspace.id)}</span>
              )}
            </List>
          </Dialog>
        ),
        () => {
          signal.removeEventListener("abort", cancel)
          resolve(undefined)
        },
      )
      const cancel = () => dialog.close(id)
      signal.addEventListener("abort", cancel, { once: true })
    })

  const openWorkspaceFile = async (path: string, options: ResourceOpenOptions = {}, mime?: string) => {
    if (options.origin === "agent" && options.context?.state !== "bound")
      throw new Error("An Agent file view requires the captured source Workspace.")
    if (options.context && options.context.state !== "bound") {
      const context = await chooseWorkspace(options.signal ?? new AbortController().signal)
      if (!context) return false
      options = { ...options, context }
    }
    const target = workspaceTarget(path, options.context)
    const owner = ownerKey()
    const side = workbench.surface("side")
    const revision = side.selectionRevision()
    const current = () =>
      !disposed && !options.signal?.aborted && ownerKey() === owner && options.canCommit?.() !== false
    const response = await sdk.client.workspace.files.stat(
      {
        path: target.path,
        workspaceID: target.workspace.id,
        workspaceGeneration: target.workspace.generation,
      },
      { signal: options.signal, throwOnError: true },
    )
    if (!current() || side.selectionRevision() !== revision) return false
    if (options.origin === "agent") {
      const latest = workspaceTarget(path, options.context)
      if (workspaceFileResource(latest.workspace, latest.path) !== workspaceFileResource(target.workspace, target.path))
        return false
      if (!response.data || response.data.type === "directory")
        throw new Error("The target is not an available Workspace file.")
    }
    const preview = classifyResourcePreview("", target.path)
    if (
      options.prefer === "preview" &&
      mime?.startsWith("image/") &&
      response.data?.type !== "directory" &&
      (["image", "svg"].includes(preview.kind) || (preview.kind === "unsupported" && mime !== "image/*"))
    ) {
      const src = resolveUrl({ kind: "workspace-file", path }, options.context)
      if (!src) return false
      const image = {
        id: src,
        src,
        filename: filenameFor({ path }),
        mime,
        sourcePath: path,
        referenceContext: options.context,
        downloadUrl: src,
      }
      showResourceDialog(
        () => <ImagePreview images={[image]} />,
        () => options.focusTarget?.()?.focus({ preventScroll: true }),
      )
      return true
    }
    const tab = await projectFiles.open(target.workspace, target.path, {
      newTab: options.newTab,
      location: options.location,
      directory: response.data?.type === "directory",
      signal: options.signal,
      focusTarget: options.focusTarget,
      origin: options.origin,
      canCommit: options.canCommit,
    })
    if (options.origin !== "agent" && current() && tab)
      setOpenedResource({ session: workbench.sessionKey(), tabID: tab.id, origin: options.focusTarget })
    return !disposed && !options.signal?.aborted && ownerKey() === owner && (tab ?? false)
  }

  const resolveUrl = (reference: ResourceReference.Target, context?: ResourceReference.Context) => {
    if (reference.kind === "asset") {
      const attachment = attachmentFromReference(reference.url)
      return attachment ? resolveAttachmentUrl(sdk.url, attachment) : undefined
    }
    if (reference.kind === "url" || reference.kind === "image") return reference.url
    if (reference.kind !== "workspace-file") return
    try {
      const target = workspaceTarget(reference.path, context)
      return buildWorkspaceFileBrowserUrl(sdk.url, target.path, {
        scopeID: sdk.scopeID,
        workspaceID: target.workspace.id,
        workspaceGeneration: target.workspace.generation,
      })
    } catch {
      return
    }
  }

  const openNote = async (resource: Extract<OpenableResource, { kind: "note" }>, options: ResourceOpenOptions) => {
    if (!globalSDK.capabilities.has("note") || !workbench.getPanel("notes"))
      throw new Error(_({ id: "app.reference.unavailable", message: "The resource is unavailable." }))
    const owner = ownerKey()
    const captured = contextKey()
    const current = () =>
      !disposed && !options.signal?.aborted && options.canCommit?.() !== false && contextKey() === captured
    const note = await resolveNoteReference(sdk.client, sdk.scopeID, resource.id, options.signal)
    if (!current()) return false
    const state = { referenceLocation: options.location, referenceNavigation: generateUUID() }
    const existing = !options.newTab
      ? workbench
          .surface("side")
          .tabs()
          .find((tab) => tab.panelId === "notes" && tab.resourceId === note.id && tab.source === note.scopeID)
      : undefined
    if (existing) {
      workbench.updateTab(existing.id, { state: { ...(existing.state as object), ...state } })
      workbench.activateTab("side", existing.id, options.origin)
      if (options.origin !== "agent")
        setOpenedResource({ session: workbench.sessionKey(), tabID: existing.id, origin: options.focusTarget })
      return existing
    }
    const tab = await workbench.openPanel("notes", {
      canCommit: current,
      intent: options.origin,
      forceNew: options.newTab,
      init: { resourceId: note.id, source: note.scopeID, state },
    })
    if (!tab || disposed || options.signal?.aborted || ownerKey() !== owner) return false
    if (options.origin !== "agent")
      setOpenedResource({ session: workbench.sessionKey(), tabID: tab.id, origin: options.focusTarget })
    return tab
  }

  const preview = async (resource: OpenableResource, options: ResourceOpenOptions = {}): Promise<ResourcePreview> => {
    if (resource.kind === "url") resource = { ...ResourceReference.parse(resource.url), filename: resource.filename }
    const captured = contextKey()
    const client = sdk.client
    const scopeID = sdk.scopeID
    const location = options.location ?? ("location" in resource ? resource.location : undefined)
    const missing = _({
      id: "app.reference.previewUnavailable",
      message: "Preview unavailable",
    })
    const base: ResourcePreview = {
      title:
        resource.kind === "attachment"
          ? (resource.file.filename ?? "")
          : resource.filename || ResourceReference.format(resource, location),
      source: "",
      unavailable: missing,
    }
    const current = () => !disposed && !options.signal?.aborted && contextKey() === captured
    const key = (...values: unknown[]) => JSON.stringify([ownerKey(), previewEpoch(), ...values])
    const assertCurrent = () => {
      if (!current()) throw new DOMException("Reference owner changed", "AbortError")
    }
    try {
      options.signal?.throwIfAborted()
      if (resource.kind === "asset" || resource.kind === "image") {
        const file = attachmentFromReference(resource.url, resource.filename)
        const asset = AssetReference.parse(resource.url)
        const kind = classifyResourcePreview(file?.mime ?? resource.mime ?? "image/*", asset?.id).kind
        base.source = _({ id: "app.reference.assetSource", message: "Attachment" })
        const imageSource = _({ id: "app.reference.imageSource", message: "Image" })
        base.title =
          resource.filename && resource.filename !== resource.url
            ? resource.filename
            : kind === "image" || kind === "svg"
              ? imageSource
              : base.source
        if (kind === "image" || kind === "svg") {
          const src = resolveUrl(resource, options.context)
          return src ? { title: base.title, source: imageSource, image: { src, alt: base.title } } : base
        }
        if (!asset || !["source", "markdown", "html"].includes(kind)) return base
        const title = base.title
        const start = location?.kind === "text" ? Math.max(0, location.line - 4) : 0
        const value = await previewCache.read(
          key("asset", asset.id, start),
          async (signal) => {
            const result = await client.asset.get(
              { id: asset.id, scopeID },
              { signal, throwOnError: true, parseAs: "stream" },
            )
            if (!(result.data instanceof ReadableStream)) return base
            const reader = result.data.getReader()
            const decoder = new TextDecoder()
            let text = ""
            let remaining = 24 * 1024
            try {
              while (remaining > 0 && text.split("\n").length <= start + 11) {
                const chunk = await reader.read()
                signal.throwIfAborted()
                if (chunk.done) break
                if (!(chunk.value instanceof Uint8Array)) return base
                const bytes = chunk.value.subarray(0, remaining)
                remaining -= bytes.byteLength
                text += decoder.decode(bytes, { stream: true })
              }
            } finally {
              await reader.cancel().catch(() => {})
              reader.releaseLock()
            }
            return {
              title,
              source: base.source,
              code: {
                text: text
                  .split("\n")
                  .slice(start, start + 11)
                  .join("\n")
                  .slice(0, 6000),
                startLine: start + 1,
              },
            }
          },
          options.signal,
        )
        assertCurrent()
        return { ...value, title }
      }
      if (resource.kind === "note") {
        base.source = _({ id: "app.reference.noteSource", message: "Note" })
        if (!globalSDK.capabilities.has("note")) return base
        const target = resource
        const resolved = await notePreviewTargets.read(
          key("note-target", target.id),
          (signal) => resolveNoteReference(client, scopeID, target.id, signal),
          options.signal,
        )
        assertCurrent()
        const blockId = location?.kind === "heading" ? location.id : undefined
        const project = (title: string, content: unknown): ResourcePreview => {
          const excerpt = noteReferenceExcerpt(content, blockId)
          return {
            title,
            source: base.source,
            path: ResourceReference.format(target, location),
            description: excerpt.text || undefined,
            ...(!excerpt.found
              ? {
                  unavailable: _({
                    id: "app.reference.noteLocationUnavailable",
                    message: "This location no longer exists.",
                  }),
                }
              : {}),
          }
        }
        const draft = noteDocuments.peek(resolved.scopeID, target.id)
        if (draft) return project(draft.title(), draft.content())
        const value = await previewCache.read(
          key("note", resolved.scopeID, target.id, location),
          async (signal) => {
            const response = await client.note.get(
              { id: target.id, scopeID: resolved.scopeID },
              { signal, throwOnError: true },
            )
            return response.data ? project(response.data.title, response.data.content) : base
          },
          options.signal,
        )
        assertCurrent()
        const latest = noteDocuments.peek(resolved.scopeID, target.id)
        return latest ? project(latest.title(), latest.content()) : value
      }
      if (resource.kind === "workspace-file") {
        const reference = resource
        base.source = _({ id: "app.reference.fileSource", message: "Workspace file" })
        if (!options.context || options.context.state !== "bound") return base
        const target = workspaceTarget(resource.path, options.context)
        base.title = filenameFor(target)
        base.path = ResourceReference.format(resource, location)
        const start = location?.kind === "text" ? Math.max(0, location.line - 4) : 0
        const project = (text: string, startLine: number): ResourcePreview => ({
          title: filenameFor(target),
          source: base.source,
          path: ResourceReference.format(resource, location),
          code: { text: text.slice(0, 6000), startLine },
        })
        const fromDocument = () => {
          const document = projectFiles.peek(target.workspace, target.path)
          if (document?.deleted) return
          const text =
            document?.draft?.content ?? (document?.content?.kind === "text" ? document.content.content : undefined)
          return text === undefined
            ? undefined
            : project(
                text
                  .split("\n")
                  .slice(start, start + 11)
                  .join("\n"),
                start + 1,
              )
        }
        const draft = fromDocument()
        if (draft) return draft
        const value = await previewCache.read(
          key("file", target.workspace.id, target.workspace.generation, target.path, location),
          async (signal) => {
            const query = {
              workspaceID: target.workspace.id,
              workspaceGeneration: target.workspace.generation,
              path: target.path,
            }
            const stat = await client.workspace.files.stat(query, { signal, throwOnError: true })
            if (!stat.data || stat.data.type === "directory") return base
            const kind = classifyResourcePreview("", target.path).kind
            if (kind === "image" || kind === "svg") {
              const src = resolveUrl(reference, options.context)
              return src
                ? { title: base.title, source: base.source, path: base.path, image: { src, alt: base.title } }
                : base
            }
            if (stat.data.binary) return base
            const result = await client.workspace.files.read(
              { ...query, offset: start, limit: 11, mode: "range" },
              { signal, throwOnError: true },
            )
            return result.data?.kind === "text" ? project(result.data.content, result.data.range.startLine) : base
          },
          options.signal,
        )
        assertCurrent()
        return fromDocument() ?? value
      }
      if (resource.kind === "url") {
        const url = new URL(resource.url)
        base.source = url.hostname
        base.title = `${url.hostname}${url.pathname === "/" ? "" : url.pathname}`
        if (!globalSDK.capabilities.has("browser") || !["https:", "http:"].includes(url.protocol)) return base
        const value = await previewCache.read(
          key("url", url.href),
          async (signal) => {
            const result = await client.browser.preview(
              { path_directory: scopeID ?? sdk.scopeKey, scopeID, mode: "scope", url: url.href },
              { signal, throwOnError: true },
            )
            const metadata = result.data
            if (!metadata) return base
            const unavailable = metadata.unavailable
              ? metadata.unavailable === "authentication_required"
                ? _({
                    id: "app.reference.previewSignIn",
                    message: "Sign-in required",
                  })
                : missing
              : undefined
            return { ...metadata, unavailable }
          },
          options.signal,
        )
        assertCurrent()
        return value
      }
      return base
    } catch (error) {
      if (!current() || (error instanceof DOMException && error.name === "AbortError")) throw error
      return { ...base, unavailable: missing }
    }
  }

  const openLabel = (resource: OpenableResource) => {
    if (resource.kind === "note") return _({ id: "app.reference.openNote", message: "Open in Notes" })
    if (resource.kind === "workspace-file") return _({ id: "app.reference.openFile", message: "Open in Files" })
    if (resource.kind === "url" && globalSDK.capabilities.has("browser") && platform.browserNative)
      return _({ id: "app.reference.openBrowser", message: "Open in Browser" })
    if (resource.kind === "asset" || resource.kind === "image") {
      const file = attachmentFromReference(resource.url)
      if (resource.kind === "image" || (file && isImageAttachment(file)))
        return _({ id: "app.reference.openImage", message: "Open image" })
      return _({ id: "app.reference.openAttachment", message: "Open file" })
    }
    if (resource.kind === "url") return _({ id: "app.reference.openWebsite", message: "Open website" })
    return _({ id: "app.reference.open", message: "Open" })
  }

  const nativeLink = (reference: ResourceReference.Target) =>
    platform.platform === "web" && reference.kind === "url" && /^https?:/i.test(reference.url)

  const openUrl = async (
    input: { url: string; mime?: string; filename?: string },
    options: ResourceOpenOptions = {},
    opening?: { id: string; owner: string },
    onOpening?: (tabId: string) => void,
  ): Promise<ResourceOpenResult> => {
    if (input.mime?.startsWith("image/")) {
      const image = previewImageForUrl(input)
      if (!image) return { status: "cancelled" }
      showResourceDialog(() => <ImagePreview images={[image]} />)
      return { status: "opened" }
    }
    if (ResourceReference.parse(input.url).kind !== "url") return { status: "cancelled" }
    const url = new URL(input.url)
    const external = () => {
      platform.openLink(input.url)
      return { status: "dispatched" } as const
    }
    if (
      options.prefer === "external" ||
      !["http:", "https:"].includes(url.protocol) ||
      !globalSDK.capabilities.has("browser") ||
      !platform.browserNative
    )
      return external()
    const captured = ownerKey()
    const selection = globalSDK.capabilities.current()
    const side = workbench.surface("side")
    const revision = side.selectionRevision()
    const current = () =>
      !disposed &&
      !options.signal?.aborted &&
      captured === ownerKey() &&
      globalSDK.capabilities.current() === selection &&
      side.selectionRevision() === revision
    const prepared = readNativeCapability(platform.browserNative)
    const capability = prepared instanceof Promise ? await prepared : prepared
    if (!current()) return { status: "cancelled" }
    const validated = BrowserNativePresentationCapabilityResultSchema.safeParse(capability)
    if (
      !validated.success ||
      validated.data.error ||
      (validated.data.managedLocal ? validated.data.status !== "ready" : validated.data.status !== "failed")
    )
      throw new Error(
        _({
          id: "app.reference.browserUnavailable",
          message: "The in-app browser is unavailable. Retry or open this link in your system browser.",
        }),
      )
    if (!validated.data.managedLocal) return external()
    if (opening) {
      if (opening.owner !== captured) return { status: "cancelled" }
      const pending = workbench.openingForTab(opening.id)
      if (!pending) return { status: "cancelled" }
      const tab = await pending.resolve()
      if (!current()) return { status: "cancelled" }
      setOpenedResource({ session: workbench.sessionKey(), tabID: tab.id, origin: options.focusTarget })
      return { status: "opened" }
    }
    const route: BrowserWorkbenchRoute = {
      mode: "scope",
      scopeID: sdk.scopeID ?? sdk.scopeKey,
      path_directory: params.dir ?? sdk.scopeID ?? sdk.scopeKey,
    }
    const catalog = browserCatalog.peek(route)
    const candidates = options.newTab
      ? []
      : side.tabs().flatMap((tab) => {
          const source = browserWorkbenchRoute(tab.state)
          if (tab.panelId !== "browser" || !source || !catalog || !sameBrowserCatalog(source, catalog.route)) return []
          const page = catalog.store.session.pages.find(
            (page) => page.id === tab.resourceId && page.status === "active",
          )
          if (!page) return []
          try {
            const address = new URL(page.url)
            const exact = address.href === url.href
            address.hash = ""
            const base = new URL(url.href)
            base.hash = ""
            return exact || address.href === base.href ? [{ tab, page, exact }] : []
          } catch {
            return []
          }
        })
    if (candidates.length === 1) {
      const match = candidates[0]
      if (!match.exact) {
        const { browserWorkbenchAccess } = await import("@/components/workspace/browser/browser-workbench-api")
        const { createBrowserCommandId } = await import("@/components/workspace/browser/browser-command")
        const access = await browserWorkbenchAccess({
          client: sdk.client,
          serverUrl: sdk.url,
          bridge: platform.browserNative,
          route: catalog!.route,
        })
        if (!current()) return { status: "cancelled" }
        await sdk.client.browser.control(
          {
            ...access,
            browserControlRequest: {
              protocolVersion: BROWSER_PROTOCOL_VERSION,
              pageId: match.page.id,
              commandId: createBrowserCommandId(),
              command: { type: "navigate", source: "user", url: input.url },
            },
          },
          { signal: options.signal, throwOnError: true },
        )
        if (!current()) return { status: "cancelled" }
      }
      workbench.activateTab("side", match.tab.id)
      setOpenedResource({ session: workbench.sessionKey(), tabID: match.tab.id, origin: options.focusTarget })
      return { status: "opened" }
    }
    const tab = await workbench.openPanel("browser", {
      canCommit: current,
      forceNew: true,
      init: { title: browserURLTitle(input.url), state: { url: input.url } },
      onOpening,
    })
    if (!current()) return { status: "cancelled" }
    if (!tab) throw new Error(_({ id: "browser.prepare.failed", message: "Browser preparation failed. Retry." }))
    setOpenedResource({ session: workbench.sessionKey(), tabID: tab.id, origin: options.focusTarget })
    return { status: "opened" }
  }

  const openAttachment = async (
    attachment: AttachmentFile,
    options?: ResourceOpenOptions & { serverUrl?: string },
  ): Promise<boolean | WorkbenchPanelTab> => {
    options = { ...options, context: attachmentReferenceContext(attachment, options?.context) }
    const captured = () => {
      const draft =
        transitions.get(attachment.sessionID ?? "")?.draft ??
        transitions.get(draftTransitionKey(sdk.url, sdk.scopeKey))?.draft
      if (
        !draft?.message ||
        draft.message.sessionID !== attachment.sessionID ||
        (draft.message.id !== attachment.messageID && draft.originalMessageID !== attachment.messageID) ||
        !draft.parts?.some((part) => part.type === "attachment" && part.id === attachment.id)
      )
        return undefined
      return draft
    }
    const canonical = () =>
      canonicalView
        .messagesFor(attachment.sessionID ?? "")
        .some(
          (message) =>
            message.id === (captured()?.messageID ?? attachment.messageID) && !isOptimisticMessagePending(message),
        )
    const draft = captured()
    if (draft && !canonical()) {
      const server = sdk.url,
        scope = sdk.scopeKey,
        intent = draft.intent
      let dialogID: string | undefined
      dialogID = showResourceDialog(
        () => (
          <Suspense>
            <DraftAttachmentPreview
              file={attachment}
              serverUrl={draft.serverUrl ?? options?.serverUrl ?? server}
              isValid={() =>
                !disposed &&
                sdk.url === server &&
                sdk.scopeKey === scope &&
                (!params.id || params.id === attachment.sessionID) &&
                (captured()?.intent === intent || canonical())
              }
              onInvalid={() => dialog.close(dialogID)}
            />
          </Suspense>
        ),
        () => {
          if (draftDialog === dialogID) draftDialog = undefined
        },
      )
      draftDialog = dialogID
      return true
    }
    const attachmentPanelInit = attachmentWorkbenchPanelInit(attachment)
    if (options?.prefer === "workspace" && attachmentPanelInit) {
      return openAttachmentPanel(attachment, attachmentPanelInit, options)
    }
    const path = attachmentPath(attachment)
    if (options?.prefer === "workspace" && path) return openWorkspaceFile(path, options)

    const url = resolveAttachmentUrl(options?.serverUrl ?? sdk.url, attachment)
    const target = resolveAttachmentOpenTarget(attachment)
    if (target === "image-preview" && isImageAttachment(attachment) && url && options?.prefer !== "workspace") {
      const image = resolveImagePreviewImage(options?.serverUrl ?? sdk.url, attachment, 0)
      if (!image) return false
      image.sourcePath = attachmentSourcePath(attachment)
      image.referenceContext = options?.context
      showResourceDialog(
        () => (
          <ImagePreview
            images={
              options?.imagePreview?.images.map((item) => ({
                ...item,
                referenceContext: item.referenceContext ?? options?.context,
              })) ?? [image]
            }
            initialIndex={options?.imagePreview?.index}
          />
        ),
        () => {
          if (options?.focusTarget) queueMicrotask(() => options.focusTarget?.()?.focus({ preventScroll: true }))
        },
      )
      return true
    }

    if (attachmentPanelInit) {
      return openAttachmentPanel(attachment, attachmentPanelInit, options)
    }

    if (path) return openWorkspaceFile(path, options)
    if (url)
      return (await openUrl({ url, mime: attachment.mime, filename: attachment.filename }, options)).status === "opened"
    throw new Error(_({ id: "app.reference.unavailable", message: "The resource is unavailable." }))
  }

  const open = async (
    resource: OpenableResource,
    supplied: ResourceOpenOptions = {},
    retry?: { opening: { id: string; owner: string }; request: AbortController },
  ): Promise<ResourceOpenResult> => {
    if (resource.kind === "url")
      resource = { ...ResourceReference.parse(resource.url), mime: resource.mime, filename: resource.filename }
    if (retry && (resourceRequest !== retry.request || retry.opening.owner !== ownerKey()))
      return { status: "cancelled" }
    if (!retry) resourceRequest?.abort()
    const request = retry?.request ?? new AbortController()
    resourceRequest = request
    let opening = retry?.opening
    const signal = supplied.signal ? AbortSignal.any([supplied.signal, request.signal]) : request.signal
    const options = {
      ...supplied,
      signal,
      location: supplied.location ?? ("location" in resource ? resource.location : undefined),
    }
    try {
      if (signal.aborted) return { status: "cancelled" }
      if (options.location && !ResourceReference.Location.safeParse(options.location).success)
        throw new Error(
          _({ id: "app.reference.invalid", message: "This reference has an invalid path, protocol or location." }),
        )
      const source =
        resource.kind === "asset" ? resource.url : resource.kind === "attachment" ? resource.file.url : undefined
      if (
        options.origin !== "agent" &&
        source &&
        /^asset:\/\/[a-f0-9]{16}\.bin$/.test(source) &&
        params.id &&
        globalSDK.capabilities.has("media")
      ) {
        const captured = ownerKey()
        const reference = await sdk.client.render.find(
          { sessionID: params.id, assetID: source.slice("asset://".length) },
          { signal, throwOnError: true },
        )
        if (signal.aborted || ownerKey() !== captured) return { status: "cancelled" }
        if (reference.data) {
          const { RenderTool } = await import("@ericsanchezok/synergy-ui/render-tool")
          if (signal.aborted || ownerKey() !== captured) return { status: "cancelled" }
          const { target, descriptor } = reference.data
          let flush: (() => Promise<void>) | undefined
          const id = showResourceDialog(() => (
            <div data-component="render-viewer">
              <Dialog
                title={descriptor.title}
                size="content"
                onCloseRequest={async () => {
                  try {
                    await flush?.()
                    dialog.close(id)
                  } catch {
                    return
                  }
                }}
              >
                <RenderTool
                  expanded
                  onFlush={(value) => {
                    flush = value
                  }}
                  onClose={() => dialog.close(id)}
                  tool="render"
                  status="completed"
                  input={{ artifactTitle: descriptor.title }}
                  metadata={{ visual: descriptor }}
                  sessionId={target.sessionID}
                  messageId={target.messageID}
                  partId={target.partID}
                />
              </Dialog>
            </div>
          ))
          return { status: "opened" }
        }
      }
      let opened: boolean | WorkbenchPanelTab = false
      if (resource.kind === "attachment")
        opened = await openAttachment(resource.file, { ...options, serverUrl: resource.serverUrl })
      else if (resource.kind === "asset") {
        const attachment = attachmentFromReference(resource.url, resource.filename)
        if (attachment) opened = await openAttachment(attachment, options)
      } else if (resource.kind === "workspace-file")
        opened = await openWorkspaceFile(resource.path, options, resource.mime)
      else if (resource.kind === "note") opened = await openNote(resource, options)
      else if (resource.kind === "url")
        return await openUrl(resource, options, opening, (id) => {
          opening = { id, owner: ownerKey() }
        })
      else if (resource.kind === "image") return await openUrl({ ...resource, mime: "image/*" }, options)
      else if (resource.kind === "unavailable")
        throw new Error(
          _({ id: "app.reference.invalid", message: "This reference has an invalid path, protocol or location." }),
        )
      if (signal.aborted) return { status: "cancelled" }
      if (!opened) return { status: "cancelled" }
      return {
        status: "opened",
        ...(options.origin === "agent" && typeof opened === "object"
          ? { view: { viewId: opened.id, surface: "side" as const } }
          : {}),
      }
    } catch (error) {
      if (signal.aborted) return { status: "cancelled" }
      const reason =
        fileWriteErrorMessage(error) ??
        (error instanceof Error
          ? error.message
          : _({ id: "app.reference.unavailable", message: "The resource is unavailable." }))
      if (options.origin === "agent") return { status: "unavailable", reason }
      const reference = (() => {
        try {
          return resource.kind === "attachment"
            ? attachmentCopyReference(resource.file, options.location)
            : ResourceReference.format(resource, options.location)
        } catch {
          return undefined
        }
      })()
      showToast({
        type: "error",
        title: _({ id: "app.reference.openFailed", message: "Couldn’t open reference" }),
        description: reason,
        actions: [
          ...(resource.kind === "url" && /^https?:/i.test(resource.url)
            ? [
                {
                  label: _({ id: "app.reference.openExternal", message: "Open in system browser" }),
                  onClick: () => {
                    void open(resource, { ...supplied, prefer: "external" })
                  },
                },
              ]
            : []),
          {
            label: _({ id: "app.workspace.panel.retry", message: "Retry" }),
            onClick: () => {
              void open(resource, supplied, opening ? { opening, request } : undefined)
            },
          },
          ...(reference
            ? [
                {
                  label: _({ id: "app.reference.copy", message: "Copy reference" }),
                  onClick: () => {
                    void copyTextToClipboard(reference)
                  },
                },
              ]
            : []),
        ],
      })
      return { status: "unavailable", reason }
    }
  }

  const present = async (
    target: WorkbenchView.Target,
    supplied: ResourceOpenOptions = {},
  ): Promise<ResourceOpenResult> => {
    const options: ResourceOpenOptions = { ...supplied, origin: "agent", prefer: "workspace" }
    if (target.kind !== "browser-page") return open(target, options)
    if (!globalSDK.capabilities.has("browser") || !platform.browserNative || !workbench.getPanel("browser"))
      return { status: "unavailable", reason: "Native Browser presentation is unavailable." }
    const owner = ownerKey()
    const side = workbench.surface("side")
    const revision = side.selectionRevision()
    const current = () =>
      !disposed &&
      !options.signal?.aborted &&
      options.canCommit?.() !== false &&
      ownerKey() === owner &&
      side.selectionRevision() === revision
    try {
      const capability = BrowserNativePresentationCapabilityResultSchema.safeParse(
        await readNativeCapability(platform.browserNative),
      )
      if (!current()) return { status: "cancelled" }
      if (
        !capability.success ||
        !capability.data.managedLocal ||
        capability.data.error ||
        capability.data.status !== "ready"
      )
        return { status: "unavailable", reason: "Native Browser presentation is unavailable." }
      const routes: BrowserWorkbenchRoute[] = [
        { mode: "scope", scopeID: sdk.scopeID, path_directory: params.dir ?? sdk.scopeID },
      ]
      if (params.id)
        routes.push({
          mode: "session",
          scopeID: sdk.scopeID,
          sessionID: params.id,
          path_directory: params.dir ?? sdk.scopeID,
        })
      for (const route of routes) {
        const catalog = await browserCatalog.get(route)
        if (!current()) return { status: "cancelled" }
        const page = catalog.store.session.pages.find((page) => page.id === target.pageId)
        if (!page) continue
        if (page.status !== "active")
          return {
            status: "unavailable",
            reason: "The Browser page is not active. Viewing never resumes or recreates a page.",
          }
        const init = browserPageTab(page, catalog.route)
        const tab = await workbench.openPanel("browser", {
          intent: "agent",
          activate: false,
          canCommit: () =>
            current() &&
            catalog.store.session.pages.some((page) => page.id === target.pageId && page.status === "active"),
          init: {
            ...init,
            state: { ...(init.state && typeof init.state === "object" ? init.state : {}), focusAddress: false },
          },
        })
        if (!current()) return { status: "cancelled" }
        if (!tab) return { status: "unavailable", reason: "The Browser page could not be selected." }
        workbench.activateTab("side", tab.id, "agent")
        return { status: "opened", view: { viewId: tab.id, surface: "side" } }
      }
      return { status: "unavailable", reason: "The Browser page does not exist in the current Scope or Session." }
    } catch (error) {
      if (!current()) return { status: "cancelled" }
      return {
        status: "unavailable",
        reason: error instanceof Error ? error.message : "The Browser page is unavailable.",
      }
    }
  }

  onMount(() => {
    onCleanup(
      plugins.resources.register((resource) => {
        const reference = ResourceReference.parse(resource.uri)
        if (reference.kind === "unavailable") return false
        void open(reference)
        return true
      }),
    )
  })

  const controller = {
    open,
    present,
    preview,
    openLabel,
    nativeLink,
    contextKey,
    resolveUrl,
    openToolReview,
    openToolActivity,
    isToolActivitySelected,
    openActivityDetail,
    isActivityDetailSelected,
  }
  createWorkbenchViewExecutor(controller)
  return <BaseResourceOpenProvider value={controller}>{props.children}</BaseResourceOpenProvider>
}
