import { test, expect } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { build } from "vite"
import solidPlugin from "vite-plugin-solid"

/**
 * Cold-load single-flight (HAR waves 2/3 regression guard):
 * - The route-resolution kick (sync.session.sync at DirectoryLayout mount)
 *   and the page-mount sync() must converge on one fetch chain through
 *   queueSessionSync's satisfied-join: 1x timelinePage, 1x partPages.
 * - A trigger-sync queued while the first load is in flight must re-plan at
 *   execution time; when the first load already established the window and
 *   synced the generation, the chained run must not re-issue the settled
 *   message wave (previously refreshSessionAfterPending replayed a plan
 *   computed while the session was still unstaled).
 */
test("route kick joins the mount sync and queued triggers re-plan without a second wave", async () => {
  const dir = await mkdtemp(path.join(import.meta.dir, ".sync-join-"))
  const entry = path.join(dir, "main.tsx")
  const stub = path.join(dir, "stub.tsx")
  const sync = path.resolve(import.meta.dir, "../../src/context/sync.tsx")
  const helper = path.resolve(import.meta.dir, "../../../../packages/ui/src/context/helper.tsx")
  const root = document.createElement("div")
  root.id = "root"
  document.body.append(root)

  await Bun.write(
    stub,
    `
import { createStore } from "solid-js/store"
const state = createStore({
  status: "ready",
  path: { directory: "probe" },
  scopeID: "probe",
  session: [], message: {}, messageWindow: {}, part: {}, partSummary: {}, partPage: {},
  partVersion: {}, latestContextMessage: {}, session_diff: {}, inbox: {}, todo: {}, dag: {},
  workspaces: [],
})
let current = state
const calls = { timeline: 0, partPages: 0, sessionGet: 0, volatile: 0, permission: 0 }
const releases = {}
const settled = {}
export const callsMade = () => ({ ...calls })
const gate = (key) => settled[key] ? Promise.resolve() : new Promise((resolve) => { releases[key] = resolve })
const releaseGate = (key) => { settled[key] = true; const r = releases[key]; delete releases[key]; if (r) r() }
const msg = (id, created, sessionID) => ({ info: { id, sessionID, role: "user", time: { created } }, parts: [] })
export const useGlobalSync = () => ({
  retainContentCache: (_k, create) => ({ cache: create(), release() {} }),
  retainScopeState: () => ({ state, release: () => {} }),
  peekScopeState: () => current,
  scopeReconnectVersion: () => 0,
  capturePartSnapshotRequest: () => ({}),
  captureResourceRequest: () => ({ generation: 0, revision: 0 }),
  beginContextProjection: () => 0,
  applyResourceResponse: (_s, _m, _r, _req, _h, apply) => { apply(); return true },
  invalidateResource: () => {},
  seedSessionPermissions: () => {},
  seedSessionViewportContent: () => {},
  setLatestContextMessage: () => {},
  touchMessageBucket: () => {},
  reconcileCortexFromSession: () => {},
  markActiveSession: () => {},
  partSnapshotAction: () => "apply",
  partContentStore: { readThrough: (input) => input.read() },
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
      partPage: () => Promise.reject(new Error("unexpected partPage")),
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
          m1: { items: [], nextCursor: null, previousCursor: null, hasMore: false, hasEarlier: false },
          m2: { items: [], nextCursor: null, previousCursor: null, hasMore: false, hasEarlier: false },
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
import { SyncProvider, useSync } from ${JSON.stringify(sync)}
import { callsMade, releaseAll } from ${JSON.stringify(stub)}
let api
function Child() { api = useSync(); return <div>probe</div> }
const dispose = render(() => <SyncProvider><Child /></SyncProvider>, document.getElementById("root"))
const tick = () => new Promise((r) => setTimeout(r, 1))
globalThis.syncJoinProbe = { api: () => api, dispose, callsMade, releaseAll, tick }
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
        syncJoinProbe: {
          api: () => {
            session: {
              preload: (id: string) => Promise<void>
              sync: (
                id: string,
                options?: { trigger?: { type: "workspace-transition" | "history-transition" } },
              ) => Promise<void>
            }
          }
          dispose: () => void
          callsMade: () => Record<string, number>
          releaseAll: () => void
          tick: () => Promise<void>
        }
      }
    ).syncJoinProbe
    const syncApi = h.api()

    // Kick + mount while the timeline page is still unresolved. Per the HAR
    // Kick + mount while the timeline page is still unresolved. Both calls
    // target the identical generation so the second must join the first.
    const kickP = syncApi.session.sync("ses_1")
    const mountP = syncApi.session.sync("ses_1")
    await h.tick()
    // A trigger-sync queued during load replays through the chain; it must
    // re-plan at execution time, refreshing only session metadata once the
    // message window is established rather than re-issuing the settled wave.
    const triggerP = syncApi.session.sync("ses_1", { trigger: { type: "workspace-transition" } })
    await h.tick()
    h.releaseAll()
    await Promise.allSettled([kickP, mountP, triggerP])
    h.dispose()

    expect(h.callsMade().timeline, "timelinePage must be single-flight").toBe(1)
    expect(h.callsMade().partPages, "partPages must be single-flight").toBe(1)
    expect(h.callsMade().sessionGet, "only the trigger's metadata refresh may re-read").toBe(2)
  } finally {
    root.remove()
    delete (globalThis as { syncJoinProbe?: unknown }).syncJoinProbe
    await rm(dir, { recursive: true, force: true })
  }
}, 60000)
