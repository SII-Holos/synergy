import { describe, expect, test } from "bun:test"
import { gateGithubEvent } from "../../../../src/channel/provider/github/gate"

const baseComment = {
  kind: "comment.created" as const,
  repository: "owner/repo",
  issueNumber: 5,
  commentId: 101,
  body: "hello",
  sender: "carol",
  createdAt: 1_700_000_000_000,
  isPullRequest: false,
}

describe("github channel event gate — comments", () => {
  test("delivers a comment that mentions @synergy-agent when autoRespond is on", () => {
    const gate = gateGithubEvent(
      { ...baseComment, body: "Can you @synergy-agent review this?" },
      { autoReview: true, autoRespond: true },
    )
    expect(gate).toEqual({ kind: "deliver" })
  })

  test("skips a comment without @synergy-agent mention", () => {
    const gate = gateGithubEvent({ ...baseComment, body: "Just chatting" }, { autoReview: true, autoRespond: true })
    expect(gate).toEqual({ kind: "skip", reason: "no @synergy-agent mention" })
  })

  test("skips all comments when autoRespond is off", () => {
    const gate = gateGithubEvent(
      { ...baseComment, body: "Can you @synergy-agent review this?" },
      { autoReview: true, autoRespond: false },
    )
    expect(gate).toEqual({ kind: "skip", reason: "autoRespond disabled" })
  })

  test("matches @synergy-agent case-insensitively and at handle boundaries", () => {
    expect(
      gateGithubEvent({ ...baseComment, body: "@Synergy-Agent please" }, { autoReview: true, autoRespond: true }),
    ).toEqual({ kind: "deliver" })
    expect(
      gateGithubEvent({ ...baseComment, body: "@synergy-agent1 no" }, { autoReview: true, autoRespond: true }),
    ).toEqual({
      kind: "skip",
      reason: "no @synergy-agent mention",
    })
    expect(
      gateGithubEvent({ ...baseComment, body: "@synergy-agent-extra no" }, { autoReview: true, autoRespond: true }),
    ).toEqual({ kind: "skip", reason: "no @synergy-agent mention" })
  })

  test("does not trigger on a plain @synergy mention (account name is synergy-agent)", () => {
    const gate = gateGithubEvent(
      { ...baseComment, body: "Can you @synergy review this?" },
      { autoReview: true, autoRespond: true },
    )
    expect(gate).toEqual({ kind: "skip", reason: "no @synergy-agent mention" })
  })
})

describe("github channel event gate — issues and pull requests", () => {
  test("delivers issue.opened when autoRespond is on", () => {
    const gate = gateGithubEvent(
      {
        kind: "issue.opened",
        repository: "owner/repo",
        issueNumber: 1,
        title: "Bug",
        body: "It crashes",
        sender: "alice",
        createdAt: 1_700_000_000_000,
        issueId: 9_001,
      },
      { autoReview: true, autoRespond: true },
    )
    expect(gate).toEqual({ kind: "deliver" })
  })

  test("skips issue.opened when autoRespond is off", () => {
    const gate = gateGithubEvent(
      {
        kind: "issue.opened",
        repository: "owner/repo",
        issueNumber: 1,
        title: "Bug",
        body: "It crashes",
        sender: "alice",
        createdAt: 1_700_000_000_000,
        issueId: 9_001,
      },
      { autoReview: true, autoRespond: false },
    )
    expect(gate).toEqual({ kind: "skip", reason: "autoRespond disabled" })
  })

  test("delivers pull_request.opened when autoReview is on", () => {
    const gate = gateGithubEvent(
      {
        kind: "pull_request.opened",
        repository: "owner/repo",
        pullNumber: 3,
        title: "Feature",
        body: "Adds thing",
        sender: "bob",
        headSha: "abc123",
        baseRef: "main",
        createdAt: 1_700_000_000_000,
        pullId: 20_003,
      },
      { autoReview: true, autoRespond: true },
    )
    expect(gate).toEqual({ kind: "deliver" })
  })

  test("skips pull_request.synchronize when autoReview is off", () => {
    const gate = gateGithubEvent(
      {
        kind: "pull_request.synchronize",
        repository: "owner/repo",
        pullNumber: 3,
        title: "Feature",
        headSha: "def456",
        sender: "bob",
        createdAt: 1_700_000_000_000,
        pullId: 20_003,
      },
      { autoReview: false, autoRespond: true },
    )
    expect(gate).toEqual({ kind: "skip", reason: "autoReview disabled" })
  })
})
