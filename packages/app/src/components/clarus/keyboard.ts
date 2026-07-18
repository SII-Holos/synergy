export interface DisclosureKeyEvent {
  key: string
  preventDefault(): void
}

export function handleDisclosureKeyDown(
  event: DisclosureKeyEvent,
  open: boolean,
  setOpen: (value: boolean) => void,
): void {
  if (event.key !== "Enter" && event.key !== " ") return
  event.preventDefault()
  setOpen(!open)
}
