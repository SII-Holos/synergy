import { describe, expect, test } from "bun:test"
import { resolvePluginProcessRunnerCommand } from "../../src/plugin-runtime/process-host"

describe("resolvePluginProcessRunnerCommand", () => {
  test("uses the source runner file when it exists", () => {
    const command = resolvePluginProcessRunnerCommand("runtime/index.js", true)

    expect(command[0]).toBe(process.execPath)
    expect(command[1]).toBe("run")
    expect(command.at(-1)).toBe("runtime/index.js")
  })

  test("uses the current Synergy executable hidden runner in packaged builds", () => {
    expect(resolvePluginProcessRunnerCommand("runtime/index.js", false)).toEqual([
      process.execPath,
      "__plugin-runtime-runner",
      "runtime/index.js",
    ])
  })
})
