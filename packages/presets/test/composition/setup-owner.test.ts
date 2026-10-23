import { composeWithExperiments } from "../support/selected-components"
import { expect, spyOn, test } from "bun:test"
import path from "node:path"
import yargs from "yargs"
import { coreCommands } from "@ericsanchezok/synergy-cli/cli/commands"
import { ConfigSetup } from "@ericsanchezok/synergy-cli/setup/config"
import { Config } from "@ericsanchezok/synergy-harness/config"
import { Global } from "@ericsanchezok/synergy-harness/global"
import { RuntimeComponents, type RuntimeComponent } from "@ericsanchezok/synergy-harness/lifecycle"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { testRuntime } from "@ericsanchezok/synergy-harness/test/support/runtime"
import { localRuntime } from "@ericsanchezok/synergy-local-runtime/component"
import { openLocalRuntime } from "@ericsanchezok/synergy-local-runtime"
import { library } from "@ericsanchezok/synergy-library/component"
import { plugins } from "@ericsanchezok/synergy-plugin-host/component"
import { fullComponents } from "../../src/components"

for (const scenario of [
  { name: "Core", components: [], library: false, anima: false, failed: false },
  {
    name: "Core with retained settings and a failed recommendation",
    components: [],
    library: false,
    anima: false,
    failed: true,
  },
  { name: "Library", components: [library()], library: true, anima: false, failed: false },
  { name: "Full", components: [plugins(), ...fullComponents()], library: true, anima: true, failed: false },
  {
    name: "Full with a failed recommendation",
    components: [plugins(), ...fullComponents()],
    library: true,
    anima: true,
    failed: true,
  },
] satisfies Array<{
  name: string
  components: RuntimeComponent[]
  library: boolean
  anima: boolean
  failed: boolean
}>) {
  test(`${scenario.name} setup only writes selected knowledge owners`, async () => {
    const composition = composeWithExperiments(
      RuntimeComponents.resolve([localRuntime({ workers: false, environment: false }), ...scenario.components]),
    )
    await using runtime = await testRuntime({
      composition: { register: () => composition.register() },
      env: scenario.anima
        ? {
            SYNERGY_CONFIG_CONTENT: JSON.stringify({ boss: { enabled: false }, pluginMarketplace: { enabled: false } }),
          }
        : {},
    })
    await runtime.run(() =>
      ScopeContext.provide({
        scope: Scope.home(),
        async fn() {
          const command = coreCommands(openLocalRuntime).find((entry) => entry.command === "config")!
          let help = ""
          await yargs([])
            .scriptName("synergy")
            .exitProcess(false)
            .command(await command.load())
            .help()
            .parseAsync(["config", "--help"], (error: Error | undefined, _argv: unknown, output: string) => {
              expect(error).toBeUndefined()
              help = output
            })
          expect(help.includes("config embedding")).toBe(scenario.library)
          expect(help.includes("config rerank")).toBe(scenario.library)
          for (const result of [
            await ConfigSetup.validateRequiredCore({}),
            await ConfigSetup.probeRequiredCore({}),
            await ConfigSetup.probeImportedCore({}),
            (await ConfigSetup.validateImport({})).coreValidation!,
          ]) {
            expect("embedding" in result.fields).toBe(scenario.library)
            expect("rerank" in result.fields).toBe(scenario.library)
          }
          const libraryFile = path.join(Global.Path.config, "synergy.d", "30-library.jsonc")
          const animaFile = path.join(Global.Path.config, "synergy.d", "35-anima.jsonc")
          const retained = !scenario.library && scenario.failed
          const storedLibrary = JSON.stringify({ library: { memory: { enabled: false }, future: { retained: true } } })
          const storedAnima = JSON.stringify({ anima: { enabled: false } })
          if (retained) {
            await Bun.write(libraryFile, storedLibrary)
            await Bun.write(animaFile, storedAnima)
          }
          const accepted = { valid: true, message: "Fixture accepted" }
          const validation: ConfigSetup.RequiredCoreValidationResult = {
            valid: true,
            fields: {
              model: accepted,
              embedding: { ...accepted, failedRecommended: scenario.failed },
              rerank: accepted,
            },
          }
          await ConfigSetup.finalizeConfig({ model: "fixture/model" }, validation)
          const current = await Config.globalRaw()
          expect(current.model).toBe("fixture/model")
          if (scenario.library) {
            expect(current.library).toMatchObject({
              memory: { enabled: !scenario.failed },
              experience: { encode: !scenario.failed, retrieve: !scenario.failed },
            })
            expect(current.library).not.toHaveProperty("autonomy")
            expect((await Bun.file(libraryFile).json()).library).not.toHaveProperty("autonomy")
          } else {
            expect(current).not.toHaveProperty("library")
            if (retained) expect(await Bun.file(libraryFile).text()).toBe(storedLibrary)
            else expect(await Bun.file(libraryFile).exists()).toBe(false)
          }
          if (scenario.anima) {
            expect(current.anima).toEqual({ enabled: true })
            expect((await Bun.file(animaFile).json()).anima).toEqual({ enabled: true })
          } else {
            expect(current).not.toHaveProperty("anima")
            if (retained) expect(await Bun.file(animaFile).text()).toBe(storedAnima)
            else expect(await Bun.file(animaFile).exists()).toBe(false)
          }
        },
      }),
    )
  }, 30_000)
}

test("registered Library accepts explicit vector discovery, validation and live probes", async () => {
  const composition = composeWithExperiments([localRuntime({ workers: false, environment: false }), library()])
  await using runtime = await testRuntime({ composition: { register: () => composition.register() } })
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      async fn() {
        const embedding = { baseURL: "https://setup.invalid/v1", apiKey: "fixture", model: "fixture-embedding" }
        const rerank = { ...embedding, model: "fixture-rerank" }
        const originalFetch = globalThis.fetch
        const network = spyOn(globalThis, "fetch").mockImplementation(
          Object.assign(
            async (input: Parameters<typeof fetch>[0]) => {
              const url = input instanceof Request ? input.url : String(input)
              if (url.endsWith("/models"))
                return Response.json({ data: [{ id: embedding.model }, { id: rerank.model }] })
              if (url.endsWith("/embeddings"))
                return Response.json({ data: [{ embedding: [1, 2] }], usage: { prompt_tokens: 1, total_tokens: 1 } })
              if (url.endsWith("/rerank")) return Response.json({ results: [{ index: 0, relevance_score: 1 }] })
              throw new Error(`Unexpected setup request: ${url}`)
            },
            { preconnect: originalFetch.preconnect },
          ),
        )
        try {
          expect(await ConfigSetup.discoverModels(embedding)).toEqual([
            { id: embedding.model, name: embedding.model, type: "embedding" },
            { id: rerank.model, name: rerank.model, type: "rerank" },
          ])
          for (const result of [
            await ConfigSetup.validateRequiredCore({ embedding, rerank }),
            await ConfigSetup.probeRequiredCore({ embedding, rerank }),
            await ConfigSetup.probeImportedCore({ embedding, rerank }),
            (await ConfigSetup.validateImport({ embedding, rerank })).coreValidation!,
          ]) {
            expect(result.fields.embedding).toMatchObject({ valid: true })
            expect(result.fields.rerank).toMatchObject({ valid: true })
            expect(result.fields.embedding.failedRecommended).toBeUndefined()
            expect(result.fields.rerank.failedRecommended).toBeUndefined()
          }
          expect(network).toHaveBeenCalledTimes(9)
        } finally {
          network.mockRestore()
        }
      },
    }),
  )
}, 30_000)
