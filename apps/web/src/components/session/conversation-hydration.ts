import { createEffect, createSignal, on, onCleanup, untrack } from "solid-js"

export function createConversationHydration(options: {
  active: () => boolean
  ready: () => boolean
  surface: () => HTMLElement | undefined
  onHydrated(): void
}) {
  const [hydrated, setHydrated] = createSignal(false)
  createEffect(
    on(options.active, (active) => {
      setHydrated(false)
      if (!active) return
      createEffect(() => {
        if (untrack(hydrated) || !options.ready()) return
        const surface = options.surface()
        if (!surface) return
        let current = true
        let frame: number | undefined
        let delivery: ReturnType<typeof setTimeout> | undefined
        const pending = () => surface.querySelector("[data-markdown-pending]") || document.fonts?.status === "loading"
        const schedule = () => {
          if (!current || frame !== undefined || delivery !== undefined || pending()) return
          frame = requestAnimationFrame(() => {
            frame = requestAnimationFrame(() => {
              frame = undefined
              // Virtua publishes row measurements in RAF; its ResizeObserver pin must finish before motion resumes.
              delivery = setTimeout(() => {
                delivery = undefined
                if (!current || pending()) return
                cleanup()
                setHydrated(true)
                options.onHydrated()
              }, 0)
            })
          })
        }
        const mutations = new MutationObserver(schedule)
        const resize = new ResizeObserver(schedule)
        const cleanup = () => {
          current = false
          if (frame !== undefined) cancelAnimationFrame(frame)
          if (delivery !== undefined) clearTimeout(delivery)
          mutations.disconnect()
          resize.disconnect()
          document.fonts?.removeEventListener("loadingdone", schedule)
          document.fonts?.removeEventListener("loadingerror", schedule)
        }
        mutations.observe(surface, {
          subtree: true,
          childList: true,
          characterData: true,
          attributes: true,
          attributeFilter: ["data-markdown-pending"],
        })
        resize.observe(surface)
        document.fonts?.addEventListener("loadingdone", schedule)
        document.fonts?.addEventListener("loadingerror", schedule)
        schedule()
        onCleanup(cleanup)
      })
    }),
  )
  return hydrated
}
