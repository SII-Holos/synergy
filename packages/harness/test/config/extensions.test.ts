import { expect, test } from "bun:test"
import { createIsolatedTestEnv } from "@ericsanchezok/synergy-testing/env"

test("core config preserves absent domains and an early schema reference validates later registration", async () => {
  const isolated = await createIsolatedTestEnv()
  const config = new URL("../../src/config/config.ts", import.meta.url).pathname
  const extensions = new URL("../../src/config/extensions.ts", import.meta.url).pathname
  const child = Bun.spawn({
    cmd: [
      process.execPath,
      "--eval",
      `
      import assert from "node:assert/strict"
      import z from "zod"
      const { Config } = await import(${JSON.stringify(config)})
      const { ConfigExtensions } = await import(${JSON.stringify(extensions)})
      const defaults = {}
      ConfigExtensions.normalize(defaults)
      assert.equal("lspWriteDiagnostics" in defaults, false)
      assert.equal(ConfigExtensions.readField({ activityDisplay: "full" }, "activityDisplay"), undefined)
      const early = Config.Info
      assert.equal(z.globalRegistry.get(early).ref, "Config")
      assert.equal("_zod" in early, true)
      assert.equal(Reflect.ownKeys(early).includes("_zod"), true)
      assert.equal("library" in early.shape, false)
      assert.equal("mcp" in early.shape, false)
      const { Experiment } = await import(${JSON.stringify(new URL("../../src/config/experiment.ts", import.meta.url).pathname)})
      const dormant = { lsp: { custom: { command: ["server"] } }, lspWriteDiagnostics: true }
      assert.doesNotThrow(() => Experiment.configureRuntime(dormant))
      assert.doesNotThrow(() => Experiment.capture(dormant))
      assert.equal(Experiment.Runtime.safeParse({ lsp: false }).success, false)
      const raw = { library: { memory: { enabled: "not-a-boolean" } }, model: "test/model" }
      assert.deepEqual(early.parse(raw), raw)
      assert.equal(Config.serializeConfig(raw).includes("not-a-boolean"), true)
      assert.deepEqual(Config.redactForClient({ embedding: { apiKey: "unregistered-secret" }, model: "test/model" }), { model: "test/model" })
      const fs = await import("node:fs/promises")
      const os = await import("node:os")
      const path = await import("node:path")
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-absent-config-"))
      try {
        const { ConfigDomain } = await import(${JSON.stringify(new URL("../../src/config/domain.ts", import.meta.url).pathname)})
        assert.equal(ConfigDomain.Id.safeParse("bogus").success, false)
        assert.equal(ConfigDomain.Id.safeParse("general").success, true)
        assert.equal(z.toJSONSchema(ConfigDomain.Id).enum.includes("general"), true)
        assert.equal(z.toJSONSchema(ConfigDomain.Id).enum.includes("library"), false)
        const file = ConfigDomain.filepath("general", root)
        await fs.mkdir(path.dirname(file), { recursive: true })
        await Bun.write(file, JSON.stringify({ username: "before", embedding: { apiKey: "preserved" } }))
        assert.equal((await Config.domainGet("general", root)).embedding.apiKey, "preserved")
        await Config.domainUpdate("general", { username: "after" }, { root, mode: "replace-domain" })
        assert.deepEqual(JSON.parse(await Bun.file(file).text()), { username: "after", embedding: { apiKey: "preserved" } })
      } finally {
        await fs.rm(root, { recursive: true, force: true })
      }
      const { Global } = await import(${JSON.stringify(new URL("../../src/global/index.ts", import.meta.url).pathname)})
      const legacy = path.join(Global.Path.config, "synergy.jsonc")
      const legacyData = { model: "legacy/core", library: { memory: { enabled: false } } }
      await fs.mkdir(Global.Path.config, { recursive: true })
      await Bun.write(legacy, JSON.stringify(legacyData))
      Config.global.reset()
      assert.equal((await Config.globalRaw()).model, "legacy/core")
      assert.deepEqual(JSON.parse(await Bun.file(legacy).text()), legacyData)
      ConfigExtensions.register("research", { shape: { research: z.object({ repetitions: z.number().int().positive() }).optional() } })
      assert.equal("research" in early.shape, true)
      assert.equal("research" in z.toJSONSchema(early, { unrepresentable: "any" }).properties, true)
      assert.equal("research" in z.toJSONSchema(Config.schema(), { unrepresentable: "any" }).properties, true)
      assert.equal(early.safeParse({ research: { repetitions: "invalid" } }).success, false)
      ConfigExtensions.register("invalid-core-owner", { shape: { model: z.boolean() } })
      assert.throws(() => early.shape, /already owned by the harness/)
    `,
    ],
    stdout: "pipe",
    stderr: "pipe",
    env: isolated.env,
  })
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
  await isolated.dispose()
  expect(code, stderr).toBe(0)
})

test("config composition locks before mutation and permits the same contribution again", async () => {
  const isolated = await createIsolatedTestEnv()
  const child = Bun.spawn({
    cmd: [
      process.execPath,
      "--eval",
      `
      import assert from "node:assert/strict"
      import z from "zod"
      const { Config } = await import("@ericsanchezok/synergy-harness/config/config")
      const { ConfigExtensions } = await import("@ericsanchezok/synergy-harness/config/extensions")
      const { ConfigDomain } = await import("@ericsanchezok/synergy-harness/config/domain")
      const contribution = { shape: { research: z.string().optional() } }
      ConfigExtensions.register("research", contribution)
      ConfigExtensions.lock()
      assert.doesNotThrow(() => ConfigExtensions.register("research", contribution))
      assert.throws(() => ConfigExtensions.register("late", { shape: { late: z.string() } }), /before opening the runtime/)
      assert.throws(() => ConfigExtensions.register("research", { shape: {} }), /before opening the runtime/)
      assert.throws(() => ConfigExtensions.completeRegistration(), /before opening the runtime/)
      assert.throws(() => ConfigDomain.register({ id: "late", filename: "200-late.jsonc", ownedKeys: ["late"] }), /before opening the runtime/)
      assert.equal(ConfigDomain.byId.has("late"), false)
      assert.equal("late" in Config.Info.shape, false)
      assert.equal("research" in Config.Info.shape, true)
    `,
    ],
    env: isolated.env,
    stdout: "pipe",
    stderr: "pipe",
  })
  try {
    const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
    expect(code, stderr).toBe(0)
  } finally {
    await isolated.dispose()
  }
})
