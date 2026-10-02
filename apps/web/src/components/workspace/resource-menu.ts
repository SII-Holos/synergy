import type { JSX } from "solid-js"

export const resourceMenuKeyDown: JSX.EventHandler<HTMLDivElement, KeyboardEvent> = (event) => {
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return
  if ((event.target as HTMLElement).closest('input, textarea, [contenteditable="true"]')) return
  const items = Array.from(
    event.currentTarget.querySelectorAll<HTMLElement>(
      '[role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"]',
    ),
  ).filter((item) => !item.hasAttribute("disabled") && item.getAttribute("aria-disabled") !== "true")
  if (!items.length) return
  event.preventDefault()
  const current = items.indexOf(document.activeElement as HTMLElement)
  const index =
    event.key === "Home"
      ? 0
      : event.key === "End"
        ? items.length - 1
        : event.key === "ArrowDown"
          ? (current + 1) % items.length
          : current <= 0
            ? items.length - 1
            : current - 1
  items[index].focus()
}
