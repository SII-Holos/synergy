import type { JSX } from "solid-js"
import type { PluginInputService } from "./ui.js"
import type { SemanticIconTokenName } from "./icons.js"

export interface PluginComposerLayoutService {
  input(): PluginInputService | undefined
  mount(element: HTMLDivElement | undefined): void
  ready(): boolean
  isNewSession(): boolean
  readOnly(): boolean
  isGlobal(): boolean
  pendingText(): string
  scopeName(): string
  branch(): string | undefined
  lastModified(): string | null | undefined
  links(): readonly { id: string; label: string; title: string; icon: SemanticIconTokenName; open(): void }[]
  render(part: "priority" | "greeting" | "inbox" | "delegation" | "status" | "decision"): JSX.Element
}
