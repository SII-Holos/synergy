export interface TextSelectionSnapshot {
  text: string
}

export interface TextAction {
  id: string
  label: string
  icon?: string
  order: number
  run(snapshot: TextSelectionSnapshot, signal: AbortSignal): Promise<void>
}

export class TextSelectionController {
  readonly #settleMs: number
  readonly #maxChars: number
  readonly #listeners = new Set<(snapshot: TextSelectionSnapshot | undefined) => void>()
  readonly #actionListeners = new Set<() => void>()
  readonly #actions = new Map<string, TextAction>()
  #timer?: ReturnType<typeof setTimeout>
  #generation = 0
  #current?: TextSelectionSnapshot
  #tooLarge = false

  constructor(options?: { settleMs?: number; maxChars?: number }) {
    this.#settleMs = options?.settleMs ?? 250
    this.#maxChars = options?.maxChars ?? 10_000
  }

  current() {
    return this.#current ? { ...this.#current } : undefined
  }

  tooLarge() {
    return this.#tooLarge
  }

  update(text: string | undefined, options?: { excluded?: boolean }) {
    const generation = ++this.#generation
    if (this.#timer) clearTimeout(this.#timer)
    const raw = options?.excluded ? "" : (text ?? "")
    const normalized = raw.trim() ? raw : ""
    this.#tooLarge = normalized.length > this.#maxChars
    this.#current = normalized && !this.#tooLarge ? { text: normalized } : undefined
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
    this.#actions.set(action.id, action)
    for (const listener of this.#actionListeners) listener()
    return () => {
      if (!this.#actions.delete(action.id)) return
      for (const listener of this.#actionListeners) listener()
    }
  }

  actions() {
    return [...this.#actions.values()].toSorted((a, b) => a.order - b.order || a.id.localeCompare(b.id))
  }

  onActionsChanged(listener: () => void) {
    this.#actionListeners.add(listener)
    return () => this.#actionListeners.delete(listener)
  }

  async run(actionId: string, signal: AbortSignal) {
    const action = this.#actions.get(actionId)
    const snapshot = this.current()
    if (!action) throw new Error(`Unknown text action: ${actionId}`)
    if (!snapshot) throw new Error("No active text selection")
    await action.run(snapshot, signal)
  }

  dispose() {
    if (this.#timer) clearTimeout(this.#timer)
    this.#listeners.clear()
    this.#actionListeners.clear()
    this.#actions.clear()
    this.#current = undefined
  }
}

export const textSelectionController = new TextSelectionController()
