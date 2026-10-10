import { test, expect } from "bun:test"
import type { SessionTimelinePage } from "@ericsanchezok/synergy-sdk"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { build } from "vite"
import solidPlugin from "vite-plugin-solid"

/**
 * Partial-apply regression guard (HAR waves 2/3):
 * An authoritative per-message part checkpoint landing mid-load marks only
 * that message. The window apply must still land (the 260KB timeline page is
 * not discarded) and only the marked message is force-refetched afterwards.
 * A generation drift still supersedes the whole window.
 */
const timeline: SessionTimelinePage = {
  items: ["m1", "m2"].map((id, index) => ({
    info: {
      id,
      sessionID: "ses_1",
      role: "user",
      time: { created: index + 1 },
      agent: "fixture-agent",
      model: { providerID: "fixture", modelID: "fixture" },
    },
    order: id,
    version: "message-v1",
    content: { version: "message-v1", bytes: 0 },
  })),
  referencedRoots: [],
  nextCursor: null,
  hasMore: false,
  total: 2,
  generation: 0,
}

for (const scenario of [
  "cold",
  "warm",
  "failed-cold",
  "failed-warm",
  "dispose",
  "generation",
  "history",
  "failed-history",
] as const) {
  const history = scenario.includes("history")
  test(`a marked message uses targeted recovery with real timeline items (${scenario})`, async () => {
    const dir = await mkdtemp(path.join(import.meta.dir, ".sync-partial-"))
    const entry = path.join(dir, "main.tsx")
    const stub = path.join(dir, "stub.tsx")
    const sync = path.resolve(import.meta.dir, "../../src/context/sync.tsx")
    const freshnessPath = path.resolve(import.meta.dir, "../../src/context/session-part-snapshot-freshness.ts")
    const summaryPath = path.resolve(import.meta.dir, "../../src/context/part-summary-loader.ts")
    const helper = path.resolve(import.meta.dir, "../../../../packages/ui/src/context/helper.tsx")
    const root = document.createElement("div")
    root.id = "root"
    document.body.append(root)

    await Bun.write(
      stub,
      `
import { createStore } from "solid-js/store"
import { SessionPartSnapshotFreshness } from ${JSON.stringify(freshnessPath)}
import { partSummaryPageState } from ${JSON.stringify(summaryPath)}
const state = createStore({
  status: "ready",
  path: { directory: "probe" },
  scopeID: "probe",
  session: [], message: {}, messageWindow: {}, part: {}, partSummary: {}, partPage: {},
  partVersion: {}, latestContextMessage: {}, session_diff: {}, inbox: {}, todo: {}, dag: {},
  workspaces: [],
})
let current = state
const freshness = new SessionPartSnapshotFreshness()
const calls = { timeline: 0, partPages: 0, partPage: 0, sessionGet: 0, volatile: 0, permission: 0 }
const batches = []
const rangeReads = []
export const requestedRanges = () => rangeReads.map((input) => ({ ...input }))
let failures = ${scenario.startsWith("failed") ? 1 : 0}
const holdTargeted = ${scenario === "dispose"}
export const requestedIDs = () => batches.map((ids) => [...ids])
export const snapshot = () => JSON.parse(JSON.stringify(state[0]))
const releases = {}
const settled = {}
export const callsMade = () => ({ ...calls })
const gate = (key) => settled[key] ? Promise.resolve() : new Promise((resolve) => { releases[key] = resolve })
const releaseGate = (key) => { settled[key] = true; const r = releases[key]; delete releases[key]; if (r) r() }
export const mark = (sessionID, messageID) => freshness.touch("probe", sessionID, messageID, { requiresSnapshot: true })
export const drift = (sessionID) => freshness.releaseSession("probe", sessionID)
const part = (id, messageID, sessionID, version) => ({
  id, sessionID, type: "text", messageID,
  render: true,
  content: { hash: "h-" + version, version, bytes: 4 },
})
if (${scenario.includes("warm") || history}) {
  const summary = part("p2a", "m2", "ses_1", "v0")
  state[1]("partSummary", "m2", [summary])
  state[1]("partPage", "m2", ${history} ? partSummaryPageState({ items: [summary], nextCursor: "parts-after", previousCursor: "parts-before", hasMore: true, hasEarlier: true }) : { nextCursor: null, previousCursor: null, hasMore: false, hasEarlier: false, ranges: [], stale: false })
}
if (${history}) {
  state[1]("message", "ses_1", [${JSON.stringify(timeline.items[1].info)}])
  state[1]("messageWindow", "ses_1", { mode: "history", nextCursor: "older", hasMore: true, pendingLatest: false, pendingLatestIds: [], tailMissingLatest: false })
}
export const useGlobalSync = () => ({
  retainContentCache: (_k, create) => ({ cache: create(), release() {} }),
  retainScopeState: () => ({ state, release: () => {} }),
  peekScopeState: () => current,
  scopeReconnectVersion: () => 0,
  capturePartSnapshotRequest: (_s, m) => freshness.capture("probe", m),
  partSnapshotAction: (_s, m, id, req) => freshness.action("probe", m, id, req),
  partSnapshotGenerationDrifted: (_s, m, req) => freshness.generationDrifted("probe", m, req),
  captureResourceRequest: () => ({ generation: 0, revision: 0 }),
  beginContextProjection: () => 0,
  applyResourceResponse: (_s, _m, _r, _req, _h, apply) => { apply(); return true },
  invalidateResource: () => {},
  seedSessionPermissions: () => {},
  seedSessionViewportContent: (scopeKey, viewport) => {
    const [, setState] = state
    for (const [messageID, page] of Object.entries(viewport.pages)) {
      setState("partSummary", messageID, page.items)
      setState("partPage", messageID, { nextCursor: page.nextCursor, previousCursor: page.previousCursor, hasMore: page.hasMore, hasEarlier: page.hasEarlier, ranges: [], stale: false })
    }
    for (const body of viewport.bodies) setState("part", body.part.messageID, (parts) => [...(parts ?? []).filter((p) => p.id !== body.part.id), body.part])
  },
  setLatestContextMessage: () => {},
  touchMessageBucket: () => {},
  reconcileCortexFromSession: () => {},
  markActiveSession: () => {},
  partContentStore: { read: (_key, load, signal) => load(signal ?? new AbortController().signal) },
  contentBudget: { remove: () => {} },
  data: { scope: [] },
})
export const refreshPlanBlueprintOfferFromLoadedParts = () => {}
export const updatePlanBlueprintOfferState = () => {}
export const useSDK = () => ({
  scopeKey: "probe", scopeID: "probe", url: "http://localhost/", directory: "probe",
  content: { retain: () => ({ release: () => {} }) },
  client: {
    permission: { list: () => { calls.permission++; return Promise.resolve({ data: [] }) } },
    session: {
      get: () => { calls.sessionGet++; return gate("sessionGet").then(() => ({
        data: { id: "ses_1", version: 1, scope: { id: "probe" }, permission: [], title: "t", time: { created: 0, updated: 0 } },
        response: { headers: { get: () => undefined } } })) },
      diff: () => Promise.resolve({ data: [] }),
      inbox: () => Promise.resolve({ data: [] }),
      todo: () => Promise.resolve({ data: [] }),
      dag: () => Promise.resolve({ data: [] }),
      historyText: () => Promise.resolve({ data: { text: "" } }),
      rollbackAck: () => Promise.resolve({}),
      volatileBatch: () => { calls.volatile++; return Promise.resolve({ data: { sessions: {} } }) },
      partContent: () => Promise.reject(new Error("unexpected partContent")),
      partPage: async (input) => {
        calls.partPage++
        rangeReads.push(input)
        await gate("partPages")
        if (${history} && failures) { failures--; throw new Error("targeted summary unavailable") }
        return { data: { items: [part(${history} ? "p2a" : "p2b", input.messageID, "ses_1", "v2")], nextCursor: null, previousCursor: null, hasMore: false, hasEarlier: false }, response: { headers: { get: () => undefined } } }
      },
      timelinePage: (_input, options) => new Promise((resolve, reject) => {
        calls.timeline++
        gate("timeline").then(() => resolve({
          data: ${JSON.stringify(history ? { ...timeline, items: [timeline.items[0]], referencedRoots: [timeline.items[1]] } : timeline)},
          response: { headers: { get: (n) => n === "x-synergy-seq" ? "1" : n === "x-synergy-epoch" ? "epoch-a" : undefined } },
        }))
        options?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))
      }),
      partPages: async (input, options) => {
        const call = ++calls.partPages
        batches.push(input.messageIDs)
        await gate("partPages")
        if (call > 1 && holdTargeted) {
          await new Promise((resolve, reject) => {
            options.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true })
            if (options.signal.aborted) reject(new DOMException("aborted", "AbortError"))
          })
        }
        if (call > 1 && failures) { failures--; throw new Error("targeted summary unavailable") }
        return { data: Object.fromEntries(input.messageIDs.map((id) => [id, {
          items: [part(id === "m1" ? "p1" : "p2a", id, "ses_1", call === 1 ? "v1" : "v2")],
          nextCursor: null, previousCursor: null, hasMore: false, hasEarlier: false,
        }])), response: { headers: { get: () => undefined } } }
      },
    },
  },
})
export const releaseAll = () => { releaseGate("timeline"); releaseGate("partPages"); releaseGate("sessionGet") }
    `,
    )

    await Bun.write(
      entry,
      `
import { render } from "solid-js/web"
import { createEffect, createSignal, Show } from "solid-js"
import { SyncProvider, useSync } from ${JSON.stringify(sync)}
import { callsMade, releaseAll, mark, drift, snapshot, requestedIDs, requestedRanges } from ${JSON.stringify(stub)}
let api
function Child() {
  api = useSync()
  const [failure, setFailure] = createSignal()
  const load = () => api.session.content.summaries("ses_1", "m2").then(() => setFailure(undefined), (error) => setFailure(error))
  createEffect(() => {
    if (${history} && api.data.message.ses_1?.some((message) => message.id === "m2") && api.data.partPage.m2?.stale) void load()
  })
  return <div><span data-retained-summary>{api.data.partSummary.m2?.[0]?.content.version}</span><Show when={failure()}><button data-summary-retry onClick={() => void load()}>Retry</button></Show></div>
}
const dispose = render(() => <SyncProvider><Child /></SyncProvider>, document.getElementById("root"))
const tick = () => new Promise((r) => setTimeout(r, 20))
globalThis.partialProbe = { api: () => api, dispose, callsMade, releaseAll, mark, drift, snapshot, requestedIDs, requestedRanges, tick }
    `,
    )

    try {
      await build({
        configFile: false,
        logLevel: "silent",
        resolve: {
          alias: [
            { find: /^@ericsanchezok\/synergy-ui\/context$/, replacement: helper },
            { find: "@", replacement: path.resolve(import.meta.dir, "../../src") },
          ],
        },
        plugins: [
          {
            name: "scope-fixture",
            enforce: "pre",
            resolveId(source, importer) {
              if (importer === sync && ["./global-sync", "./sdk"].includes(source)) return stub
            },
          },
          solidPlugin(),
        ],
        build: {
          outDir: path.join(dir, "dist"),
          minify: false,
          lib: { entry, formats: ["es"], fileName: "fixture" },
          rollupOptions: { output: { inlineDynamicImports: true } },
        },
      })
      await import(pathToFileURL(path.join(dir, "dist/fixture.js")).href)
      const h = (
        globalThis as unknown as {
          partialProbe: {
            api: () => {
              session: {
                sync: (id: string) => Promise<void>
                content: { summaries: (sessionID: string, messageID: string) => Promise<void> }
                history: { loadMore: (sessionID: string) => Promise<void> }
              }
            }
            dispose: () => void
            callsMade: () => Record<string, number>
            releaseAll: () => void
            mark: (sessionID: string, messageID: string) => void
            drift: (sessionID: string) => void
            requestedIDs: () => string[][]
            requestedRanges: () => {
              sessionID: string
              messageID: string
              partID: string
              limit: number
              cursor?: string
              older: boolean
            }[]
            snapshot: () => {
              message: Record<string, { id: string }[]>
              partSummary: Record<string, { id: string; content: { version: string } }[]>
              partPage: Record<string, { stale: boolean; nextCursor: string | null; previousCursor: string | null }>
            }
            tick: () => Promise<void>
          }
        }
      ).partialProbe
      const syncApi = h.api()

      // Start the initial load (timeline held at the gate), then land an
      // authoritative checkpoint for m2 while partPages is still in flight —
      // the mark predates the request capture only for m2.
      const loadP = history ? syncApi.session.history.loadMore("ses_1") : syncApi.session.sync("ses_1")
      await h.tick()
      if (scenario === "generation") h.drift("ses_1")
      else h.mark("ses_1", "m2")
      h.releaseAll()
      await loadP
      // Let the targeted refetch settle.
      await h.tick()

      if (scenario === "generation") {
        expect(h.callsMade().timeline).toBe(2)
        expect(h.requestedIDs()).toEqual([
          ["m1", "m2"],
          ["m1", "m2"],
        ])
        expect(h.snapshot().message.ses_1.map((message) => message.id)).toEqual(["m1", "m2"])
      } else if (history) {
        expect(h.callsMade().timeline, "the retained history window must not restart").toBe(1)
        expect(h.requestedIDs()).toEqual([])
        expect(h.requestedRanges(), "the mounted consumer must join the single repair owner").toEqual([
          { sessionID: "ses_1", messageID: "m2", partID: "p2a", limit: 1, cursor: undefined, older: false },
        ])
        expect(h.snapshot().message.ses_1.map((message) => message.id)).toEqual(["m1", "m2"])
        if (scenario === "failed-history") {
          expect(root.querySelector("[data-retained-summary]")?.textContent).toBe("v0")
          expect(h.snapshot().partPage.m2.stale).toBe(true)
          const retry = root.querySelector<HTMLButtonElement>("[data-summary-retry]")
          expect(retry, "the mounted consumer owns the failed repair").not.toBeNull()
          retry!.click()
          await h.tick()
          expect(h.callsMade().partPage).toBe(2)
          expect(root.querySelector("[data-summary-retry]")).toBeNull()
        }
        expect(root.querySelector("[data-retained-summary]")?.textContent).toBe("v2")
        expect(h.snapshot().partPage.m2).toMatchObject({
          stale: false,
          nextCursor: "parts-after",
          previousCursor: "parts-before",
        })
      } else {
        expect(h.callsMade().timeline, "the window must not restart").toBe(1)
        expect(h.requestedIDs()).toEqual([["m1", ...(scenario.includes("warm") ? [] : ["m2"])], ["m2"]])
        expect(h.callsMade().partPage, "first-page targeted reads must batch").toBe(0)
        expect(h.snapshot().message.ses_1.map((message) => message.id)).toEqual(["m1", "m2"])
        expect(h.snapshot().partSummary.m1[0].content.version).toBe("v1")
        if (scenario.startsWith("failed")) {
          if (scenario === "failed-warm") {
            expect(h.snapshot().partSummary.m2[0].content.version).toBe("v0")
            expect(h.snapshot().partPage.m2.stale).toBe(true)
          } else expect(h.snapshot().partPage.m2).toBeUndefined()
          await syncApi.session.content.summaries("ses_1", "m2")
          expect(h.requestedIDs().at(-1)).toEqual(["m2"])
          expect(h.callsMade().partPages).toBe(3)
        }
        if (scenario !== "dispose") {
          expect(h.snapshot().partSummary.m2[0].content.version).toBe("v2")
          expect(h.snapshot().partPage.m2.stale).toBe(false)
        }
      }
      const cancelled =
        scenario === "dispose"
          ? syncApi.session.content.summaries("ses_1", "m2").then(
              () => undefined,
              (error: unknown) => error,
            )
          : undefined
      h.dispose()
      if (scenario === "dispose") {
        expect(await cancelled).toMatchObject({ name: "AbortError" })
        const before = h.callsMade()
        await syncApi.session.content.summaries("ses_1", "m2")
        await h.tick()
        expect(h.callsMade()).toEqual(before)
        expect(h.snapshot().partSummary.m2).toBeUndefined()
      }
    } finally {
      ;(globalThis as { partialProbe?: { dispose: () => void } }).partialProbe?.dispose()
      root.remove()
      delete (globalThis as { partialProbe?: unknown }).partialProbe
      await rm(dir, { recursive: true, force: true })
    }
  }, 60000)
}
