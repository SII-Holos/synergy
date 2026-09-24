import {
  createContext,
  createEffect,
  createMemo,
  createRoot,
  createSignal,
  getOwner,
  onCleanup,
  useContext,
  type ParentProps,
} from "solid-js"
import { createFileDraftStorage, type FileDraft } from "./draft-storage"
export type { FileDraft } from "./draft-storage"
import { createStore, produce } from "solid-js/store"
import { createSimpleContext } from "@ericsanchezok/synergy-ui/context"
import type {
  WorkspaceFileNode,
  WorkspaceFileReadResult,
  WorkspaceFileMoveInput,
  WorkspaceFileCopyInput,
  WorkspaceFileDeleteInput,
} from "@ericsanchezok/synergy-sdk"
import { useParams } from "@solidjs/router"
import { getFilename } from "@ericsanchezok/synergy-util/path"
import { useSDK } from "../sdk"
import { useSync } from "../sync"
import { useWorkbenchPanels } from "../workbench"
import { Persist, persisted } from "@/utils/persist"
import { normalizeWorkspacePath, pdfPreviewAction, pdfPreviewBytes } from "@/components/file-workbench/model"
import { releaseFileSourceWorkspace } from "@/components/file-workbench/source-model-cache"
import {
  fileWorkspace,
  fileWorkspaceKey,
  workspaceFileOwner,
  workspaceFilePath,
  workspaceFileResource,
  type FileWorkspace,
} from "./workspace"
import {
  fileWriteErrorMessage,
  isWorkspaceFileNotFoundError,
  isWorkspaceFileTooLargeError,
  removePathTree,
} from "./errors"

export type FileSelection = {
  startLine: number
  startChar: number
  endLine: number
  endChar: number
}

export type SelectedLineRange = {
  start: number
  end: number
  side?: "additions" | "deletions"
  endSide?: "additions" | "deletions"
}

export type FileViewMode = "source" | "preview"

export type FileViewState = {
  mode?: FileViewMode
  sourceScrollTop?: number
  sourceScrollLeft?: number
  previewScrollTop?: number
  selectedLines?: SelectedLineRange | null
  imageScaleMode?: "fit" | "actual"
}

export type FileDocumentState = {
  draft?: FileDraft
  path: string
  node?: WorkspaceFileNode
  content?: WorkspaceFileReadResult
  loading: boolean
  stale: boolean
  deleted: boolean
  error?: string
  version?: { mtime: number; size: number; contentVersion?: string }
}

export type PdfDocumentState = {
  path: string
  bytes?: Uint8Array
  loading: boolean
  stale: boolean
  tooLarge: boolean
  error?: string
  version?: { mtime: number; size: number }
}

export type ExplorerDirectoryState = {
  items: string[]
  nextCursor?: string
  complete: boolean
  loading: boolean
  stale: boolean
  error?: string
  generation: number
}

export function selectionFromLines(range: SelectedLineRange): FileSelection {
  return {
    startLine: Math.min(range.start, range.end),
    endLine: Math.max(range.start, range.end),
    startChar: 0,
    endChar: 0,
  }
}

function normalizeSelectedLines(range: SelectedLineRange): SelectedLineRange {
  if (range.start <= range.end) return range
  const startSide = range.side
  const endSide = range.endSide ?? startSide
  return {
    ...range,
    start: range.end,
    end: range.start,
    side: endSide,
    endSide: startSide !== endSide ? startSide : undefined,
  }
}

function replacePrefix(value: string, from: string, to: string) {
  if (value === from) return to
  if (!value.startsWith(from + "/")) return value
  return to + value.slice(from.length)
}

function documentBytes(content: WorkspaceFileReadResult | undefined) {
  if (!content) return 0
  if (content.kind === "text") return new Blob([content.content]).size
  if (content.kind === "image") return Math.ceil((content.content.length * 3) / 4)
  return 0
}

const WORKSPACE_KEY = "__workspace__"
const MAX_FILE_VIEW_SESSIONS = 20
const MAX_VIEW_FILES = 500
const MAX_DOCUMENTS = 24
const MAX_DOCUMENT_BYTES = 32 * 1024 * 1024
const MAX_EXPLORER_NODES = 25_000
const DIRECTORY_PAGE_SIZE = 200
const MAX_DIRECTORY_CONCURRENCY = 6
const MAX_DOCUMENT_CONCURRENCY = 3
const MAX_PDF_BUFFERS = 2

type ViewSession = ReturnType<typeof createViewSession>
type ViewCacheEntry = { value: ViewSession; dispose: VoidFunction }

function createViewSession(dir: string, id: string | undefined) {
  const legacyViewKey = `${dir}/file${id ? "/" + id : ""}.v1`
  const [view, setView, , ready] = persisted(
    Persist.scoped(dir, id, "file-view", [legacyViewKey]),
    createStore<{
      file: Record<string, FileViewState>
      explorer: { open: boolean; width: number }
    }>({
      file: {},
      explorer: { open: false, width: 296 },
    }),
  )
  const meta = { pruned: false }

  const prune = (keep?: string) => {
    const keys = Object.keys(view.file)
    if (keys.length <= MAX_VIEW_FILES) return
    const drop = keys.filter((key) => key !== keep).slice(0, keys.length - MAX_VIEW_FILES)
    setView(
      produce((draft) => {
        for (const key of drop) delete draft.file[key]
      }),
    )
  }

  createEffect(() => {
    if (!ready() || meta.pruned) return
    meta.pruned = true
    prune()
  })

  const patchFile = (path: string, patch: Partial<FileViewState>) => {
    setView("file", path, (current) => ({ ...(current ?? {}), ...patch }))
    prune(path)
  }

  return {
    ready,
    state: (path: string) => view.file[path],
    mode: (path: string) => view.file[path]?.mode,
    setMode: (path: string, mode: FileViewMode) => patchFile(path, { mode }),
    sourceScrollTop: (path: string) => view.file[path]?.sourceScrollTop,
    sourceScrollLeft: (path: string) => view.file[path]?.sourceScrollLeft,
    previewScrollTop: (path: string) => view.file[path]?.previewScrollTop,
    selectedLines: (path: string) => view.file[path]?.selectedLines,
    setSourceScroll: (path: string, top: number, left: number) =>
      patchFile(path, { sourceScrollTop: top, sourceScrollLeft: left }),
    setPreviewScrollTop: (path: string, top: number) => patchFile(path, { previewScrollTop: top }),
    setSelectedLines: (path: string, range: SelectedLineRange | null) =>
      patchFile(path, { selectedLines: range ? normalizeSelectedLines(range) : null }),
    imageScaleMode: (path: string) => view.file[path]?.imageScaleMode ?? "fit",
    setImageScaleMode: (path: string, mode: "fit" | "actual") => patchFile(path, { imageScaleMode: mode }),
    explorerOpen: () => view.explorer?.open === true,
    setExplorerOpen: (open: boolean) => setView("explorer", "open", open),
    explorerWidth: () => view.explorer?.width ?? 296,
    setExplorerWidth: (width: number) => setView("explorer", "width", width),
    snapshot: () => ({
      file: Object.fromEntries(Object.entries(view.file).map(([path, state]) => [path, { ...state }])),
      explorer: { ...view.explorer },
    }),
    restore: (snapshot: { file: Record<string, FileViewState>; explorer: { open: boolean; width: number } }) => {
      setView({ file: snapshot.file, explorer: snapshot.explorer })
    },
    clear: () => setView({ file: {}, explorer: { open: false, width: 296 } }),
  }
}

function createWorkspaceFiles(workspace: FileWorkspace | null) {
  const sdk = useSDK()
  const params = useParams()
  const workbench = useWorkbenchPanels()
  const directory = workspace?.path
  const resourceKey = fileWorkspaceKey(sdk.url, sdk.scopeID, workspace)
  let disposed = false
  const reference = () => {
    if (disposed || !workspace) throw new Error("No active Workspace file binding")
    return { workspaceID: workspace.id, workspaceGeneration: workspace.generation }
  }
  const [scope, setScope, , scopeReady] = persisted(
    Persist.workspace(resourceKey, "file-explorer"),
    createStore({ expanded: [] as string[], showHidden: false }),
  )
  const [store, setStore] = createStore<{
    documents: Record<string, FileDocumentState>
    pdfs: Record<string, PdfDocumentState>
    nodes: Record<string, WorkspaceFileNode>
    directories: Record<string, ExplorerDirectoryState>
  }>({ documents: {}, pdfs: {}, nodes: {}, directories: {} })

  const viewCache = new Map<string, ViewCacheEntry>()
  const documentAccess = new Map<string, number>()
  const documentGeneration = new Map<string, number>()
  const documentInflight = new Map<string, Promise<void>>()
  const forcedDocuments = new Map<string, Promise<void>>()
  const pdfAccess = new Map<string, number>()
  const pdfGeneration = new Map<string, number>()
  const pdfInflight = new Map<string, Promise<void>>()
  const directoryInflight = new Map<string, Promise<void>>()
  const controllers = new Set<AbortController>()
  const openInflight = new Map<string, Promise<unknown>>()
  let documentRunning = 0
  let directoryRunning = 0
  const documentWaiters: VoidFunction[] = []
  const directoryWaiters: VoidFunction[] = []

  const normalize = (input: string) => {
    if (!directory) return undefined
    const root = directory.replaceAll("\\", "/").replace(/\/$/, "")
    let value = input
    if (value.startsWith("file://")) {
      try {
        value = decodeURIComponent(new URL(value).pathname)
      } catch {
        return undefined
      }
    }
    value = value.replaceAll("\\", "/")
    if (!root.startsWith("/")) value = value.replace(/^\/(?=[A-Za-z]:\/)/, "")
    if (value === root) return undefined
    if (value.startsWith(root + "/")) value = value.slice(root.length + 1)
    if (value.startsWith("/") || /^[A-Za-z]:\//.test(value)) return undefined
    return normalizeWorkspacePath(value)
  }

  const activePath = createMemo(() => {
    const tab = workbench.surface("side").activeTab()
    return tab?.panelId === "file" &&
      workspaceFileOwner(tab)?.id === workspace?.id &&
      workspaceFileOwner(tab)?.generation === workspace?.generation
      ? workspaceFilePath(tab.resourceId) || undefined
      : undefined
  })
  const openPaths = createMemo(
    () =>
      new Set(
        workbench
          .surface("side")
          .tabs()
          .filter(
            (tab) =>
              tab.panelId === "file" &&
              !!tab.resourceId &&
              workspaceFileOwner(tab)?.id === workspace?.id &&
              workspaceFileOwner(tab)?.generation === workspace?.generation,
          )
          .map((tab) => workspaceFilePath(tab.resourceId)),
      ),
  )

  const disposeViews = () => {
    for (const entry of viewCache.values()) entry.dispose()
    viewCache.clear()
  }
  const loadView = (id: string | undefined) => {
    const key = `${directory}:${id ?? WORKSPACE_KEY}`
    const existing = viewCache.get(key)
    if (existing) {
      viewCache.delete(key)
      viewCache.set(key, existing)
      return existing.value
    }
    const entry = createRoot((dispose) => ({
      value: createViewSession(resourceKey, id),
      dispose,
    }))
    viewCache.set(key, entry)
    while (viewCache.size > MAX_FILE_VIEW_SESSIONS) {
      const first = viewCache.keys().next().value
      if (!first || first === key) break
      viewCache.get(first)?.dispose()
      viewCache.delete(first)
    }
    return entry.value
  }
  const view = createMemo(() => loadView(params.id))
  let previousSessionID = params.id
  let pendingViewTransfer: { from: ViewSession; to: ViewSession } | undefined

  createEffect(() => {
    const nextSessionID = params.id
    if (!previousSessionID && nextSessionID) {
      pendingViewTransfer = { from: loadView(undefined), to: loadView(nextSessionID) }
    }
    previousSessionID = nextSessionID
    const transfer = pendingViewTransfer
    if (!transfer || !transfer.from.ready() || !transfer.to.ready()) return
    transfer.to.restore(transfer.from.snapshot())
    transfer.from.clear()
    pendingViewTransfer = undefined
  })

  const acquire = async (kind: "document" | "directory") => {
    const limit = kind === "document" ? MAX_DOCUMENT_CONCURRENCY : MAX_DIRECTORY_CONCURRENCY
    const waiters = kind === "document" ? documentWaiters : directoryWaiters
    const running = () => (kind === "document" ? documentRunning : directoryRunning)
    if (running() >= limit) await new Promise<void>((resolve) => waiters.push(resolve))
    if (kind === "document") documentRunning += 1
    else directoryRunning += 1
    return () => {
      if (kind === "document") documentRunning -= 1
      else directoryRunning -= 1
      waiters.shift()?.()
    }
  }

  const pruneDocuments = () => {
    const protectedPaths = openPaths()
    const entries = Object.values(store.documents).filter((document) => !!document.content)
    let bytes = entries.reduce((total, document) => total + documentBytes(document.content), 0)
    if (entries.length <= MAX_DOCUMENTS && bytes <= MAX_DOCUMENT_BYTES) return
    const candidates = entries
      .filter((document) => !document.draft && document.path !== activePath() && !protectedPaths.has(document.path))
      .toSorted((a, b) => (documentAccess.get(a.path) ?? 0) - (documentAccess.get(b.path) ?? 0))
    let count = entries.length
    for (const document of candidates) {
      if (count <= MAX_DOCUMENTS && bytes <= MAX_DOCUMENT_BYTES) break
      bytes -= documentBytes(document.content)
      count -= 1
      setStore("documents", document.path, "content", undefined)
      setStore("documents", document.path, "stale", true)
    }
  }
  const prunePdfs = () => {
    const protectedPaths = openPaths()
    const entries = Object.values(store.pdfs).filter((pdf) => !!pdf.bytes)
    if (entries.length <= MAX_PDF_BUFFERS) return
    const candidates = entries
      .filter((pdf) => pdf.path !== activePath() && !protectedPaths.has(pdf.path))
      .toSorted((a, b) => (pdfAccess.get(a.path) ?? 0) - (pdfAccess.get(b.path) ?? 0))
    let count = entries.length
    for (const pdf of candidates) {
      if (count <= MAX_PDF_BUFFERS) break
      count -= 1
      setStore(
        "pdfs",
        pdf.path,
        produce((draft) => {
          draft.bytes = undefined
          draft.stale = true
        }),
      )
    }
  }

  const ensurePdf = (path: string) => {
    if (store.pdfs[path]) return
    setStore("pdfs", path, { path, loading: false, stale: true, tooLarge: false })
  }

  const loadPdf = (input: string, options?: { force?: boolean }) => {
    const path = normalize(input)
    if (disposed || !path) return Promise.resolve()
    ensurePdf(path)
    pdfAccess.set(path, Date.now())
    const document = store.documents[path]
    const nodeSize = document?.node?.size ?? document?.version?.size
    const action = pdfPreviewAction({
      nodeSize,
      hasBytes: !!store.pdfs[path]?.bytes,
      force: options?.force,
    })
    if (action === "too-large") {
      setStore(
        "pdfs",
        path,
        produce((draft) => {
          draft.loading = false
          draft.stale = false
          draft.tooLarge = true
          draft.error = undefined
        }),
      )
      return Promise.resolve()
    }
    if (action === "cached") return Promise.resolve()
    const existing = pdfInflight.get(path)
    if (existing) return existing
    const generation = (pdfGeneration.get(path) ?? 0) + 1
    pdfGeneration.set(path, generation)
    setStore(
      "pdfs",
      path,
      produce((draft) => {
        draft.loading = true
        draft.error = undefined
        draft.tooLarge = false
      }),
    )
    const promise = (async () => {
      const release = await acquire("document")
      const controller = new AbortController()
      controllers.add(controller)
      try {
        if (disposed) return
        const response = await sdk.client.workspace.files.content(
          { ...reference(), path },
          { signal: controller.signal },
        )
        if (disposed || pdfGeneration.get(path) !== generation) return
        const bytes = await pdfPreviewBytes(response.data)
        if (disposed || pdfGeneration.get(path) !== generation) return
        if (!bytes) throw new Error("The server returned an empty PDF response")
        const latest = store.documents[path]
        setStore("pdfs", path, {
          path,
          bytes,
          loading: false,
          stale: false,
          tooLarge: false,
          error: undefined,
          version: latest?.version ?? document?.version,
        })
        prunePdfs()
      } catch (error) {
        if (disposed || controller.signal.aborted) return
        if (disposed || pdfGeneration.get(path) !== generation) return
        if (isWorkspaceFileNotFoundError(error)) {
          setStore(
            "pdfs",
            path,
            produce((draft) => {
              draft.loading = false
              draft.stale = true
              draft.error = "not-found"
            }),
          )
          return
        }
        if (isWorkspaceFileTooLargeError(error)) {
          setStore(
            "pdfs",
            path,
            produce((draft) => {
              draft.loading = false
              draft.stale = false
              draft.tooLarge = true
              draft.error = undefined
            }),
          )
          return
        }
        const message = fileWriteErrorMessage(error) ?? (error instanceof Error ? error.message : String(error))
        setStore(
          "pdfs",
          path,
          produce((draft) => {
            draft.loading = false
            draft.stale = true
            draft.error = message
          }),
        )
      } finally {
        controllers.delete(controller)
        release()
      }
    })().finally(() => pdfInflight.delete(path))
    pdfInflight.set(path, promise)
    return promise
  }

  const pruneExplorer = () => {
    const paths = Object.keys(store.nodes)
    if (paths.length <= MAX_EXPLORER_NODES) return
    const protectedPaths = new Set<string>()
    for (const path of openPaths()) {
      const parts = path.split("/")
      for (let index = 1; index <= parts.length; index += 1) protectedPaths.add(parts.slice(0, index).join("/"))
    }
    const candidates = Object.keys(store.directories)
      .filter((path) => path && !scope.expanded.includes(path))
      .filter((path) => !Array.from(protectedPaths).some((protectedPath) => protectedPath.startsWith(path + "/")))
      .toSorted((a, b) => b.split("/").length - a.split("/").length)
    let remaining = paths.length
    setStore(
      produce((draft) => {
        for (const directory of candidates) {
          if (remaining <= MAX_EXPLORER_NODES) break
          const descendants = Object.keys(draft.nodes).filter(
            (path) => path.startsWith(directory + "/") && !protectedPaths.has(path),
          )
          for (const path of descendants) {
            delete draft.nodes[path]
            remaining -= 1
          }
          for (const path of Object.keys(draft.directories)) {
            if (path.startsWith(directory + "/")) delete draft.directories[path]
          }
          const state = draft.directories[directory]
          if (state) {
            state.items = []
            state.nextCursor = undefined
            state.complete = false
            state.stale = true
            state.generation += 1
          }
        }
      }),
    )
  }

  const ensureDocument = (path: string) => {
    if (store.documents[path]) return
    setStore("documents", path, { path, loading: false, stale: true, deleted: false })
  }

  const load = (input: string, options?: { force?: boolean }): Promise<void> => {
    const path = normalize(input)
    if (disposed || !path) return Promise.resolve()
    ensureDocument(path)
    documentAccess.set(path, Date.now())
    const current = store.documents[path]
    if (!options?.force && current?.content && !current.stale) return Promise.resolve()
    const existing = documentInflight.get(path)
    if (existing) {
      if (!options?.force) return existing
      const queued = forcedDocuments.get(path)
      if (queued) return queued
      const next = existing.then(() => {
        forcedDocuments.delete(path)
        return load(input, options)
      })
      forcedDocuments.set(path, next)
      return next
    }
    const generation = (documentGeneration.get(path) ?? 0) + 1
    documentGeneration.set(path, generation)
    setStore(
      "documents",
      path,
      produce((draft) => {
        draft.loading = true
        draft.error = undefined
      }),
    )
    const promise = (async () => {
      const release = await acquire("document")
      const controller = new AbortController()
      controllers.add(controller)
      try {
        if (disposed) return
        const response = await sdk.client.workspace.files.read(
          { ...reference(), path, mode: "document" },
          { signal: controller.signal },
        )
        if (disposed || documentGeneration.get(path) !== generation) return
        const content = response.data
        if (!content) throw new Error("The server returned an empty file response")
        setStore("documents", path, {
          path,
          node: content.node,
          content,
          loading: false,
          stale: false,
          deleted: false,
          version: {
            mtime: content.node.mtime,
            size: content.node.size,
            contentVersion: content.kind === "binary" ? undefined : content.contentVersion,
          },
          error: undefined,
        })
        setStore("nodes", content.node.path, content.node)
        pruneDocuments()
      } catch (error) {
        if (disposed || controller.signal.aborted) return
        if (isWorkspaceFileNotFoundError(error)) {
          setStore(
            "documents",
            path,
            produce((draft) => {
              draft.loading = false
              draft.stale = false
              draft.deleted = true
              draft.error = undefined
            }),
          )
          return
        }
        const message = error instanceof Error ? error.message : String(error)
        setStore(
          "documents",
          path,
          produce((draft) => {
            draft.loading = false
            draft.stale = true
            draft.error = message
          }),
        )
      } finally {
        controllers.delete(controller)
        release()
      }
    })().finally(() => documentInflight.delete(path))
    documentInflight.set(path, promise)
    return promise
  }

  const backup = createFileDraftStorage(Persist.workspace(resourceKey, "file-drafts"))
  const [backupUnavailable, setBackupUnavailable] = createSignal(!backup.available())
  let draftRevision = 0
  for (const [input, draft] of Object.entries(backup.drafts)) {
    const path = normalize(input)
    if (!path || path !== input) continue
    ensureDocument(path)
    draftRevision = Math.max(draftRevision, draft.revision)
    setStore("documents", path, "draft", draft)
  }
  createEffect(() => {
    const drafts = Object.fromEntries(
      Object.entries(store.documents).flatMap(([path, document]) =>
        document.draft ? [[path, { ...document.draft }]] : [],
      ),
    )
    setBackupUnavailable(!backup.write(drafts))
  })
  const beforeUnload = (event: BeforeUnloadEvent) => {
    if (
      !backupUnavailable() ||
      !Object.values(store.documents).some((document) => document.draft?.content !== document.draft?.baseContent)
    )
      return
    event.preventDefault()
    event.returnValue = ""
  }
  window.addEventListener("beforeunload", beforeUnload)
  onCleanup(() => window.removeEventListener("beforeunload", beforeUnload))
  const draftFor = (input: string) => {
    const path = normalize(input)
    return path ? store.documents[path]?.draft : undefined
  }
  const beginDraft = (input: string) => {
    const path = normalize(input)
    if (!path) throw new Error("Invalid file path")
    if (store.documents[path]?.draft) return
    const content = store.documents[path]?.content
    if (content?.kind !== "text" || !content.contentVersion || content.truncationReason === "size")
      throw new Error("Read the complete file before editing")
    setStore("documents", path, "draft", {
      content: content.content,
      baseContent: content.content,
      expectedVersion: content.contentVersion,
      revision: ++draftRevision,
    })
  }
  const discardDraft = (input: string) => {
    const path = normalize(input)
    if (path && store.documents[path]) setStore("documents", path, "draft", undefined)
  }

  const openWorkspaceFile = (input: string) => {
    const path = normalize(input)
    if (disposed || !workspace || !path) return Promise.resolve(undefined)
    const existing = openInflight.get(path)
    if (existing) return existing
    const promise = workbench
      .openPanel("file", {
        replaceEmpty: true,
        init: {
          resourceId: workspaceFileResource(workspace, path),
          title: getFilename(path),
          source: "workspace",
          state: { workspace },
        },
      })
      .then((tab) => {
        if (disposed) return tab
        void load(path)
        if (view().explorerOpen()) void reveal(path)
        return tab
      })
      .finally(() => openInflight.delete(path))
    openInflight.set(path, promise)
    return promise
  }

  const loadChildren = (input = "", options?: { reset?: boolean; force?: boolean }): Promise<void> => {
    if (disposed || !workspace) return Promise.resolve()
    const normalized = input ? normalize(input) : ""
    if (input && normalized === undefined) return Promise.resolve()
    const path = normalized ?? ""
    const current = store.directories[path]
    if (current?.loading) return directoryInflight.get(path) ?? Promise.resolve()
    if (!options?.force && !options?.reset && current?.complete && !current.stale) return Promise.resolve()
    const reset = options?.reset || !current || current.stale
    const generation = reset ? (current?.generation ?? 0) + 1 : (current?.generation ?? 1)
    const cursor = reset ? undefined : current?.nextCursor
    if (!reset && !cursor) return Promise.resolve()
    setStore("directories", path, {
      items: reset ? (current?.items ?? []) : (current?.items ?? []),
      nextCursor: reset ? undefined : current?.nextCursor,
      complete: false,
      loading: true,
      stale: reset ? !!current?.items.length : false,
      error: undefined,
      generation,
    })
    const promise = (async () => {
      const release = await acquire("directory")
      const controller = new AbortController()
      controllers.add(controller)
      try {
        if (disposed) return
        const response = await sdk.client.workspace.files.children(
          {
            ...reference(),
            path,
            limit: DIRECTORY_PAGE_SIZE,
            cursor,
            showHidden: scope.showHidden ? "true" : "false",
            showIgnored: scope.showHidden ? "true" : "false",
          },
          { signal: controller.signal },
        )
        const data = response.data
        if (disposed || !data || store.directories[path]?.generation !== generation) return
        const incoming = data.children.map((node) => node.path)
        setStore("directories", path, {
          items: Array.from(new Set(reset ? incoming : [...(store.directories[path]?.items ?? []), ...incoming])),
          nextCursor: data.nextCursor,
          complete: !data.truncated,
          loading: false,
          stale: false,
          generation,
        })
        setStore(
          produce((draft) => {
            if (data.parent) draft.nodes[data.parent.path] = data.parent
            for (const node of data.children) draft.nodes[node.path] = node
          }),
        )
        pruneExplorer()
      } catch (error) {
        if (disposed || controller.signal.aborted) return
        if (path && isWorkspaceFileNotFoundError(error)) {
          setScope("expanded", (items) => removePathTree(items, path))
          setStore(
            produce((draft) => {
              for (const key of Object.keys(draft.nodes)) {
                if (key === path || key.startsWith(path + "/")) delete draft.nodes[key]
              }
              for (const key of Object.keys(draft.directories)) {
                if (key === path || key.startsWith(path + "/")) delete draft.directories[key]
              }
              for (const directory of Object.values(draft.directories)) {
                directory.items = removePathTree(directory.items, path)
              }
            }),
          )
          return
        }
        setStore(
          "directories",
          path,
          produce((draft) => {
            draft.loading = false
            draft.stale = true
            draft.error = error instanceof Error ? error.message : String(error)
          }),
        )
      } finally {
        controllers.delete(controller)
        release()
      }
    })().finally(() => directoryInflight.delete(path))
    directoryInflight.set(path, promise)
    return promise
  }

  const isExpanded = (path: string) => scope.expanded.includes(path)
  const setExpanded = (path: string, expanded: boolean) => {
    setScope("expanded", (items) =>
      expanded ? (items.includes(path) ? items : [...items, path]) : items.filter((item) => item !== path),
    )
    if (expanded) void loadChildren(path)
  }
  const reveal = async (input: string) => {
    const path = normalize(input)
    if (!path) return
    const parts = path.split("/").slice(0, -1)
    let current = ""
    await loadChildren("", { force: true })
    for (const part of parts) {
      current = current ? `${current}/${part}` : part
      setExpanded(current, true)
      await loadChildren(current)
    }
  }

  const refresh = () => {
    void loadChildren("", { reset: true, force: true })
    for (const path of scope.expanded) void loadChildren(path, { reset: true, force: true })
    const active = activePath()
    if (active) void load(active, { force: true })
    if (active && store.pdfs[active]) void loadPdf(active, { force: true })
  }

  const renameCachedPath = (from: string, to: string) => {
    const retained = new Set(
      Object.keys(store.documents).filter((key) => {
        const next = replacePrefix(key, from, to)
        return next !== key && (store.documents[key]?.draft || store.documents[next]?.draft)
      }),
    )
    for (const key of Object.keys(store.documents)) {
      const next = replacePrefix(key, from, to)
      if (next === key) continue
      documentGeneration.set(key, (documentGeneration.get(key) ?? 0) + 1)
      documentGeneration.set(next, (documentGeneration.get(next) ?? 0) + 1)
    }
    setStore(
      produce((draft) => {
        for (const key of Object.keys(draft.documents)) {
          const next = replacePrefix(key, from, to)
          if (next === key) continue
          if (retained.has(key)) {
            draft.documents[key]!.deleted = true
            draft.documents[key]!.stale = true
            draft.documents[key]!.loading = false
            continue
          }
          draft.documents[next] = { ...draft.documents[key]!, path: next }
          delete draft.documents[key]
        }
        for (const key of Object.keys(draft.pdfs)) {
          const next = replacePrefix(key, from, to)
          if (next === key) continue
          draft.pdfs[next] = { ...draft.pdfs[key]!, path: next }
          delete draft.pdfs[key]
        }
        for (const key of Object.keys(draft.nodes)) {
          const next = replacePrefix(key, from, to)
          if (next === key) continue
          draft.nodes[next] = { ...draft.nodes[key]!, path: next, name: getFilename(next) }
          delete draft.nodes[key]
        }
        for (const key of Object.keys(draft.directories)) {
          const next = replacePrefix(key, from, to)
          if (next === key) continue
          draft.directories[next] = {
            ...draft.directories[key]!,
            items: draft.directories[key]!.items.map((item) => replacePrefix(item, from, to)),
          }
          delete draft.directories[key]
        }
      }),
    )
    setScope("expanded", (items) => items.map((item) => replacePrefix(item, from, to)))
    for (const key of [...pdfAccess.keys()]) {
      const next = replacePrefix(key, from, to)
      if (next === key) continue
      const access = pdfAccess.get(key)!
      pdfAccess.delete(key)
      pdfAccess.set(next, access)
    }
    for (const tab of workbench.surface("side").tabs()) {
      if (!workspace || tab.panelId !== "file" || !tab.resourceId) continue
      const owner = workspaceFileOwner(tab)
      if (owner?.id !== workspace.id || owner.generation !== workspace.generation) continue
      const current = workspaceFilePath(tab.resourceId)
      const next = replacePrefix(current, from, to)
      if (next === current || retained.has(current)) continue
      workbench.updateTab(tab.id, {
        resourceId: workspaceFileResource(workspace, next),
        title: getFilename(next),
        source: "watcher",
      })
    }
  }

  const stop = sdk.event.listen((message) => {
    const event = message.details
    if (
      event.type !== "file.watcher.updated" ||
      event.properties.workspaceID !== workspace?.id ||
      event.properties.workspaceGeneration !== workspace.generation
    )
      return
    if (event.properties.resync) {
      refresh()
      return
    }
    const path = normalize(event.properties.file)
    if (!path || path.startsWith(".git/")) return
    const parent = normalize(event.properties.parent ?? "") ?? ""
    if (event.properties.event === "renamed") {
      const oldPath = normalize(event.properties.oldPath ?? "")
      if (oldPath) renameCachedPath(oldPath, path)
      void load(path, { force: true })
    } else if (event.properties.event === "deleted") {
      setScope("expanded", (items) => removePathTree(items, path))
      setStore(
        produce((draft) => {
          for (const key of Object.keys(draft.nodes)) {
            if (key === path || key.startsWith(path + "/")) delete draft.nodes[key]
          }
          for (const key of Object.keys(draft.directories)) {
            if (key === path || key.startsWith(path + "/")) delete draft.directories[key]
          }
          for (const directory of Object.values(draft.directories)) {
            directory.items = removePathTree(directory.items, path)
          }
          for (const [key, document] of Object.entries(draft.documents)) {
            if (key === path || key.startsWith(path + "/")) {
              document.deleted = true
              document.stale = true
              document.loading = false
            }
          }
          for (const [key, pdf] of Object.entries(draft.pdfs)) {
            if (key === path || key.startsWith(path + "/")) {
              pdf.stale = true
              pdf.loading = false
            }
          }
        }),
      )
    } else if (event.properties.event === "changed" && store.documents[path]) {
      void load(path, { force: true })
      if (store.pdfs[path]) void loadPdf(path, { force: true })
    } else if (event.properties.event === "added" && store.documents[path]?.deleted) {
      void load(path, { force: true })
    }
    if (store.directories[parent]) void loadChildren(parent, { reset: true, force: true })
  })

  const handleFocus = () => refresh()
  async function entryRequest<T>(request: () => Promise<{ data?: T }>): Promise<T> {
    try {
      const response = await request()
      if (!response.data) throw new Error("The server returned an empty filesystem response")
      return response.data
    } finally {
      if (!disposed) refresh()
    }
  }
  window.addEventListener("focus", handleFocus)
  onCleanup(() => {
    disposed = true
    for (const waiter of [...documentWaiters.splice(0), ...directoryWaiters.splice(0)]) waiter()
    stop()
    window.removeEventListener("focus", handleFocus)
    for (const controller of controllers) controller.abort()
    disposeViews()
    releaseFileSourceWorkspace(resourceKey)
  })

  return {
    workspace,
    resourceKey,
    reference,
    entries: {
      createFile: (path: string, signal?: AbortSignal) =>
        entryRequest(() =>
          sdk.client.workspace.files.write(
            {
              ...reference(),
              workspaceFileWriteFileInput: {
                path,
                content: "",
                encoding: "utf-8",
                expectedVersion: null,
                createParents: false,
                conflictPolicy: "fail",
              },
            },
            { signal },
          ),
        ),
      createDirectory: (path: string, signal?: AbortSignal) =>
        entryRequest(() =>
          sdk.client.workspace.files.createDirectory(
            {
              ...reference(),
              workspaceFileCreateDirectoryInput: { path, createParents: false },
            },
            { signal },
          ),
        ),
      move: (input: WorkspaceFileMoveInput, signal?: AbortSignal) =>
        entryRequest(() =>
          sdk.client.workspace.files.move({ ...reference(), workspaceFileMoveInput: input }, { signal }),
        ),
      copy: (input: WorkspaceFileCopyInput, signal?: AbortSignal) =>
        entryRequest(() =>
          sdk.client.workspace.files.copy({ ...reference(), workspaceFileCopyInput: input }, { signal }),
        ),
      remove: (input: WorkspaceFileDeleteInput, signal?: AbortSignal) =>
        entryRequest(() =>
          sdk.client.workspace.files.remove({ ...reference(), workspaceFileDeleteInput: input }, { signal }),
        ),
    },
    hasDrafts: () => Object.values(store.documents).some((document) => !!document.draft),
    draft: {
      backupUnavailable,
      get: draftFor,
      within: (path: string) =>
        Object.entries(store.documents).some(
          ([key, document]) => !!document.draft && (key === path || key.startsWith(path + "/")),
        ),
      begin: beginDraft,
      discard: discardDraft,
      dirty: (input: string) => {
        const draft = draftFor(input)
        return !!draft && draft.content !== draft.baseContent
      },
      update(input: string, content: string) {
        beginDraft(input)
        const path = normalize(input)!
        setStore("documents", path, "draft", { content, revision: ++draftRevision })
      },
    },
    ready: () => view().ready() && scopeReady(),
    normalize,
    activePath,
    openPaths,
    openWorkspaceFile,
    get: (input: string) => {
      const path = normalize(input)
      return path ? store.documents[path] : undefined
    },
    load,
    pdf: {
      get: (input: string) => {
        const path = normalize(input)
        return path ? store.pdfs[path] : undefined
      },
      load: loadPdf,
    },
    view: {
      state: (input: string) => {
        const path = normalize(input)
        return path ? view().state(path) : undefined
      },
      mode: (input: string) => {
        const path = normalize(input)
        return path ? view().mode(path) : undefined
      },
      setMode: (input: string, mode: FileViewMode) => {
        const path = normalize(input)
        if (path) view().setMode(path, mode)
      },
      sourceScrollTop: (input: string) => {
        const path = normalize(input)
        return path ? view().sourceScrollTop(path) : undefined
      },
      sourceScrollLeft: (input: string) => {
        const path = normalize(input)
        return path ? view().sourceScrollLeft(path) : undefined
      },
      setSourceScroll: (input: string, top: number, left: number) => {
        const path = normalize(input)
        if (path) view().setSourceScroll(path, top, left)
      },
      previewScrollTop: (input: string) => {
        const path = normalize(input)
        return path ? view().previewScrollTop(path) : undefined
      },
      setPreviewScrollTop: (input: string, top: number) => {
        const path = normalize(input)
        if (path) view().setPreviewScrollTop(path, top)
      },
      selectedLines: (input: string) => {
        const path = normalize(input)
        return path ? view().selectedLines(path) : undefined
      },
      setSelectedLines: (input: string, range: SelectedLineRange | null) => {
        const path = normalize(input)
        if (path) view().setSelectedLines(path, range)
      },
      imageScaleMode: (input: string) => {
        const path = normalize(input)
        return path ? view().imageScaleMode(path) : "fit"
      },
      setImageScaleMode: (input: string, mode: "fit" | "actual") => {
        const path = normalize(input)
        if (path) view().setImageScaleMode(path, mode)
      },
    },
    explorer: {
      open: () => view().explorerOpen(),
      setOpen: (open: boolean) => view().setExplorerOpen(open),
      width: () => view().explorerWidth(),
      setWidth: (width: number) => view().setExplorerWidth(Math.max(220, Math.min(420, width))),
      showHidden: () => scope.showHidden,
      setShowHidden: (show: boolean) => {
        setScope("showHidden", show)
        setStore(
          produce((draft) => {
            for (const directory of Object.values(draft.directories)) {
              directory.generation += 1
              directory.stale = true
            }
          }),
        )
        void loadChildren("", { reset: true, force: true })
      },
      expanded: () => scope.expanded,
      isExpanded,
      setExpanded,
      collapseAll: () => setScope("expanded", []),
      node: (path: string) => store.nodes[path],
      directory: (path: string) => store.directories[path],
      loadChildren,
      reveal,
      refresh,
    },
    searchFiles: (query: string, options?: { signal?: AbortSignal; limit?: number; cursor?: string }) =>
      sdk.client.workspace.files
        .search(
          { ...reference(), query, kind: "files", limit: options?.limit ?? 100, cursor: options?.cursor },
          { signal: options?.signal },
        )
        .then((response) => response.data),
    searchFilesAndDirectories: (query: string) =>
      sdk.client.workspace.files
        .search({ ...reference(), query, kind: "files" })
        .then((response) =>
          (response.data?.items ?? []).filter((item) => item.kind === "file").map((item) => item.path),
        ),
    save: async (input: string, content: string, options?: { overwrite?: boolean }) => {
      const path = normalize(input)
      if (!path) throw new Error("Invalid file path")
      const document = store.documents[path]
      const editorDraft = document?.draft ? { ...document.draft } : undefined
      const expectedVersion = editorDraft?.expectedVersion ?? document?.version?.contentVersion
      if (!expectedVersion) throw new Error("Read the complete file before saving")
      const response = await sdk.client.workspace.files.write({
        ...reference(),
        workspaceFileWriteFileInput: {
          path,
          content,
          expectedVersion,
          conflictPolicy: options?.overwrite ? "overwrite" : "fail",
        },
      })
      const result = response.data
      if (disposed) throw new Error("Workspace file context closed during save")
      if (!result) throw new Error("The server returned an empty write response")
      setStore(
        "documents",
        path,
        produce((draft) => {
          if (draft.content?.kind === "text") {
            draft.content = {
              ...draft.content,
              content,
              contentVersion: result.contentVersion,
              truncated: false,
              truncationReason: undefined,
              totalBytes: result.size,
              lineCount: content.split(/\r?\n/).length,
            }
          }
          draft.version = { mtime: result.mtime, size: result.size, contentVersion: result.contentVersion }
          if (draft.draft?.revision === editorDraft?.revision) draft.draft = undefined
          else if (draft.draft && draft.draft.expectedVersion === expectedVersion) {
            draft.draft.baseContent = content
            draft.draft.expectedVersion = result.contentVersion
          }
          draft.stale = false
          draft.error = undefined
        }),
      )
      await load(path, { force: true })
      return result
    },
  }
}

type WorkspaceFiles = ReturnType<typeof createWorkspaceFiles>
const FileOverride = createContext<WorkspaceFiles>()

const { use: useFileManager, provider: FileProvider } = createSimpleContext({
  name: "File",
  gate: false,
  init: () => {
    const sdk = useSDK()
    const sync = useSync()
    const params = useParams()
    const owner = getOwner()
    const entries = new Map<string, { value: WorkspaceFiles; dispose: VoidFunction; users: number }>()
    const selected = createMemo(() => (params.id ? sync.session.get(params.id)?.workspace : sync.data.path.workspace))
    const selectedKey = () => fileWorkspaceKey(sdk.url, sdk.scopeID, fileWorkspace(selected()) ?? null)
    const prune = (keep?: string) => {
      for (const [key, entry] of entries) {
        if (entries.size <= 16) break
        if (key === keep || key === selectedKey() || entry.users || entry.value.hasDrafts()) continue
        entry.dispose()
        entries.delete(key)
      }
    }
    const getEntry = (workspace: FileWorkspace | null) => {
      if (workspace && workspace.scopeID !== sdk.scopeID) throw new Error("File Workspace belongs to another Scope")
      const key = fileWorkspaceKey(sdk.url, sdk.scopeID, workspace)
      let entry = entries.get(key)
      if (!entry) {
        entry = createRoot(
          (dispose) => ({ value: createWorkspaceFiles(workspace ? { ...workspace } : null), dispose, users: 0 }),
          owner,
        )
      }
      entries.delete(key)
      entries.set(key, entry)
      prune(key)
      return entry
    }
    const current = () => getEntry(fileWorkspace(selected()) ?? null).value
    onCleanup(() => {
      for (const entry of entries.values()) entry.dispose()
      entries.clear()
    })
    return {
      retain(workspace: FileWorkspace | null) {
        const entry = getEntry(workspace)
        entry.users++
        return {
          value: entry.value,
          release() {
            entry.users--
            prune()
          },
        }
      },
      current: new Proxy({} as WorkspaceFiles, { get: (_target, key) => Reflect.get(current(), key) }),
    }
  },
})

export { FileProvider }
export function useFile() {
  return useContext(FileOverride) ?? useFileManager().current
}
export function FileWorkspaceProvider(props: ParentProps<{ workspace: FileWorkspace | null }>) {
  const manager = useFileManager()
  const retained = manager.retain(props.workspace)
  onCleanup(retained.release)
  return <FileOverride.Provider value={retained.value}>{props.children}</FileOverride.Provider>
}
