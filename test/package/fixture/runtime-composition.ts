import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import { createHash } from "node:crypto"

const { assertInstalledPackageBoundaries } = await import("./package-boundary")
await assertInstalledPackageBoundaries()

const mode = process.argv[2]!
const prefix = "@ericsanchezok/synergy-"
const full = mode === "full"
const enabled = (domain: string) => full || mode === domain
const dispose: Array<() => Promise<void>> = []

const { openLocalRuntime } = await import("@ericsanchezok/synergy-runtime-local")
if (enabled("browser")) {
  const owner = await import("@ericsanchezok/synergy-browser-runtime/register")
  owner.registerBrowser()
  dispose.push(owner.disposeBrowser)
}
if (enabled("library")) {
  const owner = await import("@ericsanchezok/synergy-library/register")
  owner.registerLibrary()
  dispose.push(owner.disposeLibrary)
}
if (enabled("note")) (await import("@ericsanchezok/synergy-note/register")).registerNote()

const runtime = full
  ? await (
      await import("@ericsanchezok/synergy-product-runtime/server/runtime-handle")
    ).ProductRuntimeHandle.open({ mode: "server", network: { hostname: "127.0.0.1", port: 0 } })
  : await openLocalRuntime({
      mode: "oneshot",
      services: {
        disposeExtensions: async () => {
          for (const close of dispose) await close()
        },
      },
    })

const { Config, ConfigExtensions, ConfigRegistrationLockedError } = await import(
  "@ericsanchezok/synergy-harness/config"
)
const { ToolRegistry } = await import("@ericsanchezok/synergy-harness/tools")
const { Scope } = await import("@ericsanchezok/synergy-harness/scope")
const { ScopeContext } = await import("@ericsanchezok/synergy-harness/context")
const { Session } = await import("@ericsanchezok/synergy-harness/session")
const { Identifier } = await import("@ericsanchezok/synergy-harness/id/id")
const { ServerProcessLock } = await import("@ericsanchezok/synergy-harness/util/server-process-lock")
const { MigrationRegistry, MigrationRegistrationLockedError } = await import(
  "@ericsanchezok/synergy-harness/persistence"
)
assert.throws(() => ConfigExtensions.register("late-fixture", { shape: {} }), ConfigRegistrationLockedError)
assert.throws(() => MigrationRegistry.register("late-fixture", []), MigrationRegistrationLockedError)
assert.equal(MigrationRegistry.list().has("late-fixture"), false)
let database: { query(sql: string): { get(): unknown } } | undefined

try {
  if (full) {
    assert.ok(runtime.server?.port)
    const health = await fetch(`http://127.0.0.1:${runtime.server.port}/global/health`)
    assert.equal(health.status, 200)
    const { Server } = await import("@ericsanchezok/synergy-server/server/server")
    const spec = await Server.openapi()
    assert.ok(spec.components?.schemas?.Config)
    assert.ok(Object.keys(spec.paths ?? {}).length > 100)
  }
  for (const [domain, field] of [
    ["library", "library"],
    ["media", "voice"],
    ["connections", "channel"],
    ["plugin-host", "plugin"],
    ["agent-integrations", "mcp"],
  ]) {
    assert.equal(field! in Config.Info.shape, enabled(domain!), `unexpected config owner ${domain}`)
  }
  for (const domain of ["browser", "library", "note"]) {
    assert.equal(ToolRegistry.toolProviderIDs().includes(domain), enabled(domain), `unexpected tool owner ${domain}`)
  }
  if (!full) {
    const lockfile = await Bun.file(path.join(process.cwd(), "bun.lock")).text()
    for (const [domain, pkg] of [
      ["browser", "browser-runtime"],
      ["library", "library"],
      ["note", "note"],
      ["media", "media"],
      ["connections", "connections"],
      ["plugin-host", "plugin-host"],
      ["agent-integrations", "agent-integrations"],
      ["workflows", "workflows"],
      ["workbench", "workbench"],
      ["full", "product-runtime"],
    ]) {
      const installed = await fs.access(path.join(process.cwd(), "node_modules", prefix + pkg)).then(
        () => true,
        () => false,
      )
      assert.equal(installed, mode === domain, `unexpected installed domain ${pkg}`)
      assert.equal(lockfile.includes(JSON.stringify(prefix + pkg)), mode === domain, `unexpected locked domain ${pkg}`)
    }
  }
  const directory = path.join(process.cwd(), "workspace")
  await fs.mkdir(directory, { recursive: true })
  const scope = (await Scope.fromDirectory(directory)).scope
  await ScopeContext.provide({
    scope,
    fn: async () => {
      const session = await Session.create({ title: "Installed composition", controlProfile: "full_access" })
      const messageID = Identifier.ascending("message")
      await Session.updateMessage({
        id: messageID,
        sessionID: session.id,
        role: "user",
        time: { created: Date.now() },
        agent: "synergy",
        model: { providerID: "test", modelID: "test" },
      })
      const { BashTool } = await import("@ericsanchezok/synergy-runtime-local/tools/bash")
      const bash = await BashTool.init()
      const result = await bash.execute(
        { command: "printf composition-executed", description: "Verify installed local execution" },
        {
          sessionID: session.id,
          messageID,
          agent: "synergy",
          abort: new AbortController().signal,
          metadata() {},
          async ask() {},
        },
      )
      assert.match(result.output, /composition-executed/)
      if (enabled("browser")) {
        const { BrowserRuntime } = await import("@ericsanchezok/synergy-browser-runtime/runtime")
        const { browserOwnerKey } = await import("@ericsanchezok/synergy-browser")
        const { Global } = await import("@ericsanchezok/synergy-harness/global")
        const owner = { mode: "session" as const, scopeID: scope.id, sessionID: session.id, directory }
        const stateFile = path.join(
          Global.Path.data,
          "browser",
          "sessions-v4",
          `${createHash("sha256").update(browserOwnerKey(owner)).digest("hex")}.json`,
        )
        await Bun.write(
          stateFile,
          JSON.stringify({
            version: 4,
            status: "suspended",
            page: { id: "page-installed", url: "https://example.com/research", title: "Installed Browser" },
            timestamp: Date.now(),
          }),
        )
        const browser = await BrowserRuntime.getOrCreateSession(owner)
        assert.equal(browser.status, "suspended")
        assert.equal(browser.page, null)
        assert.equal(BrowserRuntime.resourceStats().ownerCount, 1)
        assert.equal(BrowserRuntime.resourceStats().processCount, 0)
        await browser.save()
        assert.equal((await Bun.file(stateFile).json()).page?.title, "Installed Browser")
      }
      if (enabled("library")) {
        const { LibraryDB } = await import("@ericsanchezok/synergy-library")
        LibraryDB.Memory.insert(
          {
            id: "installed-memory",
            title: "Research rule",
            content: "Preserve independent runtime",
            category: "general",
            recallMode: "always",
          },
          { id: "embedding-fixture", vector: [1, 0, 0, 0], model: "fixture" },
        )
        assert.equal(LibraryDB.Memory.get("installed-memory")?.content, "Preserve independent runtime")
        assert.equal(LibraryDB.Memory.searchByVector([1, 0, 0, 0], 1)[0]?.id, "installed-memory")
        database = LibraryDB.connection()
      }
      if (enabled("note")) {
        const { NoteStore } = await import("@ericsanchezok/synergy-note")
        const note = await NoteStore.create({ title: "Installed note", kind: "blueprint" })
        const { SessionNoteAccess } = await import("@ericsanchezok/synergy-note/session-contract")
        await SessionNoteAccess.setBlueprintActiveLoop(scope.id, note.id, "installed-loop")
        assert.equal((await NoteStore.get(scope.id, note.id)).blueprint?.activeLoopID, "installed-loop")
        assert.equal((await SessionNoteAccess.getBlueprintNote(scope.id, note.id))?.noteID, note.id)
      }
      await Session.update(session.id, (value) => {
        value.title = "Executed installed composition"
      })
      assert.equal((await Session.get(session.id)).title, "Executed installed composition")
    },
  })
} finally {
  await runtime.close()
  await runtime.close()
}
if (enabled("browser")) {
  const { BrowserRuntime } = await import("@ericsanchezok/synergy-browser-runtime/runtime")
  assert.equal(BrowserRuntime.resourceStats().ownerCount, 0)
  assert.equal(BrowserRuntime.resourceStats().processCount, 0)
}
if (database) assert.throws(() => database!.query("SELECT 1").get())
const ownership = await ServerProcessLock.acquire(undefined, "oneshot")
await ownership.release()
console.log(JSON.stringify({ mode, executed: true, closed: true, optionalOwnersAbsent: !full }))
