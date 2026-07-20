import { describe, expect, test } from "bun:test"
import { TOOL_TITLE_DESC } from "../tool-title-descriptors"
import { getTaskToolInfo } from "./task-info"

describe("task tool card title", () => {
  test("presents delegation as an action and keeps the agent type as metadata", () => {
    const info = getTaskToolInfo({
      subagent_type: "explore",
      description: "Inspect the tool registry",
    })

    expect(info.title).toBe(TOOL_TITLE_DESC.task)
    expect(info.subtitle).toBe("Inspect the tool registry")
    expect(info.args).toEqual(["explore"])
  })
})
