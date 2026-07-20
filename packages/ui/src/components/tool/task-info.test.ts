import { describe, expect, test } from "bun:test"
import { TOOL_TITLE_DESC } from "../tool-title-descriptors"
import { getTaskToolInfo, getTaskToolTrigger } from "./task-info"

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

  test("builds the registered renderer trigger from the shared task metadata", () => {
    const trigger = getTaskToolTrigger(
      {
        subagent_type: "explore",
        description: "Inspect the tool registry",
      },
      { backgroundLabel: "Background" },
    )

    expect(trigger).toEqual({
      icon: "list-todo",
      title: TOOL_TITLE_DESC.task,
      subtitle: "Inspect the tool registry",
      tags: [{ label: "explore" }, { label: "Background" }],
    })
  })
})
