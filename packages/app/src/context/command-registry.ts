import { createMemo, createRoot, createSignal, getOwner, onCleanup, onMount, type Accessor } from "solid-js"

export interface CommandOption {
  id: string
  title: string
  description?: string
  category?: string
  keybind?: string
  slash?: string
  suggested?: boolean
  disabled?: boolean
  onSelect?: (source?: "palette" | "keybind" | "slash") => void | Promise<void>
  onHighlight?: () => (() => void) | void
}

export function createCommandRegistry() {
  const reserved = new Set<string>()
  const [registrations, setRegistrations] = createSignal<Accessor<CommandOption[]>[]>([])
  const options = () => {
    const seen = new Set<string>()
    return registrations().flatMap((registration) =>
      registration().filter((option) => {
        if (seen.has(option.id)) return false
        seen.add(option.id)
        return true
      }),
    )
  }
  return {
    options,
    register(read: Accessor<CommandOption[]>, id?: string) {
      if (id && reserved.has(id)) throw new Error(`Duplicate command ${id}`)
      if (id) reserved.add(id)
      let release: () => void = () => {}
      let results: Accessor<CommandOption[]>
      try {
        results = createRoot((dispose) => {
          release = dispose
          return createMemo(read)
        })
      } catch (error) {
        release()
        if (id) reserved.delete(id)
        throw error
      }
      let disposed = false
      const publish = () => {
        if (!disposed) setRegistrations((entries) => [results, ...entries])
      }
      const dispose = () => {
        if (disposed) return
        disposed = true
        if (id) reserved.delete(id)
        setRegistrations((entries) => entries.filter((entry) => entry !== results))
        release()
      }
      if (getOwner()) {
        onMount(publish)
        onCleanup(dispose)
      } else publish()
      return dispose
    },
    async trigger(id: string, source?: "palette" | "keybind" | "slash") {
      const option = options().find((item) => item.id === id)
      if (!option || option.disabled) return false
      await option.onSelect?.(source)
      return true
    },
  }
}
