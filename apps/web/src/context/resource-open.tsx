import { useGlobalSDK } from "./global-sdk"
import { ResourceReference } from "@ericsanchezok/synergy-util/resource-reference"
import { catalogFileWorkspace } from "./file/workspace"
import { buildWorkspaceFileBrowserUrl } from "@/utils/workspace-file-url"
import { fileWriteErrorMessage } from "./file/errors"
import { usePlatform } from "./platform"
import { Dialog } from "@ericsanchezok/synergy-ui/dialog"
import { List } from "@ericsanchezok/synergy-ui/list"
import { usePluginHost } from "@/plugin/host"
import { useParams } from "@solidjs/router"
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
  const ownerKey = () => JSON.stringify([sdk.url, sdk.scopeKey, params.id])
  let pending: AbortController | undefined
  const [resourceSelection, setResourceSelection] = createSignal<{
    owner: string
    target: ToolActivityTarget
    tab: Pick<WorkbenchPanelTab, "id" | "panelId" | "resourceId" | "source">
  }>()
  createEffect(() => {
    ownerKey()
    pending?.abort()
    resourceRequest?.abort()
    setResourceSelection(undefined)
  })
  onCleanup(() => {
    pending?.abort()
    resourceRequest?.abort()
  })
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
        ownerKey() === owner &&
        side.selectionRevision() === selectionRevision,
      reuseExisting: !options?.newTab,
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
    setOpenedResource({ session, tabID: tab.id, origin: options?.focusTarget ?? (() => origin) })
    return true
  }

  const openActivityDetail = (target: ActivityDetailTarget) => {
    if (params.id !== target.sessionID) return false
    pending?.abort()
    setResourceSelection(undefined)
    void workbench.openPanel("execution-detail", {
      reuseExisting: true,
      init: { state: { server: sdk.url, scope: sdk.scopeKey, ...target } },
    })
    return true
  }
  const openToolActivity = (target: ToolActivityTarget, part?: ToolPart) => {
    if (params.id !== target.sessionID) return false
    if (part && !supportsToolResource(part.tool)) return openActivityDetail({ ...target, kind: "tool" })
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
    const fallback = () => {
      if (current()) openActivityDetail({ ...target, kind: "tool" })
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
        if (!resource || !workbench.getPanel(resource.panelId)) return fallback()
        let source = resource.source
        if (resource.panelId === "notes") {
          const groups = await Promise.all(
            (["false", "true"] as const).map(async (archived) => {
              const result = await client.note.listMeta(
                { scopeID, archived },
                { signal: request.signal, throwOnError: true },
              )
              return result.data ?? []
            }),
          )
          if (!current()) return
          const scopes = new Set(
            groups
              .flat()
              .filter((group) => group.notes.some((note) => note.id === resource!.resourceId))
              .map((group) => group.scopeID),
          )
          if (scopes.size !== 1) return fallback()
          source = [...scopes][0]
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
        if (!tab) return fallback()
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
        fallback()
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
    if (options.context && options.context.state !== "bound") {
      const context = await chooseWorkspace(options.signal ?? new AbortController().signal)
      if (!context) return false
      options = { ...options, context }
    }
    const target = workspaceTarget(path, options.context)
    const owner = ownerKey()
    const side = workbench.surface("side")
    const revision = side.selectionRevision()
    const current = () => !disposed && !options.signal?.aborted && ownerKey() === owner
    const response = await sdk.client.workspace.files.stat(
      {
        path: target.path,
        workspaceID: target.workspace.id,
        workspaceGeneration: target.workspace.generation,
      },
      { signal: options.signal, throwOnError: true },
    )
    if (!current() || side.selectionRevision() !== revision) return false
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
    })
    if (current() && tab)
      setOpenedResource({ session: workbench.sessionKey(), tabID: tab.id, origin: options.focusTarget })
    return current() && !!tab
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

  const openUrl = async (input: { url: string; mime?: string; filename?: string }): Promise<boolean> => {
    if (input.mime?.startsWith("image/")) {
      const image = previewImageForUrl(input)
      if (!image) return false
      showResourceDialog(() => <ImagePreview images={[image]} />)
      return true
    }
    if (ResourceReference.parse(input.url).kind !== "url") return false
    platform.openLink(input.url)
    return true
  }

  const openAttachment = async (
    attachment: AttachmentFile,
    options?: ResourceOpenOptions & { serverUrl?: string },
  ): Promise<boolean> => {
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
    if (url) return openUrl({ url, mime: attachment.mime, filename: attachment.filename })
    throw new Error(_({ id: "app.reference.unavailable", message: "The resource is unavailable." }))
  }

  const open = async (resource: OpenableResource, supplied: ResourceOpenOptions = {}): Promise<ResourceOpenResult> => {
    if (resource.kind === "url")
      resource = { ...ResourceReference.parse(resource.url), mime: resource.mime, filename: resource.filename }
    resourceRequest?.abort()
    const request = new AbortController()
    resourceRequest = request
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
      if (source && /^asset:\/\/[a-f0-9]{16}\.bin$/.test(source) && params.id && globalSDK.capabilities.has("media")) {
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
          showResourceDialog(() => (
            <div data-component="render-viewer">
              <Dialog title={descriptor.title} size="content">
                <RenderTool
                  expanded
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
      let opened = false
      if (resource.kind === "attachment")
        opened = await openAttachment(resource.file, { ...options, serverUrl: resource.serverUrl })
      else if (resource.kind === "asset") {
        const attachment = attachmentFromReference(resource.url, resource.filename)
        if (attachment) opened = await openAttachment(attachment, options)
      } else if (resource.kind === "workspace-file")
        opened = await openWorkspaceFile(resource.path, options, resource.mime)
      else if (resource.kind === "url") opened = await openUrl(resource)
      else if (resource.kind === "image") opened = await openUrl({ ...resource, mime: "image/*" })
      else if (resource.kind === "unavailable")
        throw new Error(
          _({ id: "app.reference.invalid", message: "This reference has an invalid path, protocol or location." }),
        )
      if (signal.aborted) return { status: "cancelled" }
      if (!opened) return { status: "cancelled" }
      return { status: resource.kind === "url" && !resource.mime?.startsWith("image/") ? "dispatched" : "opened" }
    } catch (error) {
      if (signal.aborted) return { status: "cancelled" }
      const reason =
        fileWriteErrorMessage(error) ??
        (error instanceof Error
          ? error.message
          : _({ id: "app.reference.unavailable", message: "The resource is unavailable." }))
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
          {
            label: _({ id: "app.workspace.panel.retry", message: "Retry" }),
            onClick: () => {
              void open(resource, supplied)
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
    resolveUrl,
    openToolReview,
    openToolActivity,
    isToolActivitySelected,
    openActivityDetail,
    isActivityDetailSelected,
  }
  return <BaseResourceOpenProvider value={controller}>{props.children}</BaseResourceOpenProvider>
}
