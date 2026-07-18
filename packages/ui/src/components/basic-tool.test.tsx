import { describe, expect, test } from "bun:test"
import { withSubtitleClickHandler } from "./tool/trigger-normalization"

const trigger = {
  icon: "list-todo",
  title: "Task Agent",
  subtitle: "Open child session",
} as const

describe("BasicTool trigger normalization", () => {
  test("keeps the outer subtitle click handler for structured trigger props", () => {
    const onSubtitleClick = () => {}

    const normalized = withSubtitleClickHandler(trigger, onSubtitleClick)

    expect(normalized.onSubtitleClick).toBe(onSubtitleClick)
  })

  test("preserves an explicit structured trigger subtitle handler", () => {
    const triggerHandler = () => {}
    const outerHandler = () => {}
    const normalized = withSubtitleClickHandler({ ...trigger, onSubtitleClick: triggerHandler }, outerHandler)

    expect(normalized.onSubtitleClick).toBe(triggerHandler)
  })
})
