import { describe, expect, test } from "bun:test"
import { SynergyLinkExecution } from "../../src/tool/synergy-link-execution"

describe("Synergy Link execution helpers", () => {
  test("omitted remote target is intentional local execution", async () => {
    await expect(
      SynergyLinkExecution.resolveExecutionTarget({
        linkIDSupplied: false,
        targetIDSupplied: false,
        tool: "bash",
        agent: "build",
      }),
    ).resolves.toEqual({
      kind: "local",
    })
  })

  test("invalid supplied linkID fails closed", async () => {
    await expect(
      SynergyLinkExecution.resolveExecutionTarget({
        linkID: "env_test",
        linkIDSupplied: true,
        targetIDSupplied: false,
        tool: "bash",
        agent: "build",
      }),
    ).rejects.toThrow("Invalid linkID")
  })

  test("valid linkID with no client fails closed", async () => {
    SynergyLinkExecution.setClient(null)
    await expect(
      SynergyLinkExecution.resolveExecutionTarget({
        linkID: "link_test",
        linkIDSupplied: true,
        targetIDSupplied: false,
        tool: "process",
        agent: "build",
      }),
    ).rejects.toThrow("is not connected")
  })

  test("unknown targetID fails before any local execution can occur", async () => {
    await expect(
      SynergyLinkExecution.resolveExecutionTarget({
        targetID: "target_missing",
        targetIDSupplied: true,
        linkIDSupplied: false,
        tool: "bash",
        agent: "build",
      }),
    ).rejects.toThrow("Synergy Link target not found")
  })
})
