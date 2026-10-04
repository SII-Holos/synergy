import { afterAll, expect, test } from "bun:test"
import { Server } from "../../src/server/server"
import { testRuntime } from "../support/runtime"

const runtime = await testRuntime()
afterAll(() => runtime.close())

test("Home command discovery does not evaluate directory-dependent execution templates", () =>
  runtime.run(async () => {
    const response = await Server.App().request("/command?scopeID=home")
    expect(response.status).toBe(200)
    const commands = await response.json()
    expect(commands.some((command: { name: string }) => command.name === "init")).toBe(true)
    expect(commands.every((command: Record<string, unknown>) => !("template" in command))).toBe(true)
  }))
