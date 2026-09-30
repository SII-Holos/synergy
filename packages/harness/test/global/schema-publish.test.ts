import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { pathToFileURL } from "url"
import { afterAll as afterRuntimeTests } from "bun:test"
import { testRuntime } from "../support/runtime"
import { ConfigExtensions } from "../../src/config/extensions"
import { z } from "zod"
const runtime = await testRuntime()

const globalModulePath = path.resolve(import.meta.dirname, "../../src/global/index.ts")

test("runtime startup publishes configuration from its selected components without a bundled schema", async () => {
  await using selected = await testRuntime({
    register() {
      ConfigExtensions.register("schema-fixture", { shape: { fixtureFeature: z.boolean().optional() } })
      ConfigExtensions.completeRegistration()
    },
  })
  const schema = await Bun.file(path.join(selected.host.root, "schema/config.schema.json")).json()
  expect(schema.properties.fixtureFeature.type).toBe("boolean")
  expect(schema.properties).not.toHaveProperty("lsp")
})

describe("startup schema publish", () => {
  test(
    "concurrent startups into one home all succeed and publish the bundled schema",
    () =>
      runtime.run(async () => {
        const home = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-schema-publish-"))
        const scriptPath = path.join(home, "import-global.ts")
        const bundledPath = path.join(home, "bundle-schema.json")
        await Bun.write(bundledPath, JSON.stringify({ type: "object", title: "Fixture schema" }))
        await fs.writeFile(
          scriptPath,
          `const { RuntimeContext } = await import(${JSON.stringify(new URL("../../src/lifecycle/context.ts", import.meta.url).href)})\n` +
            `await RuntimeContext.create({ home: process.env.SYNERGY_HOME, root: process.env.SYNERGY_HOME + "/.synergy", env: process.env }).run(async () => {\n` +
            `const { Global } = await import(${JSON.stringify(pathToFileURL(globalModulePath).href)})\n` +
            `console.log("ready")\nawait Bun.stdin.text()\nconsole.log("initializing")\n` +
            `await Global.initialize({ cache: false, configSchemaPath: ${JSON.stringify(bundledPath)} })\nif (!Global.Path.configSchema) process.exit(1)\nconsole.log("published")\n})\n`,
        )

        const children = [0, 1].map(() => {
          const child = Bun.spawn([process.execPath, "run", scriptPath], {
            env: { ...process.env, SYNERGY_HOME: home },
            stdin: "pipe",
            stdout: "pipe",
            stderr: "pipe",
          })
          const ready = Promise.withResolvers<void>()
          const state = { child, ready, stdout: "", stderr: "" }
          const output = (async () => {
            const decoder = new TextDecoder()
            const reader = child.stdout.getReader()
            try {
              while (true) {
                const { value, done } = await reader.read()
                if (done) break
                state.stdout += decoder.decode(value, { stream: true })
                if (state.stdout.split(/\r?\n/).includes("ready")) ready.resolve()
              }
            } finally {
              reader.releaseLock()
            }
            ready.reject(new Error("startup exited before the initialization barrier"))
          })()
          const errors = new Response(child.stderr).text().then((value) => (state.stderr = value))
          return { ...state, output, errors, state }
        })
        let deadline: ReturnType<typeof setTimeout> | undefined
        try {
          await Promise.race([
            (async () => {
              await Promise.all(children.map(({ ready }) => ready.promise))
              await Promise.all(
                children.map(async ({ child }) => {
                  child.stdin.write("initialize\n")
                  await child.stdin.end()
                }),
              )
              expect(await Promise.all(children.map(({ child }) => child.exited))).toEqual([0, 0])
            })(),
            new Promise<never>((_, reject) => {
              deadline = setTimeout(() => reject(new Error("concurrent schema initialization timed out")), 25_000)
            }),
          ])
          expect(await fs.readFile(path.join(home, ".synergy", "schema", "config.schema.json"), "utf8")).toBe(
            await fs.readFile(bundledPath, "utf8"),
          )
        } catch (error) {
          for (const { child } of children) if (child.exitCode === null) child.kill()
          await Promise.allSettled(children.flatMap(({ child, output, errors }) => [child.exited, output, errors]))
          throw new Error(
            children.map(({ state }, index) => `startup ${index}: ${state.stdout}\n${state.stderr}`).join("\n"),
            { cause: error },
          )
        } finally {
          clearTimeout(deadline)
          for (const { child } of children) if (child.exitCode === null) child.kill()
          await Promise.allSettled(children.flatMap(({ child, output, errors }) => [child.exited, output, errors]))
          await fs.rm(home, { recursive: true, force: true })
        }
      }),
    30_000,
  )
})

afterRuntimeTests(() => runtime.close())
