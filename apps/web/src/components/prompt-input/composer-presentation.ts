import type { PluginInputService } from "@ericsanchezok/synergy-plugin"
import type { TextRange, ComposerEdit } from "./composer-document"

export type ComposerFormat = "heading" | "bold" | "italic" | "strike" | "list" | "quote" | "link" | "code"

export class ComposerPresentation {
  expanded = false
  view: "edit" | "preview" = "edit"
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
    if (unchanged) this.collapse()
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
const presentations = new WeakMap<PluginInputService, ComposerPresentationBinding>()
export function bindComposerPresentation(input: PluginInputService, binding: ComposerPresentationBinding) {
  presentations.set(input, binding)
  return () => presentations.delete(input)
}
export function composerPresentation(input: PluginInputService) {
  return presentations.get(input)
}
