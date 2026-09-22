import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { pathToFileURL } from "url"
import { afterAll as afterRuntimeTests } from "bun:test"
import { testRuntime } from "../support/runtime"
const runtime = await testRuntime()

const globalModulePath = path.resolve(import.meta.dirname, "../../src/global/index.ts")

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
            `await Global.initialize({ cache: false, configSchemaPath: ${JSON.stringify(bundledPath)} })\nif (!Global.Path.configSchema) process.exit(1)\n})\n`,
        )

        try {
          const children = await Promise.all(
            [0, 1, 2, 3].map(() =>
              Bun.spawn([process.execPath, "run", scriptPath], {
                env: { ...process.env, SYNERGY_HOME: home },
                stdout: "ignore",
                stderr: "inherit",
              }),
            ),
          )
          expect(await Promise.all(children.map((child) => child.exited))).toEqual([0, 0, 0, 0])
          expect(await fs.readFile(path.join(home, ".synergy", "schema", "config.schema.json"), "utf8")).toBe(
            await fs.readFile(bundledPath, "utf8"),
          )
        } finally {
          await fs.rm(home, { recursive: true, force: true })
        }
      }),
    30_000,
  )
})

afterRuntimeTests(() => runtime.close())
