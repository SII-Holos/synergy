import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { build } from "vite"
import solidPlugin from "vite-plugin-solid"

type Harness = {
  setters: {
    setSessionID(value: string | undefined): void
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

type MountOptions = {
  sessionID?: string
  scrolledUp?: boolean
  mode?: "latest" | "history"
  tailMissingLatest?: boolean
  pendingLatest?: boolean
  historyLoading?: boolean
  deferredRecover?: boolean
}

// Bun resolves `solid-js` to its server build, where render effects never run.
// The recovery trigger is a reactive effect, so its behavior test must execute
// the client build: bundle the harness through vite-plugin-solid and drive it
// inside happy-dom.
test("bounded-window bottom recovery fires on due transitions for engaged sessions", async () => {
  const directory = await mkdtemp(path.join(import.meta.dir, ".bottom-recovery-"))
  const entry = path.join(directory, "main.tsx")
  await Bun.write(
    entry,
    `
    import { createRoot, createSignal } from "solid-js"
    import { createBottomRecoveryTrigger } from "@/context/session-bottom-recovery"

    export function mount(options: {
      sessionID?: string
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
        const [sessionID, setSessionID] = createSignal(options.sessionID)
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
        createBottomRecoveryTrigger(
          { sessionID, scrolledUp, mode, tailMissingLatest, pendingLatest, historyLoading },
          recover,
        )
        return { setSessionID, setScrolledUp, setMode, setTailMissingLatest, setPendingLatest, setHistoryLoading, dispose }
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
    // Solid flushes render effects on the microtask queue.
    const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

    // Regression sequence: the user heads back to the bottom while a history
    // load is in flight. The load marks engagement; when it finishes the
    // tail-evicted window must recover. The old scroll-edge trigger consumed
    // its only edge there and never repaired the window.
    const parkedUnderLoad = fixture.mount({
      sessionID: "s1",
      mode: "history",
      tailMissingLatest: true,
      historyLoading: true,
    })
    await tick()
    expect(parkedUnderLoad.recoveries()).toBe(0)
    parkedUnderLoad.setters.setScrolledUp(false)
    await tick()
    expect(parkedUnderLoad.recoveries()).toBe(0)
    parkedUnderLoad.setters.setHistoryLoading(false)
    await tick()
    expect(parkedUnderLoad.recoveries()).toBe(1)
    parkedUnderLoad.dispose()

    // An engaged user (a "Load earlier" flicker) parked at the bottom of a
    // gap-less history window sees parked arrivals recover.
    const engagedArrivals = fixture.mount({ sessionID: "s2", mode: "history" })
    await tick()
    expect(engagedArrivals.recoveries()).toBe(0)
    engagedArrivals.setters.setHistoryLoading(true)
    await tick()
    engagedArrivals.setters.setHistoryLoading(false)
    await tick()
    expect(engagedArrivals.recoveries()).toBe(0)
    engagedArrivals.setters.setPendingLatest(true)
    await tick()
    expect(engagedArrivals.recoveries()).toBe(1)
    engagedArrivals.dispose()

    // A disengaged session never fires — arrivals parking into a history
    // window nobody engaged with stay parked behind the explicit button.
    const disengagedArrivals = fixture.mount({ sessionID: "s3", mode: "history" })
    await tick()
    disengagedArrivals.setters.setTailMissingLatest(true)
    await tick()
    disengagedArrivals.setters.setPendingLatest(true)
    await tick()
    expect(disengagedArrivals.recoveries()).toBe(0)
    disengagedArrivals.dispose()

    // Navigating onto a retained history window must not discard the stored
    // view — neither from a bottom-pinned session nor from a scrolled-up one
    // whose late scrolledUp reset lands after the route change.
    const nav = fixture.mount({ sessionID: "a", mode: "latest" })
    await tick()
    expect(nav.recoveries()).toBe(0)
    nav.setters.setSessionID("b")
    await tick()
    nav.setters.setMode("history")
    await tick()
    nav.setters.setTailMissingLatest(true)
    await tick()
    nav.setters.setPendingLatest(true)
    await tick()
    expect(nav.recoveries()).toBe(0)
    nav.setters.setScrolledUp(true)
    await tick()
    nav.setters.setSessionID("c")
    await tick()
    nav.setters.setMode("history")
    await tick()
    nav.setters.setScrolledUp(false)
    await tick()
    expect(nav.recoveries()).toBe(0)
    // Engagement arms the new session; the next due level fires.
    nav.setters.setScrolledUp(true)
    await tick()
    nav.setters.setScrolledUp(false)
    await tick()
    expect(nav.recoveries()).toBe(1)
    nav.dispose()

    // A scrolled-up user never triggers; a load-state flicker under the
    // cursor neither; only returning to the bottom does.
    const scrolledUpUser = fixture.mount({
      sessionID: "s4",
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

    // Latest mode never recovers, even with a stale gap flag.
    const latest = fixture.mount({ sessionID: "s5", mode: "latest", tailMissingLatest: true })
    await tick()
    latest.setters.setPendingLatest(true)
    await tick()
    expect(latest.recoveries()).toBe(0)
    latest.dispose()

    // An in-flight recovery suppresses overlapping due transitions, and a
    // settled attempt never retries on its own — only a deliberate re-arm does.
    const inFlight = fixture.mount({
      sessionID: "s6",
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
    // A settled failure whose gap state is unchanged must not retry: the
    // latch stays consumed until the predicate is observed false again, so a
    // re-evaluation with the gap still present does not re-fire.
    inFlight.setters.setPendingLatest(true)
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
