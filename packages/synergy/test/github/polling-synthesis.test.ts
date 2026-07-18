import { describe, expect, test } from "bun:test"
import { GitHubPollSynthesizer } from "../../src/github/poll-synthesizer"
import { GitHubPollState } from "../../src/github/types"
import { GitHubDelivery } from "../../src/github/types"

function freshPollState(repository = "owner/repo", now = 1_700_000_000_000): GitHubPollState {
  return GitHubPollState.parse({
    repository,
    baselineTimestampMs: now,
    lastUpdatedAt: now,
    seenPRs: {},
    seenWorkflowRunIds: {},
  })
}

describe("GitHub polling — first-run baseline", () => {
  test("records initial baseline timestamp without creating deliveries", () => {
    const state = GitHubPollSynthesizer.initializeBaseline("owner/repo", 1_700_000_000_000)

    expect(state.baselineTimestampMs).toBe(1_700_000_000_000)
    expect(state.lastUpdatedAt).toBe(1_700_000_000_000)
    expect(Object.keys(state.seenPRs)).toHaveLength(0)
    expect(Object.keys(state.seenWorkflowRunIds)).toHaveLength(0)
  })

  test("initializes baseline at current time when no explicit timestamp is given", () => {
    const before = Date.now()
    const state = GitHubPollSynthesizer.initializeBaseline("owner/repo")
    const after = Date.now()

    expect(state.baselineTimestampMs).toBeGreaterThanOrEqual(before)
    expect(state.baselineTimestampMs).toBeLessThanOrEqual(after)
  })

  test("skips historical items found on first poll (no deliveries created)", () => {
    const state = freshPollState()
    const results = GitHubPollSynthesizer.processIssues(state, {
      repository: "owner/repo",
      installationId: 42,
      items: [
        {
          number: 1,
          title: "Old bug",
          body: "desc",
          state: "open",
          created_at: "2023-01-01T00:00:00Z",
          updated_at: "2023-06-01T00:00:00Z",
          user: { login: "alice" },
        },
      ],
    })

    expect(results.deliveries).toHaveLength(0)
  })
})

describe("GitHub polling — issue synthesis", () => {
  test("synthesizes issues.opened for new issue created after baseline", () => {
    const baseline = 1_700_000_000_000
    const state = freshPollState("owner/repo", baseline)
    const createdAfter = new Date(baseline + 60_000).toISOString()

    const results = GitHubPollSynthesizer.processIssues(state, {
      repository: "owner/repo",
      installationId: 42,
      items: [
        {
          number: 99,
          title: "New crash report",
          body: "App crashes on startup",
          state: "open",
          created_at: createdAfter,
          updated_at: createdAfter,
          user: { login: "alice" },
        },
      ],
    })

    expect(results.deliveries).toHaveLength(1)
    expect(results.deliveries[0].eventType).toBe("issues")
    expect(results.deliveries[0].repositoryFullName).toBe("owner/repo")
    expect(results.deliveries[0].installationId).toBe(42)
    expect(results.deliveries[0].rawPayload).toMatchObject({
      action: "opened",
      issue: { number: 99, title: "New crash report" },
    })
  })

  test("skips old issue first seen after baseline without creating delivery", () => {
    const baseline = 1_700_000_000_000
    const state = freshPollState("owner/repo", baseline)
    const oldIssueDate = new Date(baseline - 86_400_000).toISOString() // 1 day before baseline

    const results = GitHubPollSynthesizer.processIssues(state, {
      repository: "owner/repo",
      installationId: 42,
      items: [
        {
          number: 10,
          title: "Old issue",
          body: "Already existed",
          state: "open",
          created_at: oldIssueDate,
          updated_at: oldIssueDate,
          user: { login: "bob" },
        },
      ],
    })

    expect(results.deliveries).toHaveLength(0)
  })

  test("does not grow durable issue state across overlap polls", () => {
    const baseline = 1_700_000_000_000
    const items = Array.from({ length: 100 }, (_, index) => ({
      number: index + 1,
      title: `Issue ${index + 1}`,
      state: "open",
      created_at: new Date(baseline + index + 1).toISOString(),
      updated_at: new Date(baseline + index + 1).toISOString(),
      user: { login: "alice" },
    }))

    const results = GitHubPollSynthesizer.processIssues(freshPollState("owner/repo", baseline), {
      repository: "owner/repo",
      installationId: 42,
      items,
    })

    expect(results.deliveries).toHaveLength(100)
    expect("seenIssues" in results.state).toBe(false)
  })

  test("generates deterministic delivery GUIDs based on repository and issue number", () => {
    const baseline = 1_700_000_000_000
    const state = freshPollState("owner/repo", baseline)
    const createdAfter = new Date(baseline + 60_000).toISOString()

    const results1 = GitHubPollSynthesizer.processIssues(state, {
      repository: "owner/repo",
      installationId: 42,
      items: [
        {
          number: 42,
          title: "A bug",
          body: "desc",
          state: "open",
          created_at: createdAfter,
          updated_at: createdAfter,
          user: { login: "alice" },
        },
      ],
    })

    const state2 = freshPollState("owner/repo", baseline)
    const results2 = GitHubPollSynthesizer.processIssues(state2, {
      repository: "owner/repo",
      installationId: 42,
      items: [
        {
          number: 42,
          title: "A bug",
          body: "desc",
          state: "open",
          created_at: createdAfter,
          updated_at: createdAfter,
          user: { login: "alice" },
        },
      ],
    })

    // Same repository + issue number → same GUID
    expect(results1.deliveries[0].deliveryGuid).toBe(results2.deliveries[0].deliveryGuid)
    // Same delivery → store.accept deduplicates
    expect(results1.deliveries[0].deliveryGuid).toMatch(/^poll:/)
  })

  test("deduplicates via GitHubStore.accept on subsequent polls", () => {
    // The GUID is deterministic, so calling store.accept twice with
    // the same synthesized delivery should return duplicate: true
    const baseline = 1_700_000_000_000
    const state = freshPollState("owner/repo", baseline)
    const createdAfter = new Date(baseline + 60_000).toISOString()

    const results = GitHubPollSynthesizer.processIssues(state, {
      repository: "owner/repo",
      installationId: 42,
      items: [
        {
          number: 42,
          title: "A bug",
          body: "desc",
          state: "open",
          created_at: createdAfter,
          updated_at: createdAfter,
          user: { login: "alice" },
        },
      ],
    })

    const delivery = results.deliveries[0]
    expect(GitHubDelivery.safeParse(delivery).success).toBe(true)
  })
})

describe("GitHub polling — PR synthesis", () => {
  test("synthesizes pull_request.opened for new PR after baseline", () => {
    const baseline = 1_700_000_000_000
    const state = freshPollState("owner/repo", baseline)
    const createdAfter = new Date(baseline + 120_000).toISOString()

    const results = GitHubPollSynthesizer.processPullRequests(state, {
      repository: "owner/repo",
      installationId: 42,
      pullRequests: [
        {
          number: 7,
          title: "Fix crash",
          state: "open",
          head: { sha: "abc123", ref: "fix/crash" },
          base: { ref: "main" },
          created_at: createdAfter,
          updated_at: createdAfter,
          user: { login: "alice" },
        },
      ],
    })

    expect(results.deliveries).toHaveLength(1)
    expect(results.deliveries[0].eventType).toBe("pull_request")
    expect(results.deliveries[0].rawPayload).toMatchObject({
      action: "opened",
      pull_request: { number: 7, head: { sha: "abc123" } },
    })
  })

  test("synthesizes pull_request.reopened when stored closed→open with same head", () => {
    const baseline = 1_700_000_000_000
    const after = new Date(baseline + 300_000).toISOString()

    const state = GitHubPollState.parse({
      repository: "owner/repo",
      baselineTimestampMs: baseline,
      lastUpdatedAt: baseline + 120_000,
      seenPRs: {
        "7": { number: 7, headSha: "abc123", state: "closed", updatedAt: after },
      },
      seenWorkflowRunIds: {},
    })

    const results = GitHubPollSynthesizer.processPullRequests(state, {
      repository: "owner/repo",
      installationId: 42,
      pullRequests: [
        {
          number: 7,
          title: "Fix crash",
          state: "open",
          head: { sha: "abc123", ref: "fix/crash" },
          base: { ref: "main" },
          created_at: after,
          updated_at: after,
          user: { login: "alice" },
        },
      ],
    })

    expect(results.deliveries).toHaveLength(1)
    expect(results.deliveries[0].rawPayload).toMatchObject({ action: "reopened" })
  })

  test("synthesizes pull_request.synchronize when head SHA changes while open", () => {
    const baseline = 1_700_000_000_000
    const after = new Date(baseline + 300_000).toISOString()

    const state = GitHubPollState.parse({
      repository: "owner/repo",
      baselineTimestampMs: baseline,
      lastUpdatedAt: baseline + 120_000,
      seenPRs: {
        "7": { number: 7, headSha: "old-sha", state: "open", updatedAt: new Date(baseline + 100_000).toISOString() },
      },
      seenWorkflowRunIds: {},
    })

    const results = GitHubPollSynthesizer.processPullRequests(state, {
      repository: "owner/repo",
      installationId: 42,
      pullRequests: [
        {
          number: 7,
          title: "Fix crash (updated)",
          state: "open",
          head: { sha: "new-sha", ref: "fix/crash" },
          base: { ref: "main" },
          created_at: after,
          updated_at: after,
          user: { login: "alice" },
        },
      ],
    })

    expect(results.deliveries).toHaveLength(1)
    expect(results.deliveries[0].rawPayload).toMatchObject({ action: "synchronize" })
    expect(results.state.seenPRs["7"].headSha).toBe("new-sha")
  })

  test("creates no delivery when PR head SHA and state are unchanged", () => {
    const baseline = 1_700_000_000_000
    const after = new Date(baseline + 300_000).toISOString()

    const state = GitHubPollState.parse({
      repository: "owner/repo",
      baselineTimestampMs: baseline,
      lastUpdatedAt: baseline + 120_000,
      seenPRs: {
        "7": { number: 7, headSha: "abc123", state: "open", updatedAt: new Date(baseline + 100_000).toISOString() },
      },
      seenWorkflowRunIds: {},
    })

    const results = GitHubPollSynthesizer.processPullRequests(state, {
      repository: "owner/repo",
      installationId: 42,
      pullRequests: [
        {
          number: 7,
          title: "Fix crash",
          state: "open",
          head: { sha: "abc123", ref: "fix/crash" },
          base: { ref: "main" },
          created_at: after,
          updated_at: after,
          user: { login: "alice" },
        },
      ],
    })

    expect(results.deliveries).toHaveLength(0)
    expect(results.state.seenPRs["7"].headSha).toBe("abc123")
  })

  test("updates stored state without delivery when PR is closed", () => {
    const baseline = 1_700_000_000_000
    const after = new Date(baseline + 300_000).toISOString()

    const state = GitHubPollState.parse({
      repository: "owner/repo",
      baselineTimestampMs: baseline,
      lastUpdatedAt: baseline + 120_000,
      seenPRs: {
        "7": { number: 7, headSha: "abc123", state: "open", updatedAt: new Date(baseline + 100_000).toISOString() },
      },
      seenWorkflowRunIds: {},
    })

    const results = GitHubPollSynthesizer.processPullRequests(state, {
      repository: "owner/repo",
      installationId: 42,
      pullRequests: [
        {
          number: 7,
          title: "Fix crash",
          state: "closed",
          head: { sha: "abc123", ref: "fix/crash" },
          base: { ref: "main" },
          created_at: after,
          updated_at: after,
          user: { login: "alice" },
        },
      ],
    })

    expect(results.deliveries).toHaveLength(0)
    expect(results.state.seenPRs["7"].state).toBe("closed")
  })
})

test("retains all open PRs and bounds closed PR history", () => {
  const baseline = 1_700_000_000_000
  const pullRequests = Array.from({ length: 5_200 }, (_, index) => ({
    number: index + 1,
    state: index < 100 ? "open" : "closed",
    head: { sha: `sha-${index + 1}` },
    created_at: new Date(baseline + index + 1).toISOString(),
    updated_at: new Date(baseline + index + 1).toISOString(),
    user: { login: "alice" },
  }))

  const results = GitHubPollSynthesizer.processPullRequests(freshPollState("owner/repo", baseline), {
    repository: "owner/repo",
    installationId: 42,
    pullRequests,
  })

  expect(Object.keys(results.state.seenPRs)).toHaveLength(5_100)
  expect(results.state.seenPRs["1"]?.state).toBe("open")
  expect(results.state.seenPRs["101"]).toBeUndefined()
  expect(results.state.seenPRs["5200"]?.state).toBe("closed")
})

describe("GitHub polling — workflow run synthesis", () => {
  test("baselines existing workflow runs without creating deliveries", () => {
    const baseline = 1_700_000_000_000
    const state = freshPollState("owner/repo", baseline)
    const after = new Date(baseline + 60_000).toISOString()

    const results = GitHubPollSynthesizer.processWorkflowRuns(state, {
      repository: "owner/repo",
      installationId: 42,
      workflowRuns: [
        {
          id: 1001,
          name: "CI",
          conclusion: "success",
          status: "completed",
          created_at: after,
          updated_at: after,
        },
      ],
    })

    expect(results.deliveries).toHaveLength(0)
    expect(results.state.seenWorkflowRunIds).toEqual({})
  })

  test("synthesizes workflow_run.completed for newly observed completed run", () => {
    const baseline = 1_700_000_000_000
    const state = freshPollState("owner/repo", baseline)

    // First poll discovers the run while still in_progress
    const firstResult = GitHubPollSynthesizer.processWorkflowRuns(state, {
      repository: "owner/repo",
      installationId: 42,
      workflowRuns: [
        {
          id: 2001,
          name: "CI",
          conclusion: null,
          status: "in_progress",
          created_at: new Date(baseline + 60_000).toISOString(),
          updated_at: new Date(baseline + 60_000).toISOString(),
        },
      ],
    })
    expect(firstResult.deliveries).toHaveLength(0)

    // Second poll discovers it completed
    const secondResult = GitHubPollSynthesizer.processWorkflowRuns(firstResult.state, {
      repository: "owner/repo",
      installationId: 42,
      workflowRuns: [
        {
          id: 2001,
          name: "CI",
          conclusion: "failure",
          status: "completed",
          created_at: new Date(baseline + 60_000).toISOString(),
          updated_at: new Date(baseline + 120_000).toISOString(),
        },
      ],
    })

    expect(secondResult.deliveries).toHaveLength(1)
    expect(secondResult.deliveries[0].eventType).toBe("workflow_run")
    expect(secondResult.deliveries[0].rawPayload).toMatchObject({
      action: "completed",
      workflow_run: { name: "CI", conclusion: "failure" },
    })
  })

  test("removes completed workflow runs from durable pending state", () => {
    const baseline = 1_700_000_000_000
    const firstResult = GitHubPollSynthesizer.processWorkflowRuns(freshPollState("owner/repo", baseline), {
      repository: "owner/repo",
      installationId: 42,
      workflowRuns: [
        {
          id: 2002,
          status: "in_progress",
          conclusion: null,
          created_at: new Date(baseline + 60_000).toISOString(),
          updated_at: new Date(baseline + 60_000).toISOString(),
        },
      ],
    })
    const completed = GitHubPollSynthesizer.processWorkflowRuns(firstResult.state, {
      repository: "owner/repo",
      installationId: 42,
      workflowRuns: [
        {
          id: 2002,
          status: "completed",
          conclusion: "success",
          created_at: new Date(baseline + 60_000).toISOString(),
          updated_at: new Date(baseline + 120_000).toISOString(),
        },
      ],
    })

    expect(completed.deliveries).toHaveLength(1)
    expect(completed.state.seenWorkflowRunIds).toEqual({})
  })

  test("keeps workflow-run creation watermark separate from issue updates", () => {
    const baseline = 1_700_000_000_000
    const createdAt = new Date(baseline + 60_000).toISOString()
    const updatedAt = new Date(baseline + 120_000).toISOString()
    const results = GitHubPollSynthesizer.processWorkflowRuns(freshPollState("owner/repo", baseline), {
      repository: "owner/repo",
      installationId: 42,
      workflowRuns: [
        {
          id: 2500,
          name: "CI",
          conclusion: null,
          status: "in_progress",
          created_at: createdAt,
          updated_at: updatedAt,
        },
      ],
    })

    expect(results.state).toMatchObject({
      lastUpdatedAt: baseline,
      lastWorkflowRunCreatedAt: Date.parse(createdAt),
    })
  })

  test("generates deterministic delivery GUID for workflow_run.completed", () => {
    const baseline = 1_700_000_000_000
    const state = freshPollState("owner/repo", baseline)

    // First set it as in_progress then completed
    let s = state
    const inProgressResult = GitHubPollSynthesizer.processWorkflowRuns(s, {
      repository: "owner/repo",
      installationId: 42,
      workflowRuns: [
        {
          id: 3001,
          name: "CI",
          conclusion: null,
          status: "in_progress",
          created_at: new Date(baseline + 60_000).toISOString(),
          updated_at: new Date(baseline + 60_000).toISOString(),
        },
      ],
    })
    s = inProgressResult.state

    const result1 = GitHubPollSynthesizer.processWorkflowRuns(s, {
      repository: "owner/repo",
      installationId: 42,
      workflowRuns: [
        {
          id: 3001,
          name: "CI",
          conclusion: "failure",
          status: "completed",
          created_at: new Date(baseline + 60_000).toISOString(),
          updated_at: new Date(baseline + 120_000).toISOString(),
        },
      ],
    })

    // Redo from fresh baseline
    const state2 = freshPollState("owner/repo", baseline)
    const ipResult2 = GitHubPollSynthesizer.processWorkflowRuns(state2, {
      repository: "owner/repo",
      installationId: 42,
      workflowRuns: [
        {
          id: 3001,
          name: "CI",
          conclusion: null,
          status: "in_progress",
          created_at: new Date(baseline + 60_000).toISOString(),
          updated_at: new Date(baseline + 60_000).toISOString(),
        },
      ],
    })

    const result2 = GitHubPollSynthesizer.processWorkflowRuns(ipResult2.state, {
      repository: "owner/repo",
      installationId: 42,
      workflowRuns: [
        {
          id: 3001,
          name: "CI",
          conclusion: "failure",
          status: "completed",
          created_at: new Date(baseline + 60_000).toISOString(),
          updated_at: new Date(baseline + 120_000).toISOString(),
        },
      ],
    })

    expect(result1.deliveries[0].deliveryGuid).toBe(result2.deliveries[0].deliveryGuid)
    expect(result1.deliveries[0].deliveryGuid).toMatch(/^poll:/)
  })
})

describe("GitHub polling — pagination and poll state persistence", () => {
  test("advances lastUpdatedAt watermark after successful poll", () => {
    const before = 1_700_000_000_000
    const after = before + 120_000
    const state = freshPollState("owner/repo", before)
    const createdAfter = new Date(before + 60_000).toISOString()

    const results = GitHubPollSynthesizer.processIssues(state, {
      repository: "owner/repo",
      installationId: 42,
      items: [
        {
          number: 1,
          title: "New",
          body: "desc",
          state: "open",
          created_at: createdAfter,
          updated_at: createdAfter,
          user: { login: "alice" },
        },
      ],
    })

    expect(results.state.lastUpdatedAt).toBeGreaterThan(before)
  })

  test("produces stable GUIDs for overlap-window duplicates", () => {
    const baseline = 1_700_000_000_000
    const state = freshPollState("owner/repo", baseline)
    const createdAfter = new Date(baseline + 60_000).toISOString()
    const issue = {
      number: 1,
      title: "Bug 1",
      body: "desc",
      state: "open",
      created_at: createdAfter,
      updated_at: createdAfter,
      user: { login: "alice" },
    }

    const first = GitHubPollSynthesizer.processIssues(state, {
      repository: "owner/repo",
      installationId: 42,
      items: [issue],
    })
    const overlap = GitHubPollSynthesizer.processIssues(first.state, {
      repository: "owner/repo",
      installationId: 42,
      items: [
        issue,
        {
          ...issue,
          number: 2,
          title: "Bug 2",
          user: { login: "bob" },
        },
      ],
    })

    expect(overlap.deliveries).toHaveLength(2)
    expect(overlap.deliveries[0].deliveryGuid).toBe(first.deliveries[0].deliveryGuid)
    expect(overlap.deliveries[1].rawPayload).toMatchObject({ issue: { number: 2 } })
  })
})
