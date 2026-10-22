import type { PluginTextSelectionOrigin, PluginTextSelectionSnapshot } from "@ericsanchezok/synergy-plugin"

export const SENSITIVE_SELECTION_SELECTOR =
  'input[type="password"], [autocomplete="current-password"], [autocomplete="new-password"], [data-sensitive], [data-selection-excluded]'

const OWNER_SELECTOR = "[data-message-id], [data-message], input, textarea, [contenteditable='true']"

function selectionElement(node: Node | null) {
  return node instanceof Element ? node : node?.parentElement
}

export function selectionOwner(node: Node | null) {
  const element = selectionElement(node)
  return element?.closest(OWNER_SELECTOR) ?? element
}

export function sensitiveSelection(node: Node | null) {
  const element = selectionElement(node)
  return !element || !!element.closest(SENSITIVE_SELECTION_SELECTOR)
}

function editableOwner(owner: Element | null | undefined) {
  return !!owner?.closest('input, textarea, [contenteditable="true"]')
}

/**
 * The transcript nests a plain `[data-message]` container inside the row that
 * carries `data-message-role`, so the role has to come from any ancestor
 * rather than from the nearest owner element.
 */
function messageRole(node: Node | null): "user" | "assistant" | undefined {
  const role = selectionElement(node)?.closest<HTMLElement>("[data-message-role]")?.dataset.messageRole
  return role === "user" || role === "assistant" ? role : undefined
}

/**
 * Node order matters: a selection that spans messages has no single owning
 * element, so its endpoints decide the surface before the ancestor does.
 */
export function selectionOrigin(
  owner: Element | null | undefined,
  endpoints: ReadonlyArray<Node | null> = [],
): PluginTextSelectionOrigin {
  for (const node of endpoints) {
    const role = messageRole(node)
    if (role) return role === "user" ? "user_message" : "assistant_message"
  }
  const role = owner ? messageRole(owner) : undefined
  if (role) return role === "user" ? "user_message" : "assistant_message"
  if (editableOwner(owner)) return "editable"
  return "other"
}

/** Reading surfaces raise the toolbar as soon as a selection settles. */
export function opensOnSelection(snapshot: PluginTextSelectionSnapshot) {
  if (snapshot.editable) return false
  if (snapshot.origin === "user_message" || snapshot.origin === "assistant_message") return true
  return snapshot.source === "code" || snapshot.source === "terminal"
}

/** Quoting the user's own unsent draft is not useful. */
export function canQuoteSelection(snapshot: PluginTextSelectionSnapshot) {
  return !snapshot.editable
}
