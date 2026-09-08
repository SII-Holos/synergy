import type {
  PluginTextActionPresentation,
  PluginTextActionWhen,
  PluginTextSelectionSnapshot,
} from "@ericsanchezok/synergy-plugin"
import type { Component } from "solid-js"
import { generateUUID } from "@ericsanchezok/synergy-util/uuid"
import { SlotRegistry, type SlotEntryBase } from "../plugin/slot-registry"

export type TextSelectionSnapshot = PluginTextSelectionSnapshot

export type TextSelectionAnchor = {
  x: number
  y: number
  width: number
  height: number
}

export type TextActionPresentationProps = {
  invocationId: string
  selection: TextSelectionSnapshot
  output: unknown
  close(): void
}

export interface TextAction {
  id: string
  pluginId: string
  pluginName: string
  label: string
  icon?: string
  order: number
  when?: PluginTextActionWhen
  presentation?: {
    kind: PluginTextActionPresentation["kind"]
    width?: PluginTextActionPresentation["width"]
    load(): Promise<{ default: Component<TextActionPresentationProps> }>
  }
  run(input: { selection: TextSelectionSnapshot }, signal: AbortSignal): Promise<unknown>
}

/** Internal slot-backed action: headless text actions live in one slot. */
type TextActionSlotEntry = Omit<SlotEntryBase, "when" | "loader"> & {
  slot: "text.action"
  action: TextAction
}

export type TextActionGroup = {
  pluginId: string
  pluginName: string
  order: number
  actions: TextAction[]
}

type SelectionUpdateOptions = Partial<Omit<TextSelectionSnapshot, "selectionId" | "text">> & {
  excluded?: boolean
  owner?: Element
  anchor?: TextSelectionAnchor
}

const actionOrder = (a: TextAction, b: TextAction) => a.order - b.order || a.id.localeCompare(b.id)

export function groupTextActions(actions: TextAction[]): TextActionGroup[] {
  const groups = new Map<string, TextActionGroup>()
  for (const action of actions) {
    const group = groups.get(action.pluginId) ?? {
      pluginId: action.pluginId,
      pluginName: action.pluginName,
      order: action.order,
      actions: [],
    }
    group.order = Math.min(group.order, action.order)
    group.actions.push(action)
    groups.set(action.pluginId, group)
  }
  return [...groups.values()]
    .map((group) => ({ ...group, actions: group.actions.toSorted(actionOrder) }))
    .toSorted(
      (a, b) => a.order - b.order || a.pluginName.localeCompare(b.pluginName) || a.pluginId.localeCompare(b.pluginId),
    )
}

function actionApplies(action: TextAction, snapshot: TextSelectionSnapshot) {
  const when = action.when
  if (!when) return true
  const length = [...snapshot.text].length
  if (when.sources && !when.sources.includes(snapshot.source)) return false
  if (when.origins && !when.origins.includes(snapshot.origin)) return false
  if (when.minChars !== undefined && length < when.minChars) return false
  if (when.maxChars !== undefined && length > when.maxChars) return false
  if (when.editable !== undefined && snapshot.editable !== when.editable) return false
  return true
}

export class TextSelectionController {
  readonly #settleMs: number
  readonly #maxChars: number
  readonly #listeners = new Set<(snapshot: TextSelectionSnapshot | undefined) => void>()
  readonly #actionListeners = new Set<() => void>()
  readonly #actions = new SlotRegistry<TextActionSlotEntry>()
  #timer?: ReturnType<typeof setTimeout>
  #generation = 0
  #current?: TextSelectionSnapshot
  #owner?: Element
  #anchor?: TextSelectionAnchor
  #tooLarge = false

  constructor(options?: { settleMs?: number; maxChars?: number }) {
    this.#settleMs = options?.settleMs ?? 250
    this.#maxChars = options?.maxChars ?? 10_000
  }

  current() {
    return this.#current ? { ...this.#current } : undefined
  }

  owner() {
    return this.#owner
  }

  anchor() {
    return this.#anchor ? { ...this.#anchor } : undefined
  }

  owns(target: Node | null) {
    if (!this.#owner || !target) return false
    return (
      this.#owner === target ||
      this.#owner.contains(target) ||
      (target instanceof Element && target.contains(this.#owner))
    )
  }

  tooLarge() {
    return this.#tooLarge
  }

  update(text: string | undefined, options: SelectionUpdateOptions = {}) {
    const generation = ++this.#generation
    if (this.#timer) clearTimeout(this.#timer)
    const raw = options.excluded ? "" : (text ?? "")
    const normalized = raw.trim() ? raw : ""
    this.#tooLarge = [...normalized].length > this.#maxChars
    this.#current =
      normalized && !this.#tooLarge
        ? {
            selectionId: generateUUID(),
            text: normalized,
            source: options.source ?? "document",
            origin: options.origin ?? (options.editable ? "editable" : "other"),
            editable: options.editable ?? false,
            wholeContainer: options.wholeContainer ?? false,
          }
        : undefined
    this.#owner = normalized ? options.owner : undefined
    this.#anchor = normalized ? options.anchor : undefined
    this.#timer = setTimeout(() => {
      if (generation !== this.#generation) return
      this.#timer = undefined
      for (const listener of this.#listeners) listener(this.current())
    }, this.#settleMs)
  }

  onSettled(listener: (snapshot: TextSelectionSnapshot | undefined) => void) {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  registerAction(action: TextAction) {
    if (this.#actions.has(action.id)) throw new Error(`Text action is already registered: ${action.id}`)
    const dispose = this.#actions.register({
      id: action.id,
      label: action.label,
      icon: action.icon,
      order: action.order,
      pluginId: action.pluginId,
      slot: "text.action",
      action,
    })
    for (const listener of this.#actionListeners) listener()
    let disposed = false
    return () => {
      if (disposed) return
      disposed = true
      dispose()
      for (const listener of this.#actionListeners) listener()
    }
  }

  actions() {
    return this.#actions
      .listAll()
      .map((entry) => entry.action)
      .toSorted(actionOrder)
  }

  hasAction(id: string) {
    return this.#actions.has(id)
  }

  actionsFor(snapshot: TextSelectionSnapshot) {
    return this.actions().filter((action) => actionApplies(action, snapshot))
  }

  onActionsChanged(listener: () => void) {
    this.#actionListeners.add(listener)
    return () => this.#actionListeners.delete(listener)
  }

  async run(actionId: string, snapshot: TextSelectionSnapshot, signal: AbortSignal) {
    const action = this.#actions.get(actionId)?.action
    if (!action) throw new Error(`Unknown text action: ${actionId}`)
    if (!actionApplies(action, snapshot)) throw new Error("Text action is not available for this selection")
    return action.run({ selection: { ...snapshot } }, signal)
  }

  dispose() {
    if (this.#timer) clearTimeout(this.#timer)
    this.#listeners.clear()
    this.#actionListeners.clear()
    this.#actions.clear()
    this.#current = undefined
    this.#owner = undefined
    this.#anchor = undefined
  }
}

export const textSelectionController = new TextSelectionController()
