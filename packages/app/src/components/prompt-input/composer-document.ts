export interface TextRange {
  start: number
  end: number
}

export interface ComposerDocumentSnapshot {
  revision: number
  text: string
  selection: TextRange
  sessionId?: string
  mode: "normal" | "shell"
}

export interface ComposerEdit {
  range: TextRange
  text: string
}

export interface ComposerCompletion {
  revision: number
  position: number
  text: string
}

export interface ComposerDecoration {
  id: string
  range: TextRange
  severity: "info" | "warning" | "error"
  message?: string
  replacement?: string
}

export interface ComposerExtensionRegistration {
  id: string
  order?: number
  onDraftSettled?: (snapshot: ComposerDocumentSnapshot, context: { signal: AbortSignal }) => void | Promise<void>
  onBeforeSubmit?: (snapshot: ComposerDocumentSnapshot, context: { signal: AbortSignal }) => Promise<void>
}

export interface ComposerExtensionService {
  current(): ComposerDocumentSnapshot
  onDraftSettled(handler: NonNullable<ComposerExtensionRegistration["onDraftSettled"]>): () => void
  onBeforeSubmit(handler: NonNullable<ComposerExtensionRegistration["onBeforeSubmit"]>): () => void
  setCompletion(completion: ComposerCompletion | undefined): void
  setDecorations(input: { revision: number; items: ComposerDecoration[] }): void
  applyEdits(input: { revision: number; edits: ComposerEdit[] }): Promise<ComposerDocumentSnapshot>
  dispose(): void
}

type Adapter = {
  read(): Omit<ComposerDocumentSnapshot, "revision">
  applyEdits(edits: ComposerEdit[]): void | Promise<void>
  isEditableRange?(range: TextRange): boolean
}

type OwnedRegistration = ComposerExtensionRegistration & { order: number; degraded: boolean }

export class ComposerDocumentError extends Error {
  constructor(
    readonly code: "stale_revision" | "invalid_range" | "overlapping_edits" | "capability_denied",
    message: string,
  ) {
    super(message)
    this.name = "ComposerDocumentError"
  }
}

export class ComposerDocumentController {
  readonly #adapter: Adapter
  readonly #settleMs: number
  readonly #beforeSubmitTimeoutMs: number
  readonly #registrations = new Map<string, OwnedRegistration>()
  readonly #completions = new Map<string, ComposerCompletion>()
  readonly #decorations = new Map<string, ComposerDecoration[]>()
  readonly #listeners = new Set<() => void>()
  #revision = 0
  #settleTimer?: ReturnType<typeof setTimeout>
  #draftController?: AbortController
  #submitController?: AbortController
  #composing = false
  #submitting = false

  constructor(adapter: Adapter, options?: { settleMs?: number; beforeSubmitTimeoutMs?: number }) {
    this.#adapter = adapter
    this.#settleMs = options?.settleMs ?? 700
    this.#beforeSubmitTimeoutMs = options?.beforeSubmitTimeoutMs ?? 120_000
  }

  current(): ComposerDocumentSnapshot {
    return { ...this.#adapter.read(), revision: this.#revision }
  }

  completion(): ComposerCompletion | undefined {
    const snapshot = this.current()
    return this.#ordered()
      .map((entry) => this.#completions.get(entry.id))
      .find(
        (value) =>
          value?.revision === snapshot.revision &&
          value.position === snapshot.selection.start &&
          snapshot.selection.start === snapshot.selection.end,
      )
  }

  decorations(): ComposerDecoration[] {
    return this.#ordered().flatMap((entry) => this.#decorations.get(entry.id) ?? [])
  }

  submitting() {
    return this.#submitting
  }

  subscribe(listener: () => void) {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  register(input: ComposerExtensionRegistration): () => void {
    if (this.#registrations.has(input.id)) throw new Error(`Composer extension is already registered: ${input.id}`)
    this.#registrations.set(input.id, { ...input, order: input.order ?? 1000, degraded: false })
    this.#scheduleSettled()
    return () => {
      this.#registrations.delete(input.id)
      this.#completions.delete(input.id)
      this.#decorations.delete(input.id)
      this.#notify()
    }
  }

  service(input: {
    id: string
    order?: number
    capabilities: ReadonlySet<"composer.read" | "composer.write" | "composer.intercept">
  }): ComposerExtensionService {
    const registration: ComposerExtensionRegistration = { id: input.id, order: input.order }
    const dispose = this.register(registration)
    let active = true
    const require = (capability: "composer.read" | "composer.write" | "composer.intercept") => {
      if (!active) throw new Error(`Composer extension is disposed: ${input.id}`)
      if (input.capabilities.has(capability)) return
      throw new ComposerDocumentError("capability_denied", `Composer extension requires ${capability}`)
    }
    const setRegistration = (value: Partial<ComposerExtensionRegistration>) => {
      const current = this.#registrations.get(input.id)
      if (!current) throw new Error(`Composer extension is disposed: ${input.id}`)
      Object.assign(current, value)
    }
    return {
      current: () => {
        require("composer.read")
        return this.current()
      },
      onDraftSettled: (handler) => {
        require("composer.read")
        setRegistration({ onDraftSettled: handler })
        this.#scheduleSettled()
        return () => setRegistration({ onDraftSettled: undefined })
      },
      onBeforeSubmit: (handler) => {
        require("composer.intercept")
        setRegistration({ onBeforeSubmit: handler })
        return () => setRegistration({ onBeforeSubmit: undefined })
      },
      setCompletion: (completion) => {
        require("composer.write")
        this.#setCompletion(input.id, completion)
      },
      setDecorations: (value) => {
        require("composer.write")
        this.#setDecorations(input.id, value)
      },
      applyEdits: (value) => {
        require("composer.write")
        return this.applyEdits(value)
      },
      dispose: () => {
        if (!active) return
        active = false
        this.abortSubmit(new DOMException("Composer extension disposed", "AbortError"))
        dispose()
      },
    }
  }

  changed() {
    this.#revision++
    this.#draftController?.abort()
    this.#completions.clear()
    this.#decorations.clear()
    this.#notify()
    this.#scheduleSettled()
  }

  selectionChanged() {
    if (this.#completions.size === 0) return
    this.#completions.clear()
    this.#notify()
  }

  setComposing(value: boolean) {
    this.#composing = value
    if (value) {
      if (this.#settleTimer) clearTimeout(this.#settleTimer)
      return
    }
    this.#scheduleSettled()
  }

  async applyEdits(input: { revision: number; edits: ComposerEdit[] }): Promise<ComposerDocumentSnapshot> {
    const snapshot = this.current()
    if (input.revision !== snapshot.revision) {
      throw new ComposerDocumentError("stale_revision", "Composer document changed before edits were applied")
    }
    const edits = input.edits.toSorted((a, b) => a.range.start - b.range.start || a.range.end - b.range.end)
    for (let index = 0; index < edits.length; index++) {
      const edit = edits[index]!
      if (
        edit.range.start < 0 ||
        edit.range.end < edit.range.start ||
        edit.range.end > snapshot.text.length ||
        this.#adapter.isEditableRange?.(edit.range) === false
      ) {
        throw new ComposerDocumentError("invalid_range", "Composer edit range is not editable")
      }
      if (index > 0 && edits[index - 1]!.range.end > edit.range.start) {
        throw new ComposerDocumentError("overlapping_edits", "Composer edits overlap")
      }
    }
    const effective = edits.filter((edit) => snapshot.text.slice(edit.range.start, edit.range.end) !== edit.text)
    if (effective.length === 0) return snapshot
    await this.#adapter.applyEdits(effective.toReversed())
    this.changed()
    return this.current()
  }

  async beforeSubmit(signal?: AbortSignal) {
    if (this.#submitting) throw new Error("Composer submit hooks are already running")
    this.#submitting = true
    this.#submitController = new AbortController()
    const combined = signal ? AbortSignal.any([signal, this.#submitController.signal]) : this.#submitController.signal
    this.#notify()
    try {
      for (const entry of this.#ordered()) {
        if (!entry.onBeforeSubmit || entry.degraded) continue
        const timeout = AbortSignal.timeout(this.#beforeSubmitTimeoutMs)
        const currentSignal = AbortSignal.any([combined, timeout])
        try {
          await Promise.race([
            entry.onBeforeSubmit(this.current(), { signal: currentSignal }),
            new Promise<never>((_, reject) => {
              if (currentSignal.aborted) reject(currentSignal.reason)
              else currentSignal.addEventListener("abort", () => reject(currentSignal.reason), { once: true })
            }),
          ])
        } catch (error) {
          if (!combined.aborted || timeout.aborted) entry.degraded = true
          throw error
        }
      }
    } finally {
      this.#submitting = false
      this.#submitController = undefined
      this.#notify()
    }
  }

  abortSubmit(reason?: unknown) {
    this.#submitController?.abort(reason)
  }

  dispose() {
    if (this.#settleTimer) clearTimeout(this.#settleTimer)
    this.#draftController?.abort()
    this.#submitController?.abort()
    this.#registrations.clear()
    this.#completions.clear()
    this.#decorations.clear()
    this.#notify()
  }

  #ordered() {
    return [...this.#registrations.values()].toSorted((a, b) => a.order - b.order || a.id.localeCompare(b.id))
  }

  #setCompletion(owner: string, value: ComposerCompletion | undefined) {
    if (!value) this.#completions.delete(owner)
    else {
      const snapshot = this.current()
      if (
        value.revision !== snapshot.revision ||
        value.position !== snapshot.selection.start ||
        snapshot.selection.start !== snapshot.selection.end ||
        !value.text
      ) {
        throw new ComposerDocumentError("stale_revision", "Composer completion does not match the active caret")
      }
      this.#completions.set(owner, value)
    }
    this.#notify()
  }

  #setDecorations(owner: string, input: { revision: number; items: ComposerDecoration[] }) {
    const snapshot = this.current()
    if (input.revision !== snapshot.revision) {
      throw new ComposerDocumentError("stale_revision", "Composer decorations do not match the active document")
    }
    for (const item of input.items) {
      if (item.range.start < 0 || item.range.end < item.range.start || item.range.end > snapshot.text.length) {
        throw new ComposerDocumentError("invalid_range", "Composer decoration range is invalid")
      }
    }
    this.#decorations.set(owner, structuredClone(input.items))
    this.#notify()
  }

  #scheduleSettled() {
    if (this.#composing) return
    if (this.#settleTimer) clearTimeout(this.#settleTimer)
    this.#settleTimer = setTimeout(() => {
      this.#settleTimer = undefined
      this.#draftController?.abort()
      const controller = new AbortController()
      this.#draftController = controller
      const snapshot = this.current()
      for (const entry of this.#ordered()) {
        if (!entry.onDraftSettled || entry.degraded) continue
        void Promise.resolve(entry.onDraftSettled(snapshot, { signal: controller.signal })).catch((error) => {
          if (!controller.signal.aborted && this.current().revision === snapshot.revision) {
            const removedCompletion = this.#completions.delete(entry.id)
            const removedDecorations = this.#decorations.delete(entry.id)
            if (removedCompletion || removedDecorations) this.#notify()
          }
          console.error("Composer extension draft hook failed", {
            extensionId: entry.id,
            error: error instanceof Error ? error.name : "UnknownError",
          })
        })
      }
    }, this.#settleMs)
  }

  #notify() {
    for (const listener of this.#listeners) listener()
  }
}
