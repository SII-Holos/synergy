import { afterAll, expect, spyOn, test } from "bun:test"
import fs from "node:fs/promises"
import { Global } from "@ericsanchezok/synergy-harness/global"
import { McpAuth } from "../../src/auth"
import { testRuntime } from "../support/runtime"

const runtime = await testRuntime()
afterAll(() => runtime.close())

test("credential readers retain the committed login while cleanup publishes", () =>
  runtime.run(async () => {
    const name = "publication-fixture"
    const previous = { tokens: { accessToken: "fixture-access" }, codeVerifier: "fixture-verifier" }
    await McpAuth.set(name, previous)
    const target = Global.Path.authMcp
    const observations: Array<McpAuth.Entry | undefined> = []
    const write = Bun.write.bind(Bun)
    const rename = fs.rename.bind(fs)
    using writing = spyOn(Bun, "write").mockImplementation(async (destination, data, options) => {
      if (destination === target) {
        await write(destination, "")
        observations.push(await McpAuth.get(name))
      }
      return Reflect.apply(write, Bun, [destination, data, options]) as Promise<number>
    })
    using publishing = spyOn(fs, "rename").mockImplementation(async (source, destination) => {
      if (destination === target) observations.push(await McpAuth.get(name))
      return rename(source, destination)
    })
    await McpAuth.clearCodeVerifier(name)
    expect(observations).toEqual([previous])
    expect(await McpAuth.get(name)).toEqual({ tokens: previous.tokens })
    if (process.platform !== "win32") expect((await fs.stat(target)).mode & 0o777).toBe(0o600)
  }))
