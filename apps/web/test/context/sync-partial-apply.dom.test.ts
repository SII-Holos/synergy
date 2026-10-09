import { test, expect } from "bun:test"
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
test("a per-message mark mid-load applies the window and refetches only that message", async () => {
  const dir = await mkdtemp(path.join(import.meta.dir, ".sync-partial-"))
  const entry = path.join(dir, "main.tsx")
  const stub = path.join(dir, "stub.tsx")
  const sync = path.resolve(import.meta.dir, "../../src/context/sync.tsx")
  const freshnessPath = path.resolve(import.meta.dir, "../../src/context/session-part-snapshot-freshness.ts")
  const helper = path.resolve(import.meta.dir, "../../../../packages/ui/src/context/helper.tsx")
  const root = document.createElement("div")
  root.id = "root"
  document.body.append(root)

  await Bun.write(
    stub,
    `
import { createStore } from "solid-js/store"
import { SessionPartSnapshotFreshness } from ${JSON.stringify(freshnessPath)}
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
const releases = {}
const settled = {}
export const callsMade = () => ({ ...calls })
const gate = (key) => settled[key] ? Promise.resolve() : new Promise((resolve) => { releases[key] = resolve })
const releaseGate = (key) => { settled[key] = true; const r = releases[key]; delete releases[key]; if (r) r() }
export const mark = (sessionID, messageID) => freshness.touch("probe", sessionID, messageID, { requiresSnapshot: true })
const msg = (id, created, sessionID) => ({ info: { id, sessionID, role: "user", time: { created } }, parts: [] })
const part = (id, messageID, sessionID, version) => ({
  id, sessionID, type: "text", messageID,
  render: true,
  content: { hash: "h-" + version, version, bytes: 4 },
})
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
      partPage: (input) => { calls.partPage++; return Promise.resolve({
        data: { items: [part("p2b", input.messageID, "ses_1", "v2")], nextCursor: null, previousCursor: null, hasMore: false, hasEarlier: false },
        response: { headers: { get: () => undefined } } }) },
      timelinePage: (_input, options) => new Promise((resolve, reject) => {
        calls.timeline++
        gate("timeline").then(() => resolve({
          data: { items: [msg("m1", 1, "ses_1"), msg("m2", 2, "ses_1")], referencedRoots: [], nextCursor: null, hasMore: false, total: 2 },
          response: { headers: { get: (n) => n === "x-synergy-seq" ? "1" : n === "x-synergy-epoch" ? "epoch-a" : undefined } },
        }))
        options?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))
      }),
      partPages: () => { calls.partPages++; return gate("partPages").then(() => ({
        data: {
          m1: { items: [part("p1", "m1", "ses_1", "v1")], nextCursor: null, previousCursor: null, hasMore: false, hasEarlier: false },
          m2: { items: [part("p2a", "m2", "ses_1", "v1")], nextCursor: null, previousCursor: null, hasMore: false, hasEarlier: false },
        },
        response: { headers: { get: () => undefined } } })) },
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
import { createRoot } from "solid-js"
import { SyncProvider, useSync } from ${JSON.stringify(sync)}
import { callsMade, releaseAll, mark } from ${JSON.stringify(stub)}
let api
function Child() { api = useSync(); return <div>probe</div> }
const dispose = render(() => <SyncProvider><Child /></SyncProvider>, document.getElementById("root"))
const tick = () => new Promise((r) => setTimeout(r, 20))
globalThis.partialProbe = { api: () => api, dispose, callsMade, releaseAll, mark, tick }
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
            session: { sync: (id: string) => Promise<void> }
          }
          dispose: () => void
          callsMade: () => Record<string, number>
          releaseAll: () => void
          mark: (sessionID: string, messageID: string) => void
          tick: () => Promise<void>
        }
      }
    ).partialProbe
    const syncApi = h.api()

    // Start the initial load (timeline held at the gate), then land an
    // authoritative checkpoint for m2 while partPages is still in flight —
    // the mark predates the request capture only for m2.
    const loadP = syncApi.session.sync("ses_1")
    await h.tick()
    h.mark("ses_1", "m2")
    h.releaseAll()
    await loadP
    // Let the targeted refetch settle.
    await h.tick()
    h.dispose()

    expect(h.callsMade().timeline, "the 260KB window must not restart").toBe(1)
    // The targeted refetch for the marked message flows through the plain
    // first-page batch reader, so it shows up as one extra part/pages POST —
    // never a per-message GET storm, and never a second full fan-out batch.
    expect(h.callsMade().partPages, "initial batch plus exactly one targeted refetch").toBe(2)
    expect(h.callsMade().partPage, "targeted reads must batch, not fan out per message").toBe(0)
  } finally {
    root.remove()
    delete (globalThis as { partialProbe?: unknown }).partialProbe
    await rm(dir, { recursive: true, force: true })
  }
}, 60000)
