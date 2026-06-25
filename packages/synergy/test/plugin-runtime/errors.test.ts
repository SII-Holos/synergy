import { describe, expect, test } from "bun:test"

// These imports will fail RED — the module doesn't exist yet.
// The implementation agent will create packages/synergy/src/plugin-runtime/errors.ts
// with: PluginRuntimeError, serializeError, deserializeError, classifyRuntimeExit.
import {
  PluginRuntimeError,
  serializeError,
  deserializeError,
  classifyRuntimeExit,
} from "../../src/plugin-runtime/errors"

// =============================================================================
// PluginRuntimeError
// =============================================================================
describe("PluginRuntimeError", () => {
  test("is an instance of Error", () => {
    const err = new PluginRuntimeError("plugin-1", "START_FAILED", "plugin failed to start")
    expect(err).toBeInstanceOf(Error)
  })

  test("has name set to PluginRuntimeError", () => {
    const err = new PluginRuntimeError("plugin-1", "START_FAILED", "plugin failed to start")
    expect(err.name).toBe("PluginRuntimeError")
  })

  test("stores pluginId, code, and message", () => {
    const err = new PluginRuntimeError("plugin-abc", "TIMEOUT", "startup timed out")
    expect(err.pluginId).toBe("plugin-abc")
    expect(err.code).toBe("TIMEOUT")
    expect(err.message).toBe("startup timed out")
  })

  test("stores an optional cause Error", () => {
    const cause = new Error("underlying failure")
    const err = new PluginRuntimeError("p1", "SPAWN_FAILED", "spawn failed", { cause })
    expect(err.cause).toBe(cause)
    expect(err.message).toBe("spawn failed")
  })

  test("constructor with cause stores the cause", () => {
    const cause = new Error("low-level error")
    const err = new PluginRuntimeError("p2", "CRASH", "runtime crashed", { cause })
    expect(err.cause).toBe(cause)
  })

  test("toString includes pluginId, code, and message", () => {
    const err = new PluginRuntimeError("p3", "OOM", "out of memory")
    const str = err.toString()
    expect(str).toContain("p3")
    expect(str).toContain("OOM")
    expect(str).toContain("out of memory")
  })
})

// =============================================================================
// serializeError
// =============================================================================
describe("serializeError", () => {
  test("serializes a plain Error", () => {
    const err = new Error("something broke")
    const result = serializeError(err)
    expect(result.name).toBe("Error")
    expect(result.message).toBe("something broke")
    expect(result.stack).toBeString()
  })

  test("serializes a PluginRuntimeError", () => {
    const err = new PluginRuntimeError("p-x", "CRASH", "it crashed")
    const result = serializeError(err)
    expect(result.name).toBe("PluginRuntimeError")
    expect(result.message).toBe("it crashed")
  })

  test("serializes an error with a nested cause", () => {
    const cause = new Error("root")
    const err = new PluginRuntimeError("p-y", "SPAWN_FAILED", "spawn failed", { cause })
    const result = serializeError(err)
    expect(result.cause).toBeDefined()
    expect(result.cause!.name).toBe("Error")
    expect(result.cause!.message).toBe("root")
  })

  test("serializes a deeply nested cause chain", () => {
    const c3 = new Error("level 3")
    const c2 = new Error("level 2", { cause: c3 })
    const c1 = new Error("level 1", { cause: c2 })
    const err = new PluginRuntimeError("p-z", "DEEP", "deep failure", { cause: c1 })
    const result = serializeError(err)
    expect(result.cause).toBeDefined()
    expect(result.cause!.message).toBe("level 1")
    expect(result.cause!.cause).toBeDefined()
    expect(result.cause!.cause!.message).toBe("level 2")
    expect(result.cause!.cause!.cause).toBeDefined()
    expect(result.cause!.cause!.cause!.message).toBe("level 3")
  })

  test("returns name 'Error' and message for non-Error objects", () => {
    const result = serializeError("just a string")
    expect(result.name).toBe("Error")
    expect(result.message).toBe("just a string")
  })

  test("handles null/undefined gracefully", () => {
    const result = serializeError(null)
    expect(result.name).toBe("Error")
    expect(result.message).toBe("null")
  })

  test("serialized error has no circular cause", () => {
    // A regular Error with no cause should not include a cause field
    const err = new Error("simple")
    const result = serializeError(err)
    expect(result.cause).toBeUndefined()
  })
})

// =============================================================================
// deserializeError
// =============================================================================
describe("deserializeError", () => {
  test("deserializes a basic serialized error back to an Error", () => {
    const serialized = { name: "Error", message: "something broke" }
    const err = deserializeError(serialized)
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe("Error")
    expect(err.message).toBe("something broke")
  })

  test("preserves the name from the serialized error", () => {
    const serialized = { name: "PluginRuntimeError", message: "crash" }
    const err = deserializeError(serialized)
    expect(err.name).toBe("PluginRuntimeError")
  })

  test("restores stack trace when present", () => {
    const serialized = { name: "Error", message: "bad", stack: "at foo.ts:10:4" }
    const err = deserializeError(serialized)
    expect(err.stack).toBe("at foo.ts:10:4")
  })

  test("deserializes nested causes", () => {
    const serialized = {
      name: "PluginRuntimeError",
      message: "outer",
      cause: { name: "Error", message: "inner" },
    }
    const err = deserializeError(serialized)
    expect(err.cause).toBeInstanceOf(Error)
    expect((err.cause as Error).message).toBe("inner")
  })

  test("deserializes deeply nested causes", () => {
    const serialized = {
      name: "PluginRuntimeError",
      message: "a",
      cause: {
        name: "Error",
        message: "b",
        cause: {
          name: "TypeError",
          message: "c",
        },
      },
    }
    const err = deserializeError(serialized)
    expect(err.message).toBe("a")
    const cause1 = err.cause as Error
    expect(cause1.message).toBe("b")
    const cause2 = cause1.cause as Error
    expect(cause2.message).toBe("c")
    expect(cause2.name).toBe("TypeError")
  })

  test("handles missing stack gracefully", () => {
    const serialized = { name: "Error", message: "no stack" }
    const err = deserializeError(serialized)
    expect(err.stack).toBeDefined()
  })
})

// =============================================================================
// classifyRuntimeExit
// =============================================================================
describe("classifyRuntimeExit", () => {
  test("exit code 0 with no signal is normal", () => {
    expect(classifyRuntimeExit(0, null)).toBe("normal")
  })

  test("non-zero exit code with no signal is crash", () => {
    expect(classifyRuntimeExit(1, null)).toBe("crash")
    expect(classifyRuntimeExit(42, null)).toBe("crash")
    expect(classifyRuntimeExit(255, null)).toBe("crash")
  })

  test("null exit code with SIGTERM is terminated", () => {
    expect(classifyRuntimeExit(null, "SIGTERM")).toBe("terminated")
  })

  test("null exit code with SIGKILL is killed", () => {
    expect(classifyRuntimeExit(null, "SIGKILL")).toBe("killed")
  })

  test("null exit code with other signal is signaled", () => {
    expect(classifyRuntimeExit(null, "SIGABRT")).toBe("signaled")
    expect(classifyRuntimeExit(null, "SIGSEGV")).toBe("signaled")
    expect(classifyRuntimeExit(null, "SIGBUS")).toBe("signaled")
  })

  test("both non-null exit code and signal: signal wins", () => {
    // When both are present, signal classification takes priority
    expect(classifyRuntimeExit(1, "SIGKILL")).toBe("killed")
    expect(classifyRuntimeExit(1, "SIGTERM")).toBe("terminated")
    expect(classifyRuntimeExit(1, "SIGSEGV")).toBe("signaled")
  })

  test("both null is treated as normal", () => {
    // Edge case: no exit code and no signal (process still running or unknown)
    expect(classifyRuntimeExit(null, null)).toBe("normal")
  })
})
