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
const { createLocalHost } = await import("@ericsanchezok/synergy-local-runtime")
const { openAgentRuntime } = await import("@ericsanchezok/synergy-agent-runtime")
const host = createLocalHost()
const factories: Record<string, [string, string]> = {
  browser: ["browser-runtime", "browser"],
  library: ["library", "library"],
  note: ["note", "note"],
  mcp: ["mcp", "mcp"],
  lsp: ["lsp", "lsp"],
  server: ["server", "server"],
}
const selected = factories[mode]
const components = selected ? [(await import(`${prefix}${selected[0]}/component`))[selected[1]]()] : []
const runtime = full
  ? await (
      await import("@ericsanchezok/synergy-presets")
    ).PresetRuntimeHandle.open({
      host,
      mode: "server",
      network: { hostname: "127.0.0.1", port: 0 },
    })
  : await openAgentRuntime({
      home: host.root,
      host,
      components,
      mode: mode === "server" ? "server" : "oneshot",
      network: { hostname: "127.0.0.1", port: 0 },
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
let database: { query(sql: string): { get(): unknown } } | undefined
try {
  await runtime.run(async () => {
    assert.throws(() => ConfigExtensions.register("late-fixture", { shape: {} }), ConfigRegistrationLockedError)
    assert.throws(() => MigrationRegistry.register("late-fixture", []), MigrationRegistrationLockedError)
    assert.equal(MigrationRegistry.list().has("late-fixture"), false)

    if (full || mode === "server") {
      assert.ok(runtime.server?.port)
      const health = await fetch(`http://127.0.0.1:${runtime.server.port}/global/health`)
      assert.equal(health.status, 200)
      const { Server } = await import("@ericsanchezok/synergy-server/server/server")
      const spec = await Server.openapi()
      assert.ok(spec.components?.schemas?.Config)
      if (full) assert.ok(Object.keys(spec.paths ?? {}).length > 100)
      const capabilities = await (await fetch(`http://127.0.0.1:${runtime.server.port}/global/capabilities`)).json()
      assert.deepEqual(capabilities.components, runtime.components.toSorted((a, b) => a.id.localeCompare(b.id)))
    }
    for (const [domain, field] of [
      ["library", "library"],
      ["media", "voice"],
      ["connections", "channel"],
      ["plugin-host", "plugin"],
      ["mcp", "mcp"],
      ["lsp", "lsp"],
    ]) {
      assert.equal(
        field! in Config.Info.shape,
        domain === "plugin-host" || enabled(domain!),
        `unexpected config owner ${domain}`,
      )
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
        ["mcp", "mcp"],
        ["lsp", "lsp"],
        ["formatter", "formatter"],
        ["acp", "acp"],
        ["external-agents", "external-agents"],
        ["link-client", "link-client"],
        ["code-tools", "code-tools"],
        ["workflows", "workflows"],
        ["workbench", "workbench"],
        ["full", "presets"],
      ]) {
        const installed = await fs.access(path.join(process.cwd(), "node_modules", prefix + pkg)).then(
          () => true,
          () => false,
        )
        assert.equal(installed, domain === "plugin-host" || mode === domain, `unexpected installed domain ${pkg}`)
        assert.equal(
          lockfile.includes(JSON.stringify(prefix + pkg)),
          domain === "plugin-host" || mode === domain,
          `unexpected locked domain ${pkg}`,
        )
      }
    }
    const schema = await Bun.file(path.join(host.root, "schema/config.schema.json")).json()
    assert.equal("lsp" in schema.properties, enabled("lsp"))
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
        const { BashTool } = await import("@ericsanchezok/synergy-local-runtime/tools/bash")
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
        if (enabled("mcp")) {
          const { MCP } = await import("@ericsanchezok/synergy-mcp")
          await MCP.add("installed-fixture", {
            type: "local",
            command: [process.execPath, path.join(process.cwd(), "mcp-server.cjs")],
            startup: "manual",
          })
          await MCP.connect("installed-fixture")
          assert.equal((await MCP.status())["installed-fixture"].status, "connected")
          assert.deepEqual(
            (
              await (
                await MCP.clients()
              )["installed-fixture"].callTool({ name: "echo", arguments: { text: "installed tool execution" } })
            ).content,
            [{ type: "text", text: "installed tool execution" }],
          )
          assert.equal(
            (await MCP.readResource("installed-fixture", "fixture://evidence"))?.contents[0].text,
            "installed MCP evidence",
          )
          await MCP.disconnect("installed-fixture")
        }
        if (enabled("lsp")) {
          const { LSP } = await import("@ericsanchezok/synergy-lsp")
          const file = path.join(directory, "source.fixture")
          await Bun.write(file, "let ownerSymbol = 1")
          await LSP.touchFile(file, true)
          assert.equal((await LSP.diagnostics())[file]?.[0]?.message, "fixture warning")
          assert.deepEqual(await LSP.hover({ file, line: 0, character: 1 }), [{ contents: "fixture hover" }])
          await LSP.reload()
          assert.equal(await LSP.connectionCount(), 0)
        }
        if (enabled("browser")) {
          const { BrowserRuntime } = await import("@ericsanchezok/synergy-browser-runtime/runtime")
          const { browserOwnerKey } = await import("@ericsanchezok/synergy-browser-core")
          const { Storage } = await import("@ericsanchezok/synergy-harness/storage/storage")
          const owner = { mode: "session" as const, scopeID: scope.id, sessionID: session.id, directory }
          const stateKey = ["browser", "sessions-v4", createHash("sha256").update(browserOwnerKey(owner)).digest("hex")]
          await Storage.write(stateKey, {
            version: 4,
            status: "suspended",
            page: { id: "page-installed", url: "https://example.com/research", title: "Installed Browser" },
            timestamp: Date.now(),
          })
          const browser = await BrowserRuntime.getOrCreateSession(owner)
          assert.equal(browser.status, "suspended")
          assert.equal(browser.page, null)
          assert.equal(BrowserRuntime.resourceStats().ownerCount, 1)
          assert.equal(BrowserRuntime.resourceStats().processCount, 0)
          await browser.save()
          assert.equal((await Storage.read<{ page?: { title: string } }>(stateKey)).page?.title, "Installed Browser")
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
  })
} finally {
  await runtime.close()
  await runtime.close()
}
assert.throws(() => runtime.run(() => {}), /closed/)
if (database) assert.throws(() => database!.query("SELECT 1").get())
const { RuntimeContext } = await import("@ericsanchezok/synergy-harness/lifecycle/context")
const next = RuntimeContext.create(host)
try {
  await next.run(async () => {
    const ownership = await ServerProcessLock.acquire(undefined, "oneshot")
    await ownership.release()
  })
} finally {
  next.dispose()
}
console.log(JSON.stringify({ mode, executed: true, closed: true, optionalOwnersAbsent: !full }))
