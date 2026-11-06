import { describe, expect, test } from "bun:test"
import { gateGithubEvent } from "../../../../src/channel/provider/github/gate"
import { afterAll as afterRuntimeTests } from "bun:test"
import { testRuntime } from "../../../support/runtime"
const runtime = await testRuntime()

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

/** The GitHub App slug users @-mention; matches the account the App posts as. */
const MENTION = "synergy-agent"

const gated = (body: string, overrides: { autoReview?: boolean; autoRespond?: boolean; mention?: string } = {}) =>
  gateGithubEvent({ ...baseComment, body }, { autoReview: true, autoRespond: true, mention: MENTION, ...overrides })

describe("github channel event gate — comments", () => {
  test("delivers a comment that mentions the App slug when autoRespond is on", () =>
    runtime.run(() => {
      expect(gated("Can you @synergy-agent review this?")).toEqual({ kind: "deliver" })
    }))

  test("skips a comment without the App slug mention", () =>
    runtime.run(() => {
      expect(gated("Just chatting")).toEqual({ kind: "skip", reason: "no @synergy-agent mention" })
    }))

  test("skips all comments when autoRespond is off", () =>
    runtime.run(() => {
      expect(gated("Can you @synergy-agent review this?", { autoRespond: false })).toEqual({
        kind: "skip",
        reason: "autoRespond disabled",
      })
    }))

  test("skips when the mention name is unavailable", () =>
    runtime.run(() => {
      expect(
        gateGithubEvent(
          { ...baseComment, body: "Can you @synergy-agent review this?" },
          {
            autoReview: true,
            autoRespond: true,
          },
        ),
      ).toEqual({ kind: "skip", reason: "mention name unavailable" })
    }))

  test("matches the mention case-insensitively and at handle boundaries", () =>
    runtime.run(() => {
      expect(gated("@Synergy-Agent please")).toEqual({ kind: "deliver" })
      expect(gated("@synergy-agent1 no")).toEqual({ kind: "skip", reason: "no @synergy-agent mention" })
      expect(gated("@synergy-agent-extra no")).toEqual({ kind: "skip", reason: "no @synergy-agent mention" })
    }))

  test("does not trigger on a different handle (mention follows the configured App)", () =>
    runtime.run(() => {
      expect(gated("Can you @other-bot review this?")).toEqual({ kind: "skip", reason: "no @synergy-agent mention" })
    }))

  test("honors a configured mention override", () =>
    runtime.run(() => {
      const gate = gateGithubEvent(
        { ...baseComment, body: "Can you @my-company-bot review this?" },
        { autoReview: true, autoRespond: true, mention: "my-company-bot" },
      )
      expect(gate).toEqual({ kind: "deliver" })
    }))

  test("escapes regex metacharacters in the mention slug", () =>
    runtime.run(() => {
      const gate = gateGithubEvent(
        { ...baseComment, body: "Can you @my.bot review this?" },
        { autoReview: true, autoRespond: true, mention: "my.bot" },
      )
      expect(gate).toEqual({ kind: "deliver" })
    }))
})

describe("github channel event gate — issues and pull requests", () => {
  test("delivers issue.opened when autoRespond is on", () =>
    runtime.run(() => {
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
    }))

  test("skips issue.opened when autoRespond is off", () =>
    runtime.run(() => {
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
    }))

  test("delivers pull_request.opened when autoReview is on", () =>
    runtime.run(() => {
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
    }))

  test("skips pull_request.synchronize when autoReview is off", () =>
    runtime.run(() => {
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
    }))
})

afterRuntimeTests(() => runtime.close())
