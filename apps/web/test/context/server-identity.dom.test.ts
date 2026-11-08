import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { build } from "vite"
import solidPlugin from "vite-plugin-solid"
import { Persist } from "../../src/utils/persist"
import { spaceKey } from "../../src/context/space-state"

type Server = ReturnType<typeof import("../../src/context/server").useServer>
type Fixture = {
  mount(root: Element, transport: typeof fetch, defaultUrl?: string): { api(): Server; dispose(): void }
}
const first = "94497ff6-b2b3-478e-a3aa-ce77665f0626"
const second = "01487365-5a92-44c6-85bd-3b47c61cb066"
const origin = "https://runtime.example"
const owner = (id: string) => spaceKey({ kind: "personal", localRuntimeID: id })
const key = (target: ReturnType<typeof Persist.global>) => `${target.storage}:${target.key}`

test("the actual server provider gates readiness on verified identity and isolates a replacement at the same URL", async () => {
  const directory = await mkdtemp(path.join(import.meta.dir, ".server-identity-"))
  const entry = path.join(directory, "main.tsx")
  const root = document.createElement("div")
  document.body.append(root)
  localStorage.clear()
  localStorage.setItem(key(Persist.connection(origin, "layout")), JSON.stringify({ sidebar: { width: 310 } }))
  localStorage.setItem(key(Persist.global("layout")), JSON.stringify({ sidebar: { width: 777 } }))
  localStorage.setItem(
    key(Persist.global("server")),
    JSON.stringify({ list: [], scopes: { [origin]: [{ id: "scope-a", expanded: true }] }, legacyScopes: {} }),
  )
  await Bun.write(
    entry,
    `
    import { render } from 'solid-js/web'
    import { DialogProvider, useDialog } from '@ericsanchezok/synergy-ui/context/dialog'
    import { ServerProvider, ServerView, useServer } from ${JSON.stringify(path.resolve(import.meta.dir, "../../src/context/server.tsx"))}
    import { PlatformProvider } from ${JSON.stringify(path.resolve(import.meta.dir, "../../src/context/platform.tsx"))}
    export function mount(root, fetch, defaultUrl = 'https://runtime.example') {
      let api
      function Consumer() { api = useServer(); const dialog=useDialog(); return <><span>{api.runtimeID ?? 'waiting'}</span><button onClick={()=>dialog.show(()=> <div data-private-editor>Private draft</div>)}>Open</button></> }
      const dispose = render(() => <PlatformProvider value={{platform:'web',fetch}}><DialogProvider><ServerProvider defaultUrl={defaultUrl}><ServerView><Consumer/></ServerView></ServerProvider></DialogProvider></PlatformProvider>, root)
      return { api: () => api, dispose }
    }
  `,
  )
  const pending: Array<{ url: string; signal: AbortSignal; resolve(response: Response): void }> = []
  const transport = Object.assign(
    async (input: RequestInfo | URL) => {
      const request = input instanceof Request ? input : new Request(input)
      const url = new URL(request.url)
      if (url.pathname === "/global/health") return Response.json({ healthy: true })
      if (url.pathname === "/global/capabilities")
        return new Promise<Response>((resolve) => pending.push({ url: url.origin, signal: request.signal, resolve }))
      throw new Error(`Unexpected API ${url.pathname}`)
    },
    { preconnect() {} },
  )
  const snapshot = (runtimeID: string) =>
    Response.json({ apiVersion: 1, runtimeID, hostVersion: "test", components: [], features: [] })
  const wait = async (ready: () => boolean) => {
    const deadline = Date.now() + 2000
    while (!ready()) {
      if (Date.now() >= deadline) throw new Error("Server identity did not settle")
      await new Promise((resolve) => setTimeout(resolve, 2))
    }
  }
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
    const fixture = (await import(pathToFileURL(path.join(directory, "dist/fixture.js")).href)) as Fixture
    let mounted = fixture.mount(root, transport)
    try {
      await wait(() => pending.length > 0 || mounted.api().healthy() !== undefined)
      expect(mounted.api().healthy()).toBeUndefined()
      expect(root.querySelector("span")?.textContent).toBe("waiting")
      pending[0]!.resolve(snapshot(first))
      await wait(() => mounted.api().healthy() === true)
      expect(mounted.api().runtimeID).toBe(first)
      expect(mounted.api().cacheKey).toBe(owner(first))
      expect(root.querySelector("span")?.textContent).toBe(first)
      expect(mounted.api().scopes.list()).toEqual([{ id: "scope-a", expanded: true }])
      expect(localStorage.getItem(key(Persist.connection(owner(first), "layout")))).toContain("310")

      root.querySelector("button")!.click()
      await wait(() => !!document.querySelector("[data-private-editor]"))
      mounted.api().refresh()
      await wait(() => pending.length === 2)
      expect(document.querySelector("[data-private-editor]")).toBeNull()
      expect(mounted.api().healthy()).toBeUndefined()
      pending[1]!.resolve(snapshot(second))
      await wait(() => mounted.api().healthy() === true)
      expect(mounted.api().cacheKey).toBe(owner(second))
      expect(mounted.api().scopes.list()).toEqual([])
      expect(localStorage.getItem(key(Persist.connection(owner(second), "layout")))).toBeNull()

      mounted.api().refresh()
      await wait(() => pending.length === 3)
      mounted.api().setActive("https://moved.example")
      expect(mounted.api().healthy()).toBeUndefined()
      expect(mounted.api().runtimeID).toBeUndefined()
      await wait(() => pending.length === 4)
      expect(pending[2]!.signal.aborted).toBe(true)
      pending[3]!.resolve(snapshot(first))
      await wait(() => mounted.api().healthy() === true)
      pending[2]!.resolve(snapshot(second))
      await new Promise((resolve) => setTimeout(resolve, 10))
      expect(mounted.api().url).toBe("https://moved.example")
      expect(mounted.api().cacheKey).toBe(owner(first))
      expect(mounted.api().scopes.list()).toEqual([{ id: "scope-a", expanded: true }])
      expect(mounted.api().acceptIdentity(origin, second)).toBe(false)
      expect(mounted.api().acceptIdentity("https://moved.example", second)).toBe(true)
      expect(mounted.api().cacheKey).toBe(owner(second))
      mounted.api().setActive(origin)
      expect(mounted.api().healthy()).toBeUndefined()
      expect(mounted.api().runtimeID).toBeUndefined()
      mounted.dispose()
      const count = pending.length
      mounted = fixture.mount(root, transport, "https://new-default.example")
      await wait(() => pending.length === count + 1)
      pending.at(-1)!.resolve(snapshot(second))
      await wait(() => mounted.api().healthy() === true)
      mounted.api().scopes.prepare([])
      expect(localStorage.getItem(key(Persist.connection(owner(second), "layout")))).toBeNull()
    } finally {
      mounted.dispose()
    }
  } finally {
    root.remove()
    localStorage.clear()
    await rm(directory, { recursive: true, force: true })
  }
}, 30_000)
