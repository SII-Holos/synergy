import { expect, test } from "bun:test"
import { ToolExposure } from "../../src/tool/exposure"
import { testRuntime } from "../support/runtime"

test("embedded group selection permits an owned replacement without changing another Runtime", async () => {
  const session = {
    id: "session",
    title: "Hosted sessions",
    description: "Owned session operations",
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

test("legacy plugin exposure keeps the canonical discovery description without a second routing field", async () => {
  await using runtime = await testRuntime()
  await runtime.run(() => {
    const exposure = {
      mode: "group" as const,
      group: "snapshot-review",
      title: "Snapshot review",
      description: "Inspect saved snapshots before restoring files.",
      whenToExpand: "Obsolete expansion guidance",
    }
    const { whenToExpand, ...current } = exposure
    expect(ToolExposure.normalize("snapshot_review", exposure)).toEqual(current)
    const groups = ToolExposure.availableGroups([{ id: "snapshot_review", exposure }])
    expect(groups).toEqual([
      {
        id: exposure.group,
        title: exposure.title,
        description: exposure.description,
        tools: ["snapshot_review"],
        keywords: [],
      },
    ])
    expect(ToolExposure.score({ ...groups[0]!, id: exposure.group }, "restoring files")).toBeGreaterThan(0)
    expect(ToolExposure.score({ ...groups[0]!, id: exposure.group }, whenToExpand)).toBe(0)
  })
})
