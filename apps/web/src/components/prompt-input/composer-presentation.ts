import type { TextRange, ComposerEdit } from "./composer-document"

export type ComposerFormat = "heading" | "bold" | "italic" | "strike" | "list" | "quote" | "link" | "code"

export class ComposerPresentation {
  expanded = false
  view: "edit" | "preview" = "edit"
  manualHeight?: number
  setHeight(value: number | undefined) {
    this.manualHeight = value
    this.changed()
  }
  readonly #listeners = new Set<() => void>()
  subscribe(listener: () => void) {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }
  changed() {
    for (const listener of this.#listeners) listener()
  }
  expand() {
    this.expanded = true
    this.view = "edit"
    this.changed()
  }
  collapse() {
    this.expanded = false
    this.view = "edit"
    this.changed()
  }
  setView(view: "edit" | "preview") {
    this.view = view
    this.changed()
  }
  accepted(unchanged: boolean) {
    if (unchanged) {
      this.manualHeight = undefined
      this.collapse()
    }
  }
}

export function composerBodyLimits(available: number, chrome: number) {
  const manual = Math.max(24, available * 0.6 - chrome)
  const automatic = Math.max(24, Math.min(240, available * 0.4, manual))
  return { minimum: Math.min(96, automatic), automatic, manual }
}

export class ComposerResizeGesture {
  #expand = false
  constructor(readonly initial: { y: number; height: number; maximum: number; minimum: number }) {}
  move(y: number) {
    const desired = this.initial.height + this.initial.y - y
    if (desired >= this.initial.maximum + 32) this.#expand = true
    if (desired <= this.initial.maximum) this.#expand = false
    const excess = Math.max(0, desired - this.initial.maximum)
    return {
      height: Math.min(this.initial.maximum, Math.max(this.initial.minimum, desired)),
      expand: this.#expand,
      progress: Math.min(1, excess / 32),
      pull: (8 * excess) / (excess + 32),
    }
  }
}

export function expandedComposerKeyAction(
  event: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey" | "isComposing">,
) {
  if (event.isComposing) return "edit"
  if (event.key === "Escape") return "collapse"
  if (event.key !== "Enter") return "edit"
  return (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey ? "send" : "newline"
}

export function formatComposerSelection(text: string, range: TextRange, format: ComposerFormat): ComposerEdit {
  if (["heading", "list", "quote"].includes(format)) {
    const start = text.lastIndexOf("\n", Math.max(0, range.start - 1)) + 1
    const next = text.indexOf("\n", range.end)
    const end = next < 0 ? text.length : next
    const prefix = format === "heading" ? "## " : format === "list" ? "- " : "> "
    return {
      range: { start, end },
      text: text
        .slice(start, end)
        .split("\n")
        .map((line) => prefix + line)
        .join("\n"),
    }
  }
  const selected = text.slice(range.start, range.end) || " "
  const marker = format === "bold" ? "**" : format === "italic" ? "*" : format === "strike" ? "~~" : "`"
  return { range, text: format === "link" ? `[${selected}](https://)` : marker + selected + marker }
}

type ComposerPresentationBinding = {
  state: ComposerPresentation
  preview(): {
    text: string
    references: Array<{ start: number; end: number; path: string; mime?: string; filename?: string }>
  }
}
const presentations = new WeakMap<object, ComposerPresentationBinding>()
export function bindComposerPresentation(input: object, binding: ComposerPresentationBinding) {
  presentations.set(input, binding)
  return () => presentations.delete(input)
}
export function composerPresentation(input: object) {
  return presentations.get(input)
}
