import { describe, expect, test } from "bun:test"
import { buildExplanation, formatExplanationForModel, type SandboxBlockExplanation } from "../../src/sandbox/explain"
import { EnforcementError } from "../../src/enforcement/errors"

// ---------------------------------------------------------------------------
// sandbox/explain-model.test.ts
//
// Model-facing sandbox denial explanation.
//
// A sandbox denial is an execution-time boundary, not a policy refusal. The
// model must be able to tell the two apart, must know the command may already
// have produced partial side effects inside the workspace, and must be told the
// concrete path and how to proceed — including that `autonomous` cannot approve
// anything. A backend that cannot parse a path must still yield a usable
// explanation instead of crashing or silently running unsandboxed.
// ---------------------------------------------------------------------------

function writeDenial(overrides: Partial<Parameters<typeof buildExplanation>[0]> = {}) {
  return buildExplanation({
    kind: "filesystem",
    platform: "macos",
    backend: "sandbox-exec",
    command: '/bin/sh -c out=/tmp/synergy-out.txt; echo hi > "$out"',
    access: "write",
    path: "/tmp/synergy-out.txt",
    denialSource: "os",
    rawMessage: "deny(1) file-write-data /tmp/synergy-out.txt",
    profileMode: "workspace_write",
    networkMode: "restricted",
    allowedWriteRoots: ["/Users/test/workspace"],
    allowedReadRoots: ["/Users/test/workspace", "/usr/bin"],
    deniedPaths: ["/tmp/synergy-out.txt"],
    ...overrides,
  })
}

describe("model-facing sandbox denial explanation", () => {
  test("carries the denied path and reads as an execution boundary, not a policy refusal", () => {
    const text = formatExplanationForModel(writeDenial(), { controlProfile: "guarded" })

    expect(text).toContain("/tmp/synergy-out.txt")
    expect(text).toContain("execution")
    expect(text).toContain("not a policy")
    expect(text).not.toContain("Do not retry the same approach.")
  })

  test("warns that the command may already have produced partial side effects", () => {
    const text = formatExplanationForModel(writeDenial(), { controlProfile: "guarded" })

    expect(text).toMatch(/partial side effects/i)
    expect(text).toMatch(/workspace/i)
  })

  test("names the path and offers approval for exactly that path under guarded", () => {
    const text = formatExplanationForModel(writeDenial(), { controlProfile: "guarded" })

    expect(text).toContain("approve")
    expect(text).toContain("/tmp/synergy-out.txt")
    expect(text).not.toMatch(/no approval is possible/i)
  })

  test("states that autonomous cannot approve and cannot retry the command as-is", () => {
    const text = formatExplanationForModel(writeDenial(), { controlProfile: "autonomous" })

    expect(text).toMatch(/autonomous/i)
    expect(text).toMatch(/no approval is possible|never prompts|cannot be approved/i)
    expect(text).toMatch(/cannot be retried as-is|do not retry/i)
  })

  test("degrades gracefully when no concrete path could be parsed", () => {
    const explanation = writeDenial({
      path: undefined,
      deniedPaths: [],
      access: undefined,
      rawMessage: "Operation not permitted",
    })

    expect(explanation.path).toBeUndefined()
    const text = formatExplanationForModel(explanation, { controlProfile: "guarded" })

    expect(text.length).toBeGreaterThan(0)
    expect(text).toMatch(/partial side effects/i)
    expect(text).toMatch(/could not identify|no specific path/i)
    expect(text).not.toMatch(/Request approval for exactly this path: undefined/)
  })

  test("still explains a denial the backend could not structure at all", () => {
    const text = formatExplanationForModel(undefined, {
      message: "Command blocked by macos sandbox (sandbox-exec).",
      controlProfile: "guarded",
    })

    expect(text).toContain("Command blocked by macos sandbox")
    expect(text).toMatch(/partial side effects/i)
    expect(text).toMatch(/not a policy/i)
  })

  test("confirms the path is usable again once the approval was granted", () => {
    const text = formatExplanationForModel(writeDenial(), {
      controlProfile: "guarded",
      approved: { path: "/tmp/synergy-out.txt", access: "write" },
    })

    expect(text).toMatch(/approved/i)
    expect(text).toMatch(/retry/i)
    expect(text).not.toMatch(/no approval is possible/i)
  })

  test("surfaces the structured sandbox facts the explanation already carried", () => {
    const text = formatExplanationForModel(writeDenial(), { controlProfile: "guarded" })

    expect(text).toContain("workspace_write")
    expect(text).toContain("sandbox-exec")
    expect(text).toContain("/Users/test/workspace")
    expect(text).toContain("deny(1) file-write-data /tmp/synergy-out.txt")
  })

  test("explanation is attached to the structured error the resolver formats", () => {
    const explanation: SandboxBlockExplanation = writeDenial()
    const error = new EnforcementError.SandboxBlocked("blocked", 1, "seatbelt_file_write", "raw", explanation)

    expect(error.explanation?.path).toBe("/tmp/synergy-out.txt")
    expect(error.explanation?.recovery).toContainEqual({
      type: "approve_path",
      path: "/tmp/synergy-out.txt",
      access: "write",
    })
    expect(error.explanation?.recovery).toContainEqual({
      type: "move_to_workspace",
      path: "/tmp/synergy-out.txt",
    })
  })
})
