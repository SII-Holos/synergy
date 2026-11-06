import { describe, expect, test } from "bun:test"
import { deserializePluginRuntimeError, serializePluginRuntimeError } from "../../src/plugin-runtime/protocol"

describe("plugin runtime error protocol", () => {
  test("preserves stable Host Service error codes across process IPC", () => {
    const original = Object.assign(new Error("Parent Session is unavailable"), {
      name: "PluginHostServiceError",
      code: "PLUGIN_TASK_PARENT_SCOPE_MISMATCH",
    })
    const restored = deserializePluginRuntimeError(serializePluginRuntimeError(original))
    expect(restored).toMatchObject({
      name: "PluginHostServiceError",
      message: "Parent Session is unavailable",
      code: "PLUGIN_TASK_PARENT_SCOPE_MISMATCH",
    })
  })
})
