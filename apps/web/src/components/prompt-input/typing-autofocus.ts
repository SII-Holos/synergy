export function handleComposerTypingAutofocus(
  event: KeyboardEvent,
  input: HTMLElement | undefined,
  dialogActive: boolean,
) {
  if (event.defaultPrevented) return
  const activeElement = input?.ownerDocument.activeElement as HTMLElement | null
  if (activeElement) {
    const isProtected = activeElement.closest("[data-prevent-autofocus]")
    const isControl = activeElement.closest(
      'button, a[href], summary, [role="button"], [role="tab"], [role="menuitem"]',
    )
    const isInput =
      /^(INPUT|TEXTAREA|SELECT)$/.test(activeElement.tagName) ||
      activeElement.isContentEditable ||
      activeElement.getAttribute("role") === "textbox"
    if (isProtected || isInput || isControl) return
  }
  if (dialogActive) return
  if (activeElement === input) {
    if (event.key === "Escape") input?.blur()
    return
  }
  if (event.key.length === 1 && event.key !== "Unidentified" && !(event.ctrlKey || event.metaKey)) input?.focus()
}
