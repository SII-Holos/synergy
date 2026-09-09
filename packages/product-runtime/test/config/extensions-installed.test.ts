import { expect, test } from "bun:test"
import { createIsolatedTestEnv } from "@ericsanchezok/synergy-testing/env"

test("installed owner configuration validates an early schema reference and preserves secret and reference contracts", async () => {
  const isolated = await createIsolatedTestEnv()
  const config = new URL("../../../harness/src/config/config.ts", import.meta.url).pathname
  const extensions = new URL("../../../harness/src/config/extensions.ts", import.meta.url).pathname
  const library = new URL("../../../library/src/config-schema.ts", import.meta.url).pathname
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
      const { Experiment } = await import(${JSON.stringify(new URL("../../../harness/src/config/experiment.ts", import.meta.url).pathname)})
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
        const { ConfigDomain } = await import(${JSON.stringify(new URL("../../../harness/src/config/domain.ts", import.meta.url).pathname)})
        const file = ConfigDomain.filepath("general", root)
        await fs.mkdir(path.dirname(file), { recursive: true })
        await Bun.write(file, JSON.stringify({ username: "before", embedding: { apiKey: "preserved" } }))
        assert.equal((await Config.domainGet("general", root)).embedding.apiKey, "preserved")
        await Config.domainUpdate("general", { username: "after" }, { root, mode: "replace-domain" })
        assert.deepEqual(JSON.parse(await Bun.file(file).text()), { username: "after", embedding: { apiKey: "preserved" } })
      } finally {
        await fs.rm(root, { recursive: true, force: true })
      }
      const { Global } = await import(${JSON.stringify(new URL("../../../harness/src/global/index.ts", import.meta.url).pathname)})
      const legacy = path.join(Global.Path.config, "synergy.jsonc")
      const legacyData = { model: "legacy/core", library: { memory: { enabled: false } } }
      await fs.mkdir(Global.Path.config, { recursive: true })
      await Bun.write(legacy, JSON.stringify(legacyData))
      Config.global.reset()
      assert.equal((await Config.globalRaw()).model, "legacy/core")
      assert.deepEqual(JSON.parse(await Bun.file(legacy).text()), legacyData)
      await import(${JSON.stringify(library)})
      assert.equal("library" in early.shape, true)
      assert.equal("library" in z.toJSONSchema(early, { unrepresentable: "any" }).properties, true)
      assert.equal("library" in z.toJSONSchema(Config.schema(), { unrepresentable: "any" }).properties, true)
      assert.equal(early.safeParse(raw).success, false)
      const valid = early.parse({ library: {} })
      ConfigExtensions.normalize(valid)
      assert.equal(valid.library.memory.enabled, true)
      assert.equal(valid.library.experience.encode, true)
      const credentials = { embedding: { apiKey: "secret-value" } }
      const redacted = Config.redactForClient(credentials)
      assert.notEqual(redacted.embedding.apiKey, credentials.embedding.apiKey)
      assert.deepEqual(Config.mergeRedactedSecrets(redacted, credentials), credentials)
      await import(${JSON.stringify(new URL("../../../product-runtime/src/configuration.ts", import.meta.url).pathname)})
      assert.equal(early.safeParse({ unknownDomain: {} }).success, false)
      assert.equal(Experiment.Runtime.safeParse({ lsp: false }).success, true)
      const { ConfigDomain } = await import("@ericsanchezok/synergy-harness/config/domain")
      assert.equal(z.toJSONSchema(ConfigDomain.Id).enum.includes("library"), true)
      assert.equal(ConfigDomain.Id.safeParse("bogus").success, false)
      assert.equal(ConfigExtensions.readField({ activityDisplay: "full" }, "activityDisplay"), "full")
      assert.deepEqual(ConfigExtensions.references({
        external_agent: { researcher: { model: "target/model" } },
        quick_switcher: { models: [{ providerID: "target", modelID: "model" }] },
        channel: { chat: { type: "feishu", accounts: { bot: { model: "target/model" } } } },
      }, "target").sort(), ["channel.chat.accounts.bot.model", "external_agent.researcher.model", "quick_switcher.models[0]"].sort())
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
