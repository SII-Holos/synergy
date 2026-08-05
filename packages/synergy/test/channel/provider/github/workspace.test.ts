import { describe, expect, test } from "bun:test"
import path from "path"
import { Global } from "../../../../src/global"
import { GithubChannelWorkspace } from "../../../../src/channel/provider/github/workspace"
import {
  isNumericCommentId,
  lookupBodyChat,
  lookupCommentChat,
  registerBodyChat,
  registerCommentChat,
  resetCommentChatMap,
} from "../../../../src/channel/provider/github/reactions"

describe("github channel workspace — directory resolution", () => {
  test("resolves a deterministic per-thread directory under the configured workspace root", () => {
    const first = GithubChannelWorkspace.resolveDirectory({
      accountId: "default",
      workspaceDir: "github-workspaces",
      repository: "owner/repo",
      issueNumber: 42,
    })
    const second = GithubChannelWorkspace.resolveDirectory({
      accountId: "default",
      workspaceDir: "github-workspaces",
      repository: "owner/repo",
      issueNumber: 42,
    })
    expect(first).toBe(second)
    expect(path.dirname(first)).toBe(path.join(Global.Path.home, "github-workspaces"))
    expect(path.basename(first)).toMatch(/^[0-9a-f]{16}$/)
  })

  test("different issues resolve to different directories", () => {
    const a = GithubChannelWorkspace.resolveDirectory({
      accountId: "default",
      workspaceDir: "github-workspaces",
      repository: "owner/repo",
      issueNumber: 42,
    })
    const b = GithubChannelWorkspace.resolveDirectory({
      accountId: "default",
      workspaceDir: "github-workspaces",
      repository: "owner/repo",
      issueNumber: 43,
    })
    expect(a).not.toBe(b)
  })

  test("different repositories resolve to different directories", () => {
    const a = GithubChannelWorkspace.resolveDirectory({
      accountId: "default",
      workspaceDir: "github-workspaces",
      repository: "owner/repo-a",
      issueNumber: 1,
    })
    const b = GithubChannelWorkspace.resolveDirectory({
      accountId: "default",
      workspaceDir: "github-workspaces",
      repository: "owner/repo-b",
      issueNumber: 1,
    })
    expect(a).not.toBe(b)
  })

  test("find returns undefined for unknown threads", async () => {
    const record = await GithubChannelWorkspace.find({
      accountId: "missing",
      repository: "owner/repo",
      issueNumber: 999_999,
    })
    expect(record).toBeUndefined()
  })

  test("list returns empty for unknown accounts", async () => {
    const records = await GithubChannelWorkspace.list({ accountId: "missing" })
    expect(records).toEqual([])
  })
})

describe("github channel reactions — comment and body registry", () => {
  test("registers and looks up comment chat mapping", () => {
    resetCommentChatMap()
    registerCommentChat("12345", "owner/repo#7")
    expect(lookupCommentChat("12345")).toBe("owner/repo#7")
  })

  test("registers and looks up synthetic body (issue/PR) chat mapping", () => {
    resetCommentChatMap()
    registerBodyChat("pr-opened-9001", "owner/repo#7")
    expect(lookupBodyChat("pr-opened-9001")).toBe("owner/repo#7")
    expect(lookupCommentChat("pr-opened-9001")).toBeUndefined()
  })

  test("isNumericCommentId accepts real comment IDs and rejects synthetic event IDs", () => {
    expect(isNumericCommentId("12345")).toBe(true)
    expect(isNumericCommentId("issue-9001")).toBe(false)
    expect(isNumericCommentId("pr-opened-9001")).toBe(false)
    expect(isNumericCommentId("comment-123")).toBe(false)
    expect(isNumericCommentId("0")).toBe(false)
    expect(isNumericCommentId("")).toBe(false)
  })

  test("reset clears both registries", () => {
    registerCommentChat("999", "owner/repo#1")
    registerBodyChat("issue-888", "owner/repo#2")
    resetCommentChatMap()
    expect(lookupCommentChat("999")).toBeUndefined()
    expect(lookupBodyChat("issue-888")).toBeUndefined()
  })
})
