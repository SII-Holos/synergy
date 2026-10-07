import { usePluginHost } from "@/plugin/host"
import { useParams } from "@solidjs/router"
import { toolReviewSource } from "./tool-review-target"
import { createEffect, createSignal, lazy, Suspense, onCleanup, onMount, type ParentProps } from "solid-js"
import { useLingui } from "@lingui/solid"
import { showToast, toaster } from "@ericsanchezok/synergy-ui/toast"
import {
  ResourceOpenProvider as BaseResourceOpenProvider,
  type OpenableResource,
  type ResourceOpenOptions,
  type ToolReviewTarget,
  type ToolActivityTarget,
  type ActivityDetailTarget,
} from "@ericsanchezok/synergy-ui/context/resource-open"
import { ImagePreview, type ImagePreviewImage } from "@ericsanchezok/synergy-ui/image-preview"
import {
  attachmentFromReference,
  attachmentSourcePath,
  isImageAttachment,
  resolveAttachmentOpenTarget,
  resolveAttachmentUrl,
  resolveImagePreviewImage,
  type AttachmentFile,
} from "@ericsanchezok/synergy-ui/attachment-card"
import { useDialog } from "@ericsanchezok/synergy-ui/context/dialog"
import { createSessionDataView } from "@ericsanchezok/synergy-ui/context/session-data-view"
import { useFile } from "@/context/file"
import { useSDK } from "@/context/sdk"
import { useWorkbenchPanels } from "@/context/workbench"
import { attachmentWorkbenchPanelInit } from "@/components/attachment-workbench/model"
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

function fileUrlPath(input: string | undefined) {
  if (!input?.startsWith("file://")) return undefined
  const raw = stripQueryAndHash(input.slice("file://".length))
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}

function attachmentPath(file: AttachmentFile) {
  return attachmentSourcePath(file) ?? fileUrlPath(file.url)
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
    externalUrl: src,
  }
}

export function ResourceOpenProvider(props: ParentProps) {
  const dialog = useDialog()
  const file = useFile()
  const sdk = useSDK()
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
    setResourceSelection(undefined)
  })
  onCleanup(() => pending?.abort())
  const { _ } = useLingui()
  const attachmentOpenings = new Set<string>()
  const [openedAttachment, setOpenedAttachment] = createSignal<{
    session: string
    tabID: string
    origin?: () => HTMLElement | undefined
  }>()
  let disposed = false
  let draftDialog: string | undefined
  onCleanup(() => {
    disposed = true
    attachmentOpenings.clear()
    if (draftDialog) dialog.close(draftDialog)
  })
  createEffect(() => {
    const opened = openedAttachment()
    if (!opened) return
    if (!workbench.isCurrent(opened.session)) {
      setOpenedAttachment(undefined)
      return
    }
    const side = workbench.surface("side")
    if (side.opened() && side.tabs().some((tab) => tab.id === opened.tabID)) return
    setOpenedAttachment(undefined)
    queueMicrotask(() => {
      const origin = opened.origin?.()
      if (origin?.isConnected) origin.focus({ preventScroll: true })
    })
  })

  const openAttachmentPanel = (
    attachment: AttachmentFile,
    init: NonNullable<ReturnType<typeof attachmentWorkbenchPanelInit>>,
    options?: ResourceOpenOptions,
  ) => {
    const session = workbench.sessionKey()
    const server = sdk.url
    const scope = sdk.scopeKey
    const origin = document.activeElement instanceof HTMLElement ? document.activeElement : undefined
    const current = () => !disposed && workbench.isCurrent(session) && sdk.url === server && sdk.scopeKey === scope
    const key = JSON.stringify([server, scope, session, init.resourceId])
    const attempt = async () => {
      if (!current() || attachmentOpenings.has(key)) return
      attachmentOpenings.add(key)
      try {
        const tab = workbench.getPanel("attachment")
          ? await workbench.openPanel("attachment", { reuseExisting: true, init })
          : undefined
        if (!current()) return
        if (!tab) throw new Error("Attachment panel unavailable")
        setOpenedAttachment({ session, tabID: tab.id, origin: options?.focusTarget ?? (() => origin) })
      } catch {
        if (!current()) return
        const toastID = showToast({
          type: "error",
          persistent: true,
          title: _({ id: "app.attachment.openFailed", message: "Couldn’t open attachment" }),
          description: attachment.filename,
          actions: [
            {
              label: _({ id: "app.workspace.panel.retry", message: "Retry" }),
              onClick: () => {
                toaster.dismiss(toastID)
                void attempt()
              },
            },
          ],
        })
      } finally {
        attachmentOpenings.delete(key)
      }
    }
    void attempt()
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

  const openWorkspaceFile = (path: string) => {
    const normalized = path ? file.normalize(path) : undefined
    if (!normalized) return false
    void file.openWorkspaceFile(normalized)
    return true
  }

  const resolveWorkspacePath = (path: string | undefined) => (path ? file.normalize(path) : undefined)

  const openWorkspaceSource = (path: string) => {
    return openWorkspaceFile(path)
  }

  const resolveAttachmentReference = (reference: string, filename?: string) => {
    const attachment = attachmentFromReference(reference, filename)
    return attachment ? { file: attachment, serverUrl: sdk.url } : undefined
  }

  const openUrl = (input: { url: string; mime?: string; filename?: string }): boolean => {
    if (!input.url) return false
    if (input.url.startsWith("asset://")) {
      const resource = resolveAttachmentReference(input.url, input.filename)
      return resource ? openAttachment(resource.file, { serverUrl: resource.serverUrl }) : false
    }
    if (input.mime?.startsWith("image/")) {
      const image = previewImageForUrl(input)
      if (image) {
        dialog.show(() => <ImagePreview images={[image]} />)
        return true
      }
      return false
    }
    window.open(input.url, "_blank", "noopener,noreferrer")
    return true
  }

  const openAttachment = (
    attachment: AttachmentFile,
    options?: ResourceOpenOptions & { serverUrl?: string },
  ): boolean => {
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
      dialogID = dialog.show(
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
    if (options?.prefer === "workspace" && path) return openWorkspaceFile(path)

    const url = resolveAttachmentUrl(options?.serverUrl ?? sdk.url, attachment)
    const target = resolveAttachmentOpenTarget(attachment)
    if (target === "image-preview" && isImageAttachment(attachment) && url && options?.prefer !== "workspace") {
      const image = resolveImagePreviewImage(options?.serverUrl ?? sdk.url, attachment, 0)
      if (!image) return false
      image.sourcePath = resolveWorkspacePath(attachmentSourcePath(attachment))
      dialog.show(
        () => <ImagePreview images={[image]} />,
        () => {
          if (options?.focusTarget) queueMicrotask(() => options.focusTarget?.()?.focus({ preventScroll: true }))
        },
      )
      return true
    }

    if (attachmentPanelInit) {
      return openAttachmentPanel(attachment, attachmentPanelInit, options)
    }

    if (path) return openWorkspaceFile(path)
    if (url) return openUrl({ url, mime: attachment.mime, filename: attachment.filename })
    return false
  }

  const open = (resource: OpenableResource, options?: ResourceOpenOptions) => {
    if (resource.kind === "attachment") {
      return openAttachment(resource.file, { ...options, serverUrl: resource.serverUrl })
    }
    if (resource.kind === "workspace-file") {
      return openWorkspaceFile(resource.path)
    }
    if (resource.kind === "url") {
      const path = fileUrlPath(resource.url)
      if (path) return openWorkspaceFile(path)
      return openUrl(resource)
    }
    return false
  }

  onMount(() => {
    onCleanup(
      plugins.resources.register((resource) => {
        const attachment = resolveAttachmentReference(resource.uri)
        if (attachment) return openAttachment(attachment.file)
        const path = fileUrlPath(resource.uri)
        if (path) return openWorkspaceFile(path)
        if (resource.kind === "file") return openWorkspaceFile(resource.uri)
        if (/^(https?:|data:|blob:)/i.test(resource.uri)) return openUrl({ url: resource.uri })
        return openWorkspaceFile(resource.uri)
      }),
    )
  })

  return (
    <BaseResourceOpenProvider
      value={{
        open,
        openAttachment,
        resolveAttachmentReference,
        resolveWorkspacePath,
        openWorkspaceSource,
        openToolReview,
        openToolActivity,
        isToolActivitySelected,
        openActivityDetail,
        isActivityDetailSelected,
      }}
    >
      {props.children}
    </BaseResourceOpenProvider>
  )
}
