// Focus/blur listener attachment with an explicit detach closure. Kept in its
// own module (no JSX, no kobalte) so the cleanup contract is unit-testable
// without a browser harness.
export function attachFocusListeners(
  elements: readonly unknown[],
  onFocus: () => void,
  onBlur: () => void,
): () => void {
  const attached: HTMLElement[] = []
  for (const element of elements) {
    if (element instanceof HTMLElement) {
      element.addEventListener("focus", onFocus)
      element.addEventListener("blur", onBlur)
      attached.push(element)
    }
  }
  return () => {
    for (const element of attached) {
      element.removeEventListener("focus", onFocus)
      element.removeEventListener("blur", onBlur)
    }
  }
}
