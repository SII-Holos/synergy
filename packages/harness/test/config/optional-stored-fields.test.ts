import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { z } from "zod"
import { Config } from "../../src/config/config"
import { ConfigDomain } from "../../src/config/domain"
import { ConfigExtensions } from "../../src/config/extensions"
import { Global } from "../../src/global"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { runtimeHome } from "../support/runtime-home"
import { testRuntime } from "../support/runtime"

const Owner = z.object({ type: z.literal("available"), value: z.string() })
const Other = z.object({ type: z.literal("optional"), value: z.string() })
const Settings = z.object({ enabled: z.boolean().optional(), schedule: z.object({ hour: z.number() }).optional() })
const Archived = z.object({ nested: z.object({ values: z.array(z.union([z.string(), z.number()])) }) })

function register(selected: boolean) {
  const entry = selected ? z.union([Owner, Other]) : Owner
  const settings = selected ? Settings : Settings.omit({ schedule: true })
  const contribution = {
    shape: { fixtureProviders: z.record(z.string(), entry).optional(), fixtureSettings: settings.optional() },
    storedShape: {
      fixtureProviders: z.record(z.string(), z.unknown()).optional(),
      fixtureSettings: settings.passthrough().optional(),
    },
    project(raw: Record<string, unknown>) {
      const providers = raw.fixtureProviders
      if (selected || !providers || typeof providers !== "object") return
      for (const [key, value] of Object.entries(providers)) {
        if (!value || typeof value !== "object" || !("type" in value) || value.type !== "available") {
          delete (providers as Record<string, unknown>)[key]
        }
      }
    },
  }
  ConfigExtensions.register("fixture-providers", contribution)
  ConfigDomain.register({
    id: "fixture-providers",
    filename: "200-fixture-providers.jsonc",
    label: "Fixture providers",
    ownedKeys: ["fixtureProviders", "fixtureSettings"],
    mergePolicy: "merge",
    reloadTargets: ["config"],
    uiSection: "fixture-providers",
    importable: true,
  })
  ConfigExtensions.completeRegistration()
}

test("project config replacement retains unloaded nested owners", async () => {
  await using home = await runtimeHome()
  const directory = path.join(home.host.home, "project")
  const root = path.join(directory, ".synergy")
  {
    await using absent = await testRuntime({ home: home.host.home, register: () => register(false) })
    await absent.run(async () => {
      const file = ConfigDomain.filepath("fixture-providers", root)
      await fs.mkdir(path.dirname(file), { recursive: true })
      await Bun.write(file, JSON.stringify(original))
      const { scope } = await Scope.fromDirectory(directory)
      await ScopeContext.provide({
        scope,
        fn: async () => {
          expect((await Config.current()).fixtureProviders).toEqual({ kept: original.fixtureProviders.kept })
          await Config.update({
            fixtureProviders: { kept: { type: "available", value: "project change" } },
            fixtureSettings: { enabled: false },
          })
          const stored = await Bun.file(file).json()
          expect(stored.fixtureProviders.dormant).toEqual(original.fixtureProviders.dormant)
          expect(stored.fixtureSettings).toEqual({ enabled: false, schedule: { hour: 3 } })
          expect((await Config.current()).fixtureSettings).toEqual({ enabled: false })
        },
      })
    })
  }
  {
    await using installed = await testRuntime({ home: home.host.home, register: () => register(true) })
    await installed.run(async () => {
      const value = await Config.domainGet("fixture-providers", root)
      expect(value.fixtureProviders?.dormant).toEqual({ type: "optional", value: "retained" })
      expect(value.fixtureSettings).toEqual({ enabled: false, schedule: { hour: 3 } })
    })
  }
})

const original = {
  fixtureProviders: {
    kept: { type: "available", value: "old" },
    dormant: { type: "optional", value: "retained", future: { nested: [1, "untouched"] } },
  },
  fixtureSettings: { enabled: true, schedule: { hour: 3 } },
} as const

declare module "../../src/config/schema" {
  interface ConfigExtensionShape {
    fixtureProviders: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnion<[typeof Owner, typeof Other]>>>
    fixtureSettings: z.ZodOptional<typeof Settings>
    archivedFixture: z.ZodOptional<typeof Archived>
  }
}

for (const source of ["domain", "legacy"] as const) {
  test(`${source} config hides unloaded nested owners across writes and restores them after reinstall`, async () => {
    await using home = await runtimeHome()
    {
      await using installed = await testRuntime({ home: home.host.home, register: () => register(true) })
      await installed.run(async () => {
        await fs.mkdir(Global.Path.config, { recursive: true })
        if (source === "legacy") {
          await Bun.write(path.join(Global.Path.config, "synergy.jsonc"), JSON.stringify(original))
        } else {
          await Config.domainUpdate("fixture-providers", original)
          await Bun.write(ConfigDomain.filepath("fixture-providers"), JSON.stringify(original))
        }
      })
    }
    {
      await using absent = await testRuntime({ home: home.host.home, register: () => register(false) })
      await absent.run(async () => {
        const visible = {
          fixtureProviders: { kept: original.fixtureProviders.kept },
          fixtureSettings: { enabled: true },
        }
        expect(await Config.domainGet("fixture-providers")).toEqual(visible)
        expect((await Config.global()).fixtureProviders).toEqual(visible.fixtureProviders)
        expect((await Config.globalRaw()).fixtureProviders).toEqual(visible.fixtureProviders)
        expect(Config.redactForClient(await Config.globalRaw()).fixtureProviders).toEqual(visible.fixtureProviders)
        expect((await Config.globalResolved()).fixtureProviders).toEqual(visible.fixtureProviders)
        expect((await Config.globalResolved()).fixtureSettings).toEqual(visible.fixtureSettings)
        expect((await Config.domainReadForExport("fixture-providers")).config).toEqual(visible)
        expect((await Config.domainList()).find((item) => item.id === "fixture-providers")?.config).toEqual(visible)
        expect(JSON.stringify(Config.jsonSchema())).not.toContain('"optional"')

        await Config.domainUpdate("general", { username: "unrelated" })
        for (const mode of ["merge", "replace-domain"] as const) {
          const result = await Config.domainUpdate(
            "fixture-providers",
            { fixtureProviders: { kept: { type: "available", value: mode } } },
            { mode },
          )
          expect(result.fixtureProviders).toEqual({ kept: { type: "available", value: mode } })
          const stored = await Bun.file(ConfigDomain.filepath("fixture-providers")).json()
          expect(stored.fixtureProviders.dormant).toEqual(original.fixtureProviders.dormant)
          expect(stored.fixtureSettings.schedule).toEqual(original.fixtureSettings.schedule)
        }
        const file = ConfigDomain.filepath("fixture-providers")
        const before = await Bun.file(file).text()
        await expect(
          Config.domainUpdate("fixture-providers", {
            fixtureProviders: { dormant: { type: "optional", value: "cannot modify unloaded owner" } },
          }),
        ).rejects.toThrow()
        expect(await Bun.file(file).text()).toBe(before)
        expect(Config.diagnostics()).toEqual([])
      })
    }
    {
      await using reinstalled = await testRuntime({ home: home.host.home, register: () => register(true) })
      await reinstalled.run(async () => {
        expect((await Config.domainGet("fixture-providers")).fixtureProviders).toEqual({
          kept: { type: "available", value: "replace-domain" },
          dormant: { type: "optional", value: "retained" },
        })
        const stored = await Bun.file(ConfigDomain.filepath("fixture-providers")).json()
        expect(stored.fixtureProviders.dormant).toEqual(original.fixtureProviders.dormant)
        expect((await Config.domainGet("fixture-providers")).fixtureSettings).toEqual({ schedule: { hour: 3 } })
        expect((await Config.globalResolved()).username).toBe("unrelated")
      })
    }
  })
}

for (const source of ["domain", "legacy"] as const) {
  test(`complete composition preserves unregistered root fields from ${source} config`, async () => {
    await using home = await runtimeHome()
    const retained = { nested: { values: ["future", 7] } }
    const registerArchived = (selected: boolean) => {
      if (selected) {
        ConfigExtensions.register("archived-fixture", {
          shape: { archivedFixture: Archived.optional() },
        })
        ConfigDomain.register({
          id: "general",
          filename: "00-general.jsonc",
          label: "General",
          ownedKeys: ["archivedFixture"],
          mergePolicy: "merge",
          reloadTargets: ["config"],
          uiSection: "general",
          importable: true,
        })
      }
      ConfigExtensions.completeRegistration()
    }
    const file = path.join(
      home.host.root,
      "config",
      source === "domain" ? "synergy.d/00-general.jsonc" : "synergy.jsonc",
    )
    await fs.mkdir(path.dirname(file), { recursive: true })
    await Bun.write(file, JSON.stringify({ username: "old", archivedFixture: retained }))
    {
      await using absent = await testRuntime({
        home: home.host.home,
        register: () => registerArchived(false),
        env: { SYNERGY_CWD: home.host.home },
      })
      await absent.run(async () => {
        expect((await Config.globalRaw()).archivedFixture).toBeUndefined()
        expect(await Config.domainGet("general")).not.toHaveProperty("archivedFixture")
        expect((await Config.domainReadForExport("general")).config).not.toHaveProperty("archivedFixture")
        expect(Config.Info.safeParse({ archivedFixture: retained }).success).toBe(false)
        for (const mode of ["merge", "replace-domain"] as const) {
          await Config.domainUpdate("general", { username: mode }, { mode })
          const stored = await Bun.file(file).json()
          expect(stored.archivedFixture).toEqual(retained)
          expect(await Config.globalRaw()).not.toHaveProperty("archivedFixture")
        }
        await expect(Config.domainUpdate("general", { archivedFixture: { nested: { values: [] } } })).rejects.toThrow()
        expect(Config.diagnostics()).toEqual([])
      })
    }
    {
      await using installed = await testRuntime({ home: home.host.home, register: () => registerArchived(true) })
      await installed.run(async () => {
        expect((await Config.domainGet("general")).archivedFixture).toEqual(retained)
        expect((await Config.globalRaw()).username).toBe("replace-domain")
      })
    }
  })
}
