export type RawMessagesFocusScheduler = (callback: () => void) => void

export function isNarrowRawMessagesLayout(view: Pick<Window, "matchMedia"> = window): boolean {
  return view.matchMedia("(max-width: 767px)").matches
}

export function transferRawMessagesPaneFocus(input: {
  narrow: boolean
  target: HTMLElement | undefined | (() => HTMLElement | undefined)
  schedule?: RawMessagesFocusScheduler
}): boolean {
  if (!input.narrow) return false
  const schedule = input.schedule ?? ((callback) => requestAnimationFrame(callback))
  schedule(() => {
    const target = typeof input.target === "function" ? input.target() : input.target
    target?.focus()
  })
  return true
}

export function updateRawMessagesSelectAll(
  input: HTMLInputElement | undefined,
  state: { all: boolean; partial: boolean },
) {
  if (!input) return
  input.checked = state.all
  input.indeterminate = state.partial
  input.setAttribute("aria-checked", state.partial ? "mixed" : String(state.all))
}
