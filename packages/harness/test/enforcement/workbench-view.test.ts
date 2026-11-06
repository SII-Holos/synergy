import { afterAll, expect, test } from "bun:test"
import { EnforcementGate } from "../../src/enforcement/gate"
import { ToolTaxonomy } from "../../src/tool/taxonomy"
import { testRuntime } from "../support/runtime"

const runtime = await testRuntime()
afterAll(() => runtime.close())

test("presentation has its own taxonomy rather than Browser execution", () => {
  expect(ToolTaxonomy.classify("workbench_view")).toEqual({
    kind: "platform.presentation",
    domain: "platform",
    traits: { stateful: true, auxiliary: true },
  })
})

test("showing a file retains precise read and protected-path authorization", () =>
  runtime.run(async () => {
    const gate = await EnforcementGate.create({
      activeWorkspace: "/fixture/work",
      workspaceType: "worktree",
      profileId: "guarded",
    })
    const local = gate.classify("workbench_view", {
      input: { action: "open", target: { kind: "workspace-file", path: "src/index.ts" } },
    })
    expect(local.capabilities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ class: "session_state" }),
        expect.objectContaining({ class: "file_read", paths: ["src/index.ts"] }),
      ]),
    )
    const secret = gate.classify("workbench_view", {
      input: { action: "open", target: { kind: "workspace-file", path: "/Users/test/.ssh/id_rsa" } },
    })
    expect(secret.capabilities.some((item) => item.class === "secrets" && item.nonBypassable)).toBe(true)
    expect(secret.capabilities.some((item) => item.class === "file_external_read")).toBe(true)
    expect(
      gate.evaluate("workbench_view", {
        input: { action: "open", target: { kind: "workspace-file", path: "/Users/test/.ssh/id_rsa" } },
      }).decision,
    ).not.toBe("allow")
  }))

test("viewing an existing page or hiding a view grants no Browser input or network authority", () =>
  runtime.run(async () => {
    const gate = await EnforcementGate.create({ activeWorkspace: null, workspaceType: "home" })
    for (const input of [
      { action: "open", target: { kind: "browser-page", pageId: "page" } },
      { action: "open", target: { kind: "note", id: "note" } },
      { action: "hide", viewId: "view" },
      { action: "status" },
    ]) {
      expect(gate.classify("workbench_view", { input }).capabilities).toEqual([
        { class: "session_state", nonBypassable: false },
      ])
    }
  }))
