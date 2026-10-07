import { expect, test } from "bun:test"
import { EnforcementGate } from "../../src/enforcement/gate"
import { testRuntime } from "../support/runtime"

for (const pathMode of ["relative", "posix"] as const) {
  test(`logical file paths retain their boundary in a ${pathMode} Workspace`, async () => {
    await using runtime = await testRuntime()
    await runtime.run(async () => {
      const options = {
        pathMode,
        activeWorkspace: pathMode === "relative" ? "/workspace" : "/isolated/mount",
        workspaceType: "main",
        profileId: "autonomous" as const,
      }
      const gate = await EnforcementGate.create({ ...options, virtualRoot: "/workspace" })
      for (const tool of ["read", "write"]) {
        const capability = tool === "read" ? "file_read" : "file_write"
        for (const filePath of ["results/sum.json", "/workspace/results/sum.json"]) {
          expect(gate.classify(tool, { filePath }).capabilities).toContainEqual({
            class: capability,
            nonBypassable: false,
            paths: [filePath],
          })
        }
        for (const filePath of ["/workspace-other/sum.json", "/workspace/../outside", "../outside", "/etc/file"]) {
          expect(gate.classify(tool, { filePath }).capabilities.some((cap) => cap.class === capability)).toBe(false)
        }
      }
      const isolated = await gate.evaluateIsolated("write", { filePath: "/workspace/results/sum.json" })
      expect(isolated.capabilities).toContainEqual({
        class: "file_write",
        nonBypassable: false,
        paths: ["/workspace/results/sum.json"],
      })
      // A logical file alias cannot authorize the same absolute path in a shell.
      const physical = await EnforcementGate.create(options)
      const command = { command: "printf value > /workspace/results/sum.json" }
      expect(gate.classify("bash", command)).toEqual(physical.classify("bash", command))
    })
  })
}

test("a logical alias never expands a native filesystem boundary", async () => {
  await using runtime = await testRuntime()
  await runtime.run(async () => {
    const gate = await EnforcementGate.create({
      activeWorkspace: "/isolated/mount",
      workspaceType: "main",
      pathMode: "native",
      virtualRoot: "/workspace",
    })
    expect(gate.classify("write", { filePath: "/workspace/result.json" }).capabilities).toContainEqual({
      class: "file_external_write",
      nonBypassable: true,
      paths: ["/workspace/result.json"],
    })
  })
})
