import { describe, expect, test } from "bun:test"
import { ToolExecutor } from "../../src/session/tool-executor"

describe("ToolExecutor", () => {
  test("classifies capability families without changing tool identities", () => {
    expect(ToolExecutor.classify("bash")).toBe("local_process")
    expect(ToolExecutor.classify("read")).toBe("file")
    expect(ToolExecutor.classify("scan_files")).toBe("file")
    expect(ToolExecutor.classify("browser_action")).toBe("browser")
    expect(ToolExecutor.classify("link_invoke")).toBe("link")
    expect(
      ToolExecutor.classify("plugin__example__probe", {
        type: "plugin",
        pluginId: "example",
        toolId: "probe",
        runtimeMode: "process",
      }),
    ).toBe("plugin")
    expect(
      ToolExecutor.classify("local__custom__probe", {
        type: "local",
      }),
    ).toBe("plugin")
    expect(ToolExecutor.classify("task")).toBe("control_plane")
    expect(ToolExecutor.classify("question")).toBe("control_plane")
  })
})
