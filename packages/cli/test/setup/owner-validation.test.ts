import { expect, spyOn, test } from "bun:test"
import { ConfigExtensions } from "@ericsanchezok/synergy-harness/config/extensions"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { testRuntime } from "@ericsanchezok/synergy-harness/test/support/runtime"
import { registerLocalRuntime } from "@ericsanchezok/synergy-local-runtime/register"
import { ConfigSetup } from "../../src/setup/config"

function coreRuntime() {
  return testRuntime({
    composition: {
      register() {
        registerLocalRuntime({ workers: false, environment: false })
        ConfigExtensions.completeRegistration()
      },
    },
  })
}

test("Core setup and import validations expose no Library recommendations", async () => {
  await using runtime = await coreRuntime()
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      async fn() {
        const results = [
          await ConfigSetup.validateRequiredCore({}),
          await ConfigSetup.probeRequiredCore({}),
          await ConfigSetup.probeImportedCore({}),
          (await ConfigSetup.validateImport({})).coreValidation,
        ]
        for (const result of results) {
          expect(result).toBeDefined()
          expect(Object.keys(result!.fields).sort()).toEqual(["model", "vision_model"])
          expect(JSON.stringify(result)).not.toMatch(/embedding|rerank|memory evolution|look_at/i)
        }
      },
    }),
  )
})

for (const field of ["embedding", "rerank"] as const) {
  test(`Core rejects explicit ${field} setup before validation, probing or writes`, async () => {
    await using runtime = await coreRuntime()
    await runtime.run(() =>
      ScopeContext.provide({
        scope: Scope.home(),
        async fn() {
          const input = {
            [field]: { baseURL: "https://setup.invalid/v1", apiKey: "fixture", model: `fixture-${field}` },
          }
          const network = spyOn(globalThis, "fetch").mockResolvedValue(
            Response.json({ data: [{ id: `fixture-${field}`, embedding: [1, 2] }] }),
          )
          try {
            for (const validate of [
              ConfigSetup.validateRequiredCore,
              ConfigSetup.probeRequiredCore,
              ConfigSetup.probeImportedCore,
            ]) {
              await expect(validate(input)).rejects.toThrow(/Library.*not registered/)
            }
            await expect(ConfigSetup.finalizeConfig(input, { valid: true, fields: {} })).rejects.toThrow(
              /Library.*not registered/,
            )
            const imported = await ConfigSetup.validateImport(input)
            expect(imported.valid).toBe(false)
            expect(imported.warnings.join(" ")).toContain(field)
            expect(network).not.toHaveBeenCalled()
          } finally {
            network.mockRestore()
          }
        },
      }),
    )
  })
}

test("Core rejects Library model discovery without requesting its endpoint", async () => {
  await using runtime = await coreRuntime()
  await runtime.run(async () => {
    const network = spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ data: [] }))
    try {
      await expect(
        ConfigSetup.discoverModels({ baseURL: "https://setup.invalid/v1", apiKey: "fixture" }),
      ).rejects.toThrow(/Library.*not registered/)
      expect(network).not.toHaveBeenCalled()
    } finally {
      network.mockRestore()
    }
  })
})
