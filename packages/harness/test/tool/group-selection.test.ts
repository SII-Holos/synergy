import { expect, test } from "bun:test"
import { ToolExposure } from "../../src/tool/exposure"
import { testRuntime } from "../support/runtime"

test("embedded group selection permits an owned replacement without changing another Runtime", async () => {
  const session = {
    id: "session",
    title: "Hosted sessions",
    description: "Owned session operations",
    whenToExpand: "Inspect history",
    tools: ["session_read"],
  }
  await using selected = await testRuntime({
    register: () => {
      ToolExposure.selectDefaultGroups([])
      ToolExposure.registerGroups("host", [session])
    },
  })
  await using defaults = await testRuntime()
  await selected.run(async () => {
    expect(ToolExposure.groups()).toEqual([session])
    expect(() => ToolExposure.selectDefaultGroups(["session"])).toThrow("before opening the Runtime")
  })
  await defaults.run(async () => {
    expect(ToolExposure.groups()[0]?.title).toBe("Session")
    expect(ToolExposure.groups()[0]?.tools).toContain("session_control")
  })
})

test("unknown defaults and selection after group consumption fail explicitly", async () => {
  await expect(testRuntime({ register: () => ToolExposure.selectDefaultGroups(["unknown"]) })).rejects.toThrow(
    "Unknown default tool group",
  )
  await expect(
    testRuntime({
      register: () => {
        ToolExposure.groups()
        ToolExposure.selectDefaultGroups([])
      },
    }),
  ).rejects.toThrow("before group registration")
})
