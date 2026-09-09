import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { build } from "vite"
import solidPlugin from "vite-plugin-solid"

type Harness = {
  setters: {
    setScrolledUp(value: boolean): void
    setMode(value: "latest" | "history"): void
    setTailMissingLatest(value: boolean): void
    setPendingLatest(value: boolean): void
    setHistoryLoading(value: boolean): void
  }
  recoveries(): number
  settle(): void
  dispose(): void
}

// Bun resolves `solid-js` to its server build, where render effects never run.
// The recovery trigger is a reactive effect, so its behavior test must execute
// the client build: bundle the harness through vite-plugin-solid and drive it
// inside happy-dom.
type MountOptions = {
  scrolledUp?: boolean
  mode?: "latest" | "history"
  tailMissingLatest?: boolean
  pendingLatest?: boolean
  historyLoading?: boolean
  deferredRecover?: boolean
}
test("bounded-window bottom recovery fires on due transitions, not on scroll edges", async () => {
  const directory = await mkdtemp(path.join(import.meta.dir, ".bottom-recovery-"))
  const entry = path.join(directory, "main.tsx")
  await Bun.write(
    entry,
    `
    import { createRoot, createSignal } from "solid-js"
    import { createBottomRecoveryTrigger } from "@/context/session-bottom-recovery"

    export function mount(options: {
      scrolledUp?: boolean
      mode?: "latest" | "history"
      tailMissingLatest?: boolean
      pendingLatest?: boolean
      historyLoading?: boolean
      deferredRecover?: boolean
    }) {
      const calls: number[] = []
      let settleRecovery: (() => void) | undefined
      const setters = createRoot((dispose) => {
        const [scrolledUp, setScrolledUp] = createSignal(options.scrolledUp ?? false)
        const [mode, setMode] = createSignal<"latest" | "history">(options.mode ?? "latest")
        const [tailMissingLatest, setTailMissingLatest] = createSignal(options.tailMissingLatest ?? false)
        const [pendingLatest, setPendingLatest] = createSignal(options.pendingLatest ?? false)
        const [historyLoading, setHistoryLoading] = createSignal(options.historyLoading ?? false)
        const recover = () => {
          calls.push(1)
          if (!options.deferredRecover) return
          return new Promise<void>((resolve) => {
            settleRecovery = resolve
          })
        }
        createBottomRecoveryTrigger({ scrolledUp, mode, tailMissingLatest, pendingLatest, historyLoading }, recover)
        return { setScrolledUp, setMode, setTailMissingLatest, setPendingLatest, setHistoryLoading, dispose }
      })
      return {
        setters,
        recoveries: () => calls.length,
        settle: () => settleRecovery?.(),
        dispose: () => setters.dispose(),
      }
    }
  `,
  )
  try {
    await build({
      configFile: false,
      logLevel: "silent",
      resolve: { alias: [{ find: "@", replacement: path.resolve(import.meta.dir, "../../src") }] },
      plugins: [solidPlugin()],
      build: {
        outDir: path.join(directory, "dist"),
        minify: false,
        lib: { entry, formats: ["es"], fileName: "fixture" },
        rollupOptions: { output: { inlineDynamicImports: true } },
      },
    })
    const fixture = (await import(pathToFileURL(path.join(directory, "dist/fixture.js")).href)) as {
      mount(options: MountOptions): Harness
    }
    const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

    // Regression sequence: the user heads back to the bottom while a history
    // load is in flight. The old scroll-edge trigger consumed its only edge
    // there and never repaired the tail-evicted window.
    const parkedUnderLoad = fixture.mount({ mode: "history", tailMissingLatest: true, historyLoading: true })
    await tick()
    expect(parkedUnderLoad.recoveries()).toBe(0)
    parkedUnderLoad.setters.setScrolledUp(false)
    await tick()
    expect(parkedUnderLoad.recoveries()).toBe(0)
    parkedUnderLoad.setters.setHistoryLoading(false)
    await tick()
    expect(parkedUnderLoad.recoveries()).toBe(1)
    parkedUnderLoad.dispose()

    // Streamed arrivals park into a history window the user never left.
    const parkedArrivals = fixture.mount({ mode: "history" })
    await tick()
    expect(parkedArrivals.recoveries()).toBe(0)
    parkedArrivals.setters.setPendingLatest(true)
    await tick()
    expect(parkedArrivals.recoveries()).toBe(1)
    parkedArrivals.dispose()

    // A scrolled-up user never triggers; a load-state flicker under the
    // cursor neither; only returning to the bottom does.
    const scrolledUpUser = fixture.mount({
      mode: "history",
      tailMissingLatest: true,
      pendingLatest: true,
      scrolledUp: true,
    })
    await tick()
    expect(scrolledUpUser.recoveries()).toBe(0)
    scrolledUpUser.setters.setHistoryLoading(true)
    await tick()
    scrolledUpUser.setters.setHistoryLoading(false)
    await tick()
    expect(scrolledUpUser.recoveries()).toBe(0)
    scrolledUpUser.setters.setScrolledUp(false)
    await tick()
    expect(scrolledUpUser.recoveries()).toBe(1)
    scrolledUpUser.dispose()

    // Mounting with a gap already due must not fire on its initial run.
    const initial = fixture.mount({ mode: "history", tailMissingLatest: true, pendingLatest: true })
    await tick()
    expect(initial.recoveries()).toBe(0)
    initial.dispose()

    // Latest mode never recovers, even with a stale gap flag.
    const latest = fixture.mount({ mode: "latest", tailMissingLatest: true })
    await tick()
    latest.setters.setPendingLatest(true)
    await tick()
    expect(latest.recoveries()).toBe(0)
    latest.dispose()

    // An in-flight recovery suppresses overlapping due transitions, and a
    // settled attempt never retries on its own — only a deliberate re-arm does.
    const inFlight = fixture.mount({
      mode: "history",
      tailMissingLatest: true,
      historyLoading: true,
      deferredRecover: true,
    })
    await tick()
    inFlight.setters.setHistoryLoading(false)
    await tick()
    expect(inFlight.recoveries()).toBe(1)
    inFlight.setters.setHistoryLoading(true)
    await tick()
    inFlight.setters.setHistoryLoading(false)
    await tick()
    expect(inFlight.recoveries()).toBe(1)
    inFlight.settle()
    await tick()
    expect(inFlight.recoveries()).toBe(1)
    inFlight.setters.setScrolledUp(true)
    await tick()
    inFlight.setters.setScrolledUp(false)
    await tick()
    expect(inFlight.recoveries()).toBe(2)
    inFlight.dispose()
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}, 60000)
