import { describe, expect, test } from "bun:test"
import type { ProjectDirectories, SessionWorkspace } from "@ericsanchezok/synergy-sdk"
import {
  computeForkCounts,
  copiedSummaryKind,
  forkHistoryIsComplete,
  forkReplyPreview,
  forkWorkspaceChoices,
} from "../../../src/components/session/dialog-fork-confirm-model"

const timeline = [
  { id: "u1", role: "user" },
  { id: "a1", role: "assistant" },
  { id: "u2", role: "user" },
  { id: "a2", role: "assistant" },
  { id: "a3", role: "assistant" },
] as const

describe("fork confirm counts", () => {
  test("counts user messages and assistant replies through the target message inclusive", () => {
    expect(computeForkCounts([...timeline], "a2")).toEqual({ userMessages: 2, assistantReplies: 2 })
    expect(computeForkCounts([...timeline], "u1")).toEqual({ userMessages: 1, assistantReplies: 0 })
    expect(computeForkCounts([...timeline], "a3")).toEqual({ userMessages: 2, assistantReplies: 3 })
  })

  test("ignores system and other roles when counting", () => {
    const mixed = [
      { id: "s1", role: "system" },
      { id: "u1", role: "user" },
      { id: "a1", role: "assistant" },
      { id: "x1", role: "tool" },
    ]
    expect(computeForkCounts(mixed, "a1")).toEqual({ userMessages: 1, assistantReplies: 1 })
  })

  test("returns zero counts when the target message is not in the timeline", () => {
    expect(computeForkCounts([...timeline], "missing")).toEqual({ userMessages: 0, assistantReplies: 0 })
  })

  test("counts the entire conversation when no message boundary is selected", () => {
    expect(computeForkCounts([...timeline])).toEqual({ userMessages: 2, assistantReplies: 3 })
  })

  test("whole-conversation counts require both the beginning and latest end of history", () => {
    expect(forkHistoryIsComplete({ hasEarlier: false, atLatest: true })).toBe(true)
    expect(forkHistoryIsComplete({ hasEarlier: true, atLatest: true })).toBe(false)
    expect(forkHistoryIsComplete({ hasEarlier: false, atLatest: false })).toBe(false)
  })

  test("a reply boundary can be counted without the later tail but never without the beginning", () => {
    expect(forkHistoryIsComplete({ hasEarlier: false, atLatest: false, messageID: "a1" })).toBe(true)
    expect(forkHistoryIsComplete({ hasEarlier: true, atLatest: false, messageID: "a1" })).toBe(false)
  })
})

describe("fork working locations", () => {
  const main: SessionWorkspace = { id: "main", generation: 3, type: "directory", path: "/project", scopeID: "project" }
  const tree: SessionWorkspace = { id: "tree", generation: 2, type: "git_worktree", path: "/tree", scopeID: "project" }
  const directories: ProjectDirectories = {
    version: 1,
    scopeID: "project",
    revision: 1,
    mainWorkspaceID: "main",
    additionalWorkspaceIDs: [],
    folders: [{ workspaceID: "main", generation: 3, path: "/project", available: true, git: true }],
  }

  test("main-directory forks offer main and new worktree without a duplicate current option", () => {
    expect(forkWorkspaceChoices(main, directories).map((choice) => choice.id)).toEqual(["main", "create"])
  })

  test("worktree forks distinguish main, a new worktree, and the same worktree", () => {
    const choices = forkWorkspaceChoices(tree, directories)
    expect(choices.map((choice) => choice.id)).toEqual(["main", "create", "current"])
    expect(choices[0]?.workspace).toEqual({ mode: "workspace", workspaceID: "main", workspaceGeneration: 3 })
    expect(choices[1]?.workspace).toEqual({ mode: "create", sourceWorkspaceID: "main" })
    expect(choices[2]?.workspace).toEqual({ mode: "current" })
    expect(choices[2]?.kind).toBe("worktree")
  })

  test("non-Git projects cannot request a new worktree", () => {
    expect(
      forkWorkspaceChoices(main, { ...directories, folders: [{ ...directories.folders[0]!, git: false }] }).map(
        (choice) => choice.id,
      ),
    ).toEqual(["main"])
  })

  test("unavailable main directories are not offered as destinations or worktree sources", () => {
    expect(
      forkWorkspaceChoices(tree, { ...directories, folders: [{ ...directories.folders[0]!, available: false }] }).map(
        (choice) => choice.id,
      ),
    ).toEqual(["current"])
  })

  test("without local directory capability the source binding is preserved, including no workspace", () => {
    expect(forkWorkspaceChoices(tree)[0]?.workspace).toEqual({ mode: "current" })
    expect(forkWorkspaceChoices(null)[0]?.workspace).toEqual({ mode: "none" })
  })
})

describe("copied summary kind", () => {
  test("picks the ICU branch matching the copied roles", () => {
    expect(copiedSummaryKind({ userMessages: 2, assistantReplies: 2 })).toBe("both")
    expect(copiedSummaryKind({ userMessages: 1, assistantReplies: 0 })).toBe("messages")
    expect(copiedSummaryKind({ userMessages: 0, assistantReplies: 3 })).toBe("replies")
    expect(copiedSummaryKind({ userMessages: 0, assistantReplies: 0 })).toBe("other")
  })
})

describe("fork reply preview", () => {
  test("uses the first non-system text part, trimmed and truncated", () => {
    const parts = [
      { type: "tool", name: "bash" },
      { type: "text", text: "  System preamble  ", origin: "system" },
      { type: "text", text: "  Here is the reply  ", origin: "user" },
    ]
    expect(forkReplyPreview(parts)).toBe("Here is the reply")

    const long = "x".repeat(200)
    expect(forkReplyPreview([{ type: "text", text: long, origin: "user" }])).toBe(`${"x".repeat(95)}\u2026`)
  })

  test("skips synthetic parts and returns undefined without user text", () => {
    expect(forkReplyPreview([{ type: "text", text: "hidden", synthetic: true }])).toBeUndefined()
    expect(forkReplyPreview([{ type: "text", text: "system only", origin: "system" }])).toBeUndefined()
    expect(forkReplyPreview([{ type: "text", text: "   " }])).toBeUndefined()
    expect(forkReplyPreview([])).toBeUndefined()
  })
})
