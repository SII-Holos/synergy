import { describe, expect, test } from "bun:test"
import {
  GithubChannelPollState,
  initializeBaseline,
  synthesizeEvents,
} from "../../../../src/channel/provider/github/synthesizer"

const NOW = 1_700_000_000_000
const BEFORE = NOW - 3_600_000

function freshState(repository = "owner/repo", now = NOW): GithubChannelPollState {
  return GithubChannelPollState.parse({
    repository,
    baselineTimestampMs: now,
    lastUpdatedAt: now,
    seenIssues: {},
    seenPullRequests: {},
    seenComments: {},
  })
}

function issue(number: number, createdAt: string, updatedAt: string, login = "alice", body = "body") {
  return {
    id: 10_000 + number,
    number,
    title: `Issue ${number}`,
    body,
    state: "open",
    created_at: createdAt,
    updated_at: updatedAt,
    user: { login },
    html_url: `https://github.com/owner/repo/issues/${number}`,
  }
}

function pullRequest(
  number: number,
  createdAt: string,
  updatedAt: string,
  headSha: string,
  login = "bob",
  draft = false,
) {
  return {
    id: 20_000 + number,
    number,
    title: `PR ${number}`,
    body: "pr body",
    state: "open",
    draft,
    created_at: createdAt,
    updated_at: updatedAt,
    user: { login },
    head: { sha: headSha, ref: `feature-${number}` },
    base: { ref: "main" },
  }
}

function comment(id: number, issueNumber: number, createdAt: string, body: string, login = "carol") {
  return {
    id,
    body,
    created_at: createdAt,
    user: { login },
  }
}

function iso(ms: number) {
  return new Date(ms).toISOString()
}

describe("github channel synthesizer — baseline", () => {
  test("initializes baseline state", () => {
    const state = initializeBaseline("owner/repo", NOW)
    expect(state.baselineTimestampMs).toBe(NOW)
    expect(state.lastUpdatedAt).toBe(NOW)
    expect(Object.keys(state.seenIssues)).toHaveLength(0)
    expect(Object.keys(state.seenPullRequests)).toHaveLength(0)
    expect(Object.keys(state.seenComments)).toHaveLength(0)
  })

  test("suppresses pre-baseline items on first poll", () => {
    const state = freshState()
    const result = synthesizeEvents(state, {
      repository: "owner/repo",
      issues: [issue(1, iso(BEFORE), iso(BEFORE))],
      pullRequests: [],
      commentsByIssue: {},
    })
    expect(result.events).toHaveLength(0)
    expect(result.state.lastUpdatedAt).toBeGreaterThanOrEqual(state.lastUpdatedAt)
  })
})

describe("github channel synthesizer — issues", () => {
  test("emits issue.opened for a new issue after baseline", () => {
    const state = freshState()
    const result = synthesizeEvents(state, {
      repository: "owner/repo",
      issues: [issue(1, iso(NOW + 1_000), iso(NOW + 1_000))],
      pullRequests: [],
      commentsByIssue: {},
    })
    expect(result.events).toHaveLength(1)
    expect(result.events[0]).toMatchObject({
      kind: "issue.opened",
      repository: "owner/repo",
      issueNumber: 1,
      sender: "alice",
      title: "Issue 1",
    })
  })

  test("dedups the same issue on the next poll", () => {
    const state = freshState()
    const first = synthesizeEvents(state, {
      repository: "owner/repo",
      issues: [issue(1, iso(NOW + 1_000), iso(NOW + 1_000))],
      pullRequests: [],
      commentsByIssue: {},
    })
    expect(first.events).toHaveLength(1)

    const second = synthesizeEvents(first.state, {
      repository: "owner/repo",
      issues: [issue(1, iso(NOW + 1_000), iso(NOW + 1_000))],
      pullRequests: [],
      commentsByIssue: {},
    })
    expect(second.events).toHaveLength(0)
  })

  test("skips PR-shaped issue entries (handled as pull requests)", () => {
    const state = freshState()
    const result = synthesizeEvents(state, {
      repository: "owner/repo",
      issues: [
        {
          ...issue(2, iso(NOW + 1_000), iso(NOW + 1_000)),
          pull_request: { url: "https://api.github.com/repos/owner/repo/pulls/2" },
        },
      ],
      pullRequests: [],
      commentsByIssue: {},
    })
    expect(result.events).toHaveLength(0)
  })
})

describe("github channel synthesizer — pull requests", () => {
  test("emits pull_request.opened for a new open PR", () => {
    const state = freshState()
    const result = synthesizeEvents(state, {
      repository: "owner/repo",
      issues: [],
      pullRequests: [pullRequest(3, iso(NOW + 1_000), iso(NOW + 1_000), "abc123")],
      commentsByIssue: {},
    })
    expect(result.events).toHaveLength(1)
    expect(result.events[0]).toMatchObject({
      kind: "pull_request.opened",
      repository: "owner/repo",
      pullNumber: 3,
      headSha: "abc123",
      baseRef: "main",
      sender: "bob",
    })
  })

  test("does not emit pull_request.synchronize when the head SHA changes (pushes do not re-review)", () => {
    const state = freshState()
    const first = synthesizeEvents(state, {
      repository: "owner/repo",
      issues: [],
      pullRequests: [pullRequest(3, iso(NOW + 1_000), iso(NOW + 1_000), "abc123")],
      commentsByIssue: {},
    })
    expect(first.events).toHaveLength(1)

    const second = synthesizeEvents(first.state, {
      repository: "owner/repo",
      issues: [],
      pullRequests: [pullRequest(3, iso(NOW + 1_000), iso(NOW + 5_000), "def456")],
      commentsByIssue: {},
    })
    expect(second.events).toHaveLength(0)
    // The new head SHA is still recorded so later comments see the new head.
    expect(second.state.seenPullRequests["3"]?.headSha).toBe("def456")
  })

  test("does not emit synchronize when the PR is closed", () => {
    const state = freshState()
    const first = synthesizeEvents(state, {
      repository: "owner/repo",
      issues: [],
      pullRequests: [pullRequest(3, iso(NOW + 1_000), iso(NOW + 1_000), "abc123")],
      commentsByIssue: {},
    })
    const closed = {
      ...pullRequest(3, iso(NOW + 1_000), iso(NOW + 5_000), "def456"),
      state: "closed",
    }
    const second = synthesizeEvents(first.state, {
      repository: "owner/repo",
      issues: [],
      pullRequests: [closed],
      commentsByIssue: {},
    })
    expect(second.events).toHaveLength(0)
  })
  test("does not emit pull_request.opened for a draft PR", () => {
    const state = freshState()
    const result = synthesizeEvents(state, {
      repository: "owner/repo",
      issues: [],
      pullRequests: [pullRequest(3, iso(NOW + 1_000), iso(NOW + 1_000), "abc123", "bob", true)],
      commentsByIssue: {},
    })
    expect(result.events).toHaveLength(0)
    // The draft state is still recorded so a later ready transition can fire.
    expect(result.state.seenPullRequests["3"]?.draft).toBe(true)
  })

  test("does not emit pull_request.synchronize while a draft PR pushes", () => {
    const state = freshState()
    const first = synthesizeEvents(state, {
      repository: "owner/repo",
      issues: [],
      pullRequests: [pullRequest(3, iso(NOW + 1_000), iso(NOW + 1_000), "abc123", "bob", true)],
      commentsByIssue: {},
    })
    expect(first.events).toHaveLength(0)

    const second = synthesizeEvents(first.state, {
      repository: "owner/repo",
      issues: [],
      pullRequests: [pullRequest(3, iso(NOW + 1_000), iso(NOW + 5_000), "def456", "bob", true)],
      commentsByIssue: {},
    })
    expect(second.events).toHaveLength(0)
    expect(second.state.seenPullRequests["3"]?.headSha).toBe("def456")
  })

  test("emits pull_request.ready_for_review when a draft PR becomes ready", () => {
    const state = freshState()
    const first = synthesizeEvents(state, {
      repository: "owner/repo",
      issues: [],
      pullRequests: [pullRequest(3, iso(NOW + 1_000), iso(NOW + 1_000), "abc123", "bob", true)],
      commentsByIssue: {},
    })
    expect(first.events).toHaveLength(0)

    const second = synthesizeEvents(first.state, {
      repository: "owner/repo",
      issues: [],
      pullRequests: [pullRequest(3, iso(NOW + 1_000), iso(NOW + 6_000), "abc123", "bob", false)],
      commentsByIssue: {},
    })
    expect(second.events).toHaveLength(1)
    expect(second.events[0]).toMatchObject({
      kind: "pull_request.ready_for_review",
      pullNumber: 3,
      headSha: "abc123",
    })
  })
})

describe("github channel synthesizer — comments", () => {
  test("emits comment.created for a new comment", () => {
    const state = freshState()
    const result = synthesizeEvents(state, {
      repository: "owner/repo",
      issues: [],
      pullRequests: [],
      commentsByIssue: {
        5: [comment(101, 5, iso(NOW + 1_000), "hello @synergy", "carol")],
      },
    })
    expect(result.events).toHaveLength(1)
    expect(result.events[0]).toMatchObject({
      kind: "comment.created",
      issueNumber: 5,
      commentId: 101,
      sender: "carol",
      body: "hello @synergy",
      isPullRequest: false,
    })
  })

  test("marks comments on pull requests as isPullRequest and attaches head SHA", () => {
    const state = freshState()
    // The PR predates the baseline so only the comment event is emitted.
    const result = synthesizeEvents(state, {
      repository: "owner/repo",
      issues: [],
      pullRequests: [pullRequest(5, iso(BEFORE), iso(BEFORE), "sha999")],
      commentsByIssue: {
        5: [comment(102, 5, iso(NOW + 1_000), "review this", "carol")],
      },
    })
    expect(result.events).toHaveLength(1)
    expect(result.events[0]).toMatchObject({
      kind: "comment.created",
      isPullRequest: true,
      pullHeadSha: "sha999",
    })
  })

  test("dedups the same comment on the next poll", () => {
    const state = freshState()
    const first = synthesizeEvents(state, {
      repository: "owner/repo",
      issues: [],
      pullRequests: [],
      commentsByIssue: {
        5: [comment(103, 5, iso(NOW + 1_000), "again", "carol")],
      },
    })
    expect(first.events).toHaveLength(1)

    const second = synthesizeEvents(first.state, {
      repository: "owner/repo",
      issues: [],
      pullRequests: [],
      commentsByIssue: {
        5: [comment(103, 5, iso(NOW + 1_000), "again", "carol")],
      },
    })
    expect(second.events).toHaveLength(0)
  })

  test("skips bot comments to avoid echo loops", () => {
    const state = freshState()
    const result = synthesizeEvents(state, {
      repository: "owner/repo",
      issues: [],
      pullRequests: [],
      commentsByIssue: {
        5: [comment(104, 5, iso(NOW + 1_000), "auto reply", "synergy[bot]")],
      },
    })
    expect(result.events).toHaveLength(0)
  })
})

describe("github channel synthesizer — watermark and pruning", () => {
  test("advances lastUpdatedAt to the newest observed timestamp", () => {
    const state = freshState()
    const result = synthesizeEvents(state, {
      repository: "owner/repo",
      issues: [issue(1, iso(NOW + 1_000), iso(NOW + 9_000))],
      pullRequests: [],
      commentsByIssue: {},
    })
    expect(result.state.lastUpdatedAt).toBe(NOW + 9_000)
  })

  test("keeps open pull requests in state after pruning", () => {
    const state = freshState()
    const first = synthesizeEvents(state, {
      repository: "owner/repo",
      issues: [],
      pullRequests: [pullRequest(3, iso(NOW + 1_000), iso(NOW + 1_000), "abc123")],
      commentsByIssue: {},
    })
    const key = "3"
    expect(first.state.seenPullRequests[key]).toBeDefined()
    expect(first.state.seenPullRequests[key]?.state).toBe("open")
  })
})
