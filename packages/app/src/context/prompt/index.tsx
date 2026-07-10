import { createStore } from "solid-js/store"
import { createSimpleContext } from "@ericsanchezok/synergy-ui/context"
import { batch, createMemo, createRoot, onCleanup } from "solid-js"
import { useParams } from "@solidjs/router"
import type { FileSelection } from "@/context/file"
import { Persist, persisted } from "@/utils/persist"
import {
  sanitizeContextItemsValue,
  sanitizePromptContextValue,
  sanitizePromptStateValue,
  sanitizePromptValue,
} from "./sanitize"

interface PartBase {
  content: string
  start: number
  end: number
}

export interface TextPart extends PartBase {
  type: "text"
}

export interface FileAttachmentPart extends PartBase {
  type: "file"
  path: string
  selection?: FileSelection
}

export interface UploadedAttachmentPart {
  type: "attachment"
  id: string
  filename: string
  mime: string
  url: string
  size?: number
  metadata?: Record<string, unknown>
  presentation?: {
    hidden?: boolean
    renderer?: "image" | "video" | "audio" | "thumbnail" | "file"
    size?: "original" | "small" | "medium" | "large"
    crop?: boolean
  }
}

export interface NoteAttachmentPart {
  type: "note"
  id: string
  noteId: string
  title: string
  content: string
}

export interface SessionAttachmentPart {
  type: "session"
  id: string
  sessionId: string
  directory: string
  title: string
  updatedAt?: number
}

export type ContentPart =
  | TextPart
  | FileAttachmentPart
  | UploadedAttachmentPart
  | NoteAttachmentPart
  | SessionAttachmentPart
export type Prompt = ContentPart[]

export type FileContextItem = {
  type: "file"
  path: string
  selection?: FileSelection
}

export type ContextItem = FileContextItem

export const DEFAULT_PROMPT: Prompt = [{ type: "text", content: "", start: 0, end: 0 }]

function isSelectionEqual(a?: FileSelection, b?: FileSelection) {
  if (!a && !b) return true
  if (!a || !b) return false
  return (
    a.startLine === b.startLine && a.startChar === b.startChar && a.endLine === b.endLine && a.endChar === b.endChar
  )
}

export function isPromptEqual(promptA: Prompt, promptB: Prompt): boolean {
  if (promptA.length !== promptB.length) return false
  for (let i = 0; i < promptA.length; i++) {
    const partA = promptA[i]
    const partB = promptB[i]
    if (partA.type !== partB.type) return false
    if (partA.type === "text" && partA.content !== (partB as TextPart).content) {
      return false
    }
    if (partA.type === "file") {
      const fileA = partA as FileAttachmentPart
      const fileB = partB as FileAttachmentPart
      if (fileA.path !== fileB.path) return false
      if (!isSelectionEqual(fileA.selection, fileB.selection)) return false
    }
    if (partA.type === "attachment" && partA.id !== (partB as UploadedAttachmentPart).id) {
      return false
    }
    if (partA.type === "note" && partA.id !== (partB as NoteAttachmentPart).id) {
      return false
    }
    if (partA.type === "session" && partA.id !== (partB as SessionAttachmentPart).id) {
      return false
    }
  }
  return true
}

function cloneSelection(selection?: FileSelection) {
  if (!selection) return undefined
  return { ...selection }
}

function clonePart(part: ContentPart): ContentPart {
  if (part.type === "text") return { ...part }
  if (part.type === "attachment") return { ...part }
  if (part.type === "note") return { ...part }
  if (part.type === "session") return { ...part }
  return {
    ...part,
    selection: cloneSelection(part.selection),
  }
}

function clonePrompt(prompt: Prompt): Prompt {
  return prompt.map(clonePart)
}

export function sanitizePrompt(value: unknown): Prompt {
  return sanitizePromptValue(value) as unknown as Prompt
}

export type PromptContextSnapshot = {
  items: ContextItem[]
}

export function keyForContextItem(item: ContextItem) {
  if (item.type !== "file") return item.type
  const startLine = item.selection?.startLine
  const startChar = item.selection?.startChar
  const endLine = item.selection?.endLine
  const endChar = item.selection?.endChar
  return `${item.type}:${item.path}:${startLine}:${startChar}:${endLine}:${endChar}`
}

export function sanitizeContextItems(value: unknown): ContextItem[] {
  const items = sanitizeContextItemsValue(value) as unknown as ContextItem[]
  const seen = new Set<string>()
  const result: ContextItem[] = []
  for (const item of items) {
    const key = keyForContextItem(item)
    if (seen.has(key)) continue
    seen.add(key)
    result.push({ ...item, selection: cloneSelection(item.selection) })
  }
  return result
}

export function sanitizePromptContext(value: unknown): PromptContextSnapshot {
  const context = sanitizePromptContextValue(value)
  return {
    items: sanitizeContextItems(context.items),
  }
}

const WORKSPACE_KEY = "__workspace__"
const MAX_PROMPT_SESSIONS = 20

type PromptSession = ReturnType<typeof createPromptSession>

type PromptCacheEntry = {
  value: PromptSession
  dispose: VoidFunction
}

function createPromptSession(dir: string, id: string | undefined) {
  const legacy = `${dir}/prompt${id ? "/" + id : ""}.v2`

  const [store, setStore, _, ready] = persisted(
    { ...Persist.scoped(dir, id, "prompt", [legacy]), migrate: sanitizePromptStateValue },
    createStore<{
      prompt: Prompt
      cursor?: number
      context: {
        items: (ContextItem & { key: string })[]
      }
    }>({
      prompt: clonePrompt(DEFAULT_PROMPT),
      cursor: undefined,
      context: {
        items: [],
      },
    }),
  )

  return {
    ready,
    current: createMemo(() => store.prompt),
    cursor: createMemo(() => store.cursor),
    dirty: createMemo(() => !isPromptEqual(store.prompt, DEFAULT_PROMPT)),
    context: {
      items: createMemo(() => store.context.items),
      add(item: ContextItem) {
        const sanitized = sanitizeContextItems([item])[0]
        if (!sanitized) return
        const key = keyForContextItem(sanitized)
        if (store.context.items.find((x) => x.key === key)) return
        setStore("context", "items", (items) => [...items, { key, ...sanitized }])
      },
      set(context: PromptContextSnapshot) {
        const next = sanitizePromptContext(context)
        setStore("context", {
          items: next.items.map((item) => ({ key: keyForContextItem(item), ...item })),
        })
      },
      reset() {
        setStore("context", { items: [] })
      },
      remove(key: string) {
        setStore("context", "items", (items) => items.filter((x) => x.key !== key))
      },
    },
    set(prompt: Prompt, cursorPosition?: number) {
      const next = sanitizePrompt(prompt).map(clonePart)
      batch(() => {
        setStore("prompt", next)
        if (cursorPosition !== undefined) setStore("cursor", cursorPosition)
      })
    },
    reset() {
      batch(() => {
        setStore("prompt", clonePrompt(DEFAULT_PROMPT))
        setStore("cursor", 0)
      })
    },
    resetDraft() {
      batch(() => {
        setStore("prompt", clonePrompt(DEFAULT_PROMPT))
        setStore("cursor", 0)
        setStore("context", { items: [] })
      })
    },
  }
}

export const { use: usePrompt, provider: PromptProvider } = createSimpleContext({
  name: "Prompt",
  gate: false,
  init: () => {
    const params = useParams()
    const cache = new Map<string, PromptCacheEntry>()

    const disposeAll = () => {
      for (const entry of cache.values()) {
        entry.dispose()
      }
      cache.clear()
    }

    onCleanup(disposeAll)

    const prune = () => {
      while (cache.size > MAX_PROMPT_SESSIONS) {
        const first = cache.keys().next().value
        if (!first) return
        const entry = cache.get(first)
        entry?.dispose()
        cache.delete(first)
      }
    }

    const load = (dir: string, id: string | undefined) => {
      const key = `${dir}:${id ?? WORKSPACE_KEY}`
      const existing = cache.get(key)
      if (existing) {
        cache.delete(key)
        cache.set(key, existing)
        return existing.value
      }

      const entry = createRoot((dispose) => ({
        value: createPromptSession(dir, id),
        dispose,
      }))

      cache.set(key, entry)
      prune()
      return entry.value
    }

    const session = createMemo(() => load(params.dir!, params.id))

    return {
      ready: () => session().ready(),
      current: () => session().current(),
      cursor: () => session().cursor(),
      dirty: () => session().dirty(),
      context: {
        items: () => session().context.items(),
        add: (item: ContextItem) => session().context.add(item),
        set: (context: PromptContextSnapshot) => session().context.set(context),
        reset: () => session().context.reset(),
        remove: (key: string) => session().context.remove(key),
      },
      set: (prompt: Prompt, cursorPosition?: number) => session().set(prompt, cursorPosition),
      reset: () => session().reset(),
      resetDraft: () => session().resetDraft(),
    }
  },
})
