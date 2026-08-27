import { describe, expect, test } from "bun:test"
import { WorkflowUserWrapper } from "../../src/session/workflow-user-wrapper"

/**
 * Light Loop prompt contract (S3a golden). Locks the byte-level shape of the
 * Light Loop user-message wrappers before the S3b vertical slice moves the
 * bytes into the light-loop domain. Any diff here must be an explicit product
 * decision, never a refactor side effect.
 */

describe("light loop user-message wrapper golden", () => {
  test("generic agent wrapper is byte-exact", () => {
    expect(WorkflowUserWrapper.build("some-agent", "lightloop", "ship the importer")).toBe(
      [
        "<lightloop-user-request>",
        "You are in the Light Loop workflow.",
        "Complete the work thoroughly. Keep working until the task is fully done, then call loop_stop() to request a completion review.",
        "",
        "User request:",
        "ship the importer",
        "</lightloop-user-request>",
      ].join("\n"),
    )
  })

  test("synergy wrapper is byte-exact", () => {
    expect(WorkflowUserWrapper.build("synergy", "lightloop", "ship the importer")).toBe(
      [
        "<lightloop-user-request>",
        "You are synergy in the Light Loop workflow.",
        "Complete the work thoroughly. Keep working and iterating until the task is fully done, then call loop_stop() to request a completion review.",
        "",
        "User request:",
        "ship the importer",
        "</lightloop-user-request>",
      ].join("\n"),
    )
  })

  test("synergy-max wrapper is byte-exact", () => {
    expect(WorkflowUserWrapper.build("synergy-max", "lightloop", "ship the importer")).toBe(
      [
        "<lightloop-user-request>",
        "You are synergy-max in the Light Loop workflow.",
        "Complete the work thoroughly. Keep working and iterating until the task is fully done, then call loop_stop() to request a completion review.",
        "",
        "User request:",
        "ship the importer",
        "</lightloop-user-request>",
      ].join("\n"),
    )
  })

  test("empty request normalizes to the sentinel", () => {
    expect(WorkflowUserWrapper.build("synergy", "lightloop", "   ")).toContain("(empty request)")
  })
})
