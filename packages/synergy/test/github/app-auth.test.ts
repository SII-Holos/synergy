import { describe, expect, mock, test } from "bun:test"
import { generateKeyPairSync } from "node:crypto"
import { GitHubAppAuth } from "../../src/github/app-auth"

describe("GitHub App authentication", () => {
  test("generates a signed JWT with appId and private key", () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 })
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString()
    const token = GitHubAppAuth.generateJWT({ appId: 12345, privateKey: pem })
    expect(typeof token).toBe("string")
    expect(token.split(".")).toHaveLength(3)
    // Decode the JWT to verify claims without verifying signature
    const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString())
    expect(payload.iss).toBe(12345)
    expect(payload.exp).toBeGreaterThan(Date.now() / 1000)
    expect(payload.exp - payload.iat).toBeLessThanOrEqual(600)
  })

  test("rejects JWT generation without private key", () => {
    expect(() => GitHubAppAuth.generateJWT({ appId: 12345, privateKey: "" })).toThrow()
  })

  test("rejects JWT generation with zero appId", () => {
    expect(() =>
      GitHubAppAuth.generateJWT({
        appId: 0,
        privateKey: "-----BEGIN RSA PRIVATE KEY-----\n...\n-----END RSA PRIVATE KEY-----",
      }),
    ).toThrow()
  })
})

test("GitHub REST calls have a bounded timeout and authentication cache can be reset", async () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 })
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString()
  const originalFetch = globalThis.fetch
  const originalAppId = process.env.SYNERGY_GITHUB_APP_ID
  const originalPrivateKey = process.env.SYNERGY_GITHUB_APP_PRIVATE_KEY
  const signals: AbortSignal[] = []
  const request = mock(async (_input: string | URL | Request, init?: RequestInit) => {
    if (init?.signal) signals.push(init.signal)
    return new Response(
      JSON.stringify({ token: "ghs_cached", expires_at: new Date(Date.now() + 10 * 60 * 1_000).toISOString() }),
      { status: 201 },
    )
  })

  try {
    process.env.SYNERGY_GITHUB_APP_ID = "12345"
    process.env.SYNERGY_GITHUB_APP_PRIVATE_KEY = pem
    globalThis.fetch = request as unknown as typeof fetch
    GitHubAppAuth.reset()

    expect(await GitHubAppAuth.getInstallationToken(42)).toBe("ghs_cached")
    expect(await GitHubAppAuth.getInstallationToken(42)).toBe("ghs_cached")
    expect(request).toHaveBeenCalledTimes(1)

    GitHubAppAuth.reset()
    expect(await GitHubAppAuth.getInstallationToken(42)).toBe("ghs_cached")
    expect(request).toHaveBeenCalledTimes(2)
    expect(signals).toHaveLength(2)
    expect(signals.every((signal) => signal instanceof AbortSignal && !signal.aborted)).toBe(true)
  } finally {
    GitHubAppAuth.reset()
    globalThis.fetch = originalFetch
    if (originalAppId === undefined) delete process.env.SYNERGY_GITHUB_APP_ID
    else process.env.SYNERGY_GITHUB_APP_ID = originalAppId
    if (originalPrivateKey === undefined) delete process.env.SYNERGY_GITHUB_APP_PRIVATE_KEY
    else process.env.SYNERGY_GITHUB_APP_PRIVATE_KEY = originalPrivateKey
  }
})

describe("GitHub App token cache", () => {
  test("getInstallationToken returns cached token within validity window", () => {
    const cache = new GitHubAppAuth.TokenCache()

    const freshToken = { token: "ghs_token_1", expiresAt: new Date(Date.now() + 600_000).toISOString() }
    cache.set(42, freshToken)
    expect(cache.get(42)).toEqual(freshToken)
  })

  test("returns undefined for expired token", () => {
    const cache = new GitHubAppAuth.TokenCache()

    const expiredToken = { token: "ghs_old", expiresAt: new Date(Date.now() - 60_000).toISOString() }
    cache.set(42, expiredToken)
    expect(cache.get(42)).toBeUndefined()
  })

  test("returns undefined for token within refresh window (5 minutes)", () => {
    const cache = new GitHubAppAuth.TokenCache()

    const nearExpiry = { token: "ghs_near", expiresAt: new Date(Date.now() + 120_000).toISOString() }
    cache.set(42, nearExpiry)
    expect(cache.get(42)).toBeUndefined()
  })

  test("returns undefined for unknown installation", () => {
    const cache = new GitHubAppAuth.TokenCache()
    expect(cache.get(99)).toBeUndefined()
  })

  test("stores and retrieves tokens per-installation", () => {
    const cache = new GitHubAppAuth.TokenCache()

    const token1 = { token: "ghs_1", expiresAt: new Date(Date.now() + 600_000).toISOString() }
    const token2 = { token: "ghs_2", expiresAt: new Date(Date.now() + 600_000).toISOString() }
    cache.set(1, token1)
    cache.set(2, token2)

    expect(cache.get(1)?.token).toBe("ghs_1")
    expect(cache.get(2)?.token).toBe("ghs_2")
  })
})

describe("GitHub App REST client", () => {
  test("GitHubClient creates issue comments with installation token", () => {
    const issueComment = GitHubAppAuth.GitHubClient.createIssueComment({
      owner: "owner",
      repo: "repo",
      issueNumber: 42,
      body: "Investigating...",
      installationToken: "ghs_test_token",
    })

    expect(issueComment.url).toBe("https://api.github.com/repos/owner/repo/issues/42/comments")
    expect(issueComment.method).toBe("POST")
    expect(issueComment.headers).toMatchObject({
      Authorization: "Bearer ghs_test_token",
      Accept: "application/vnd.github+json",
    })
    expect(JSON.parse(issueComment.body as string)).toEqual({ body: "Investigating..." })
  })

  test("GitHubClient creates a PR from head to base", () => {
    const pr = GitHubAppAuth.GitHubClient.createPullRequest({
      owner: "owner",
      repo: "repo",
      head: "synergy/fix/issue-42",
      base: "main",
      title: "Fix: Crash in settings",
      body: "Closes #42\n\nAdded null guard.",
      installationToken: "ghs_test_token",
    })

    expect(pr.url).toBe("https://api.github.com/repos/owner/repo/pulls")
    expect(pr.method).toBe("POST")
    expect(JSON.parse(pr.body as string)).toMatchObject({
      head: "synergy/fix/issue-42",
      base: "main",
      body: "Closes #42\n\nAdded null guard.",
    })
  })

  test("GitHubClient creates a COMMENT PR review on a specific SHA", () => {
    const review = GitHubAppAuth.GitHubClient.createPullRequestReview({
      owner: "owner",
      repo: "repo",
      pullNumber: 5,
      commitId: "abc123",
      body: "Defect-first review findings.",
      event: "COMMENT",
      installationToken: "ghs_test_token",
    })

    expect(review.url).toBe("https://api.github.com/repos/owner/repo/pulls/5/reviews")
    expect(review.method).toBe("POST")
    expect(JSON.parse(review.body as string)).toMatchObject({
      commit_id: "abc123",
      body: "Defect-first review findings.",
      event: "COMMENT",
    })
  })

  test("GitHubClient creates a completed check run", () => {
    const checkRun = GitHubAppAuth.GitHubClient.createCheckRun({
      owner: "owner",
      repo: "repo",
      name: "Synergy Review",
      headSha: "abc123",
      conclusion: "failure",
      output: {
        title: "1 defect found",
        summary: "High: Unhandled rejection in src/app.ts",
      },
      installationToken: "ghs_test_token",
    })

    expect(checkRun.url).toBe("https://api.github.com/repos/owner/repo/check-runs")
    expect(checkRun.method).toBe("POST")
    expect(JSON.parse(checkRun.body as string)).toMatchObject({
      name: "Synergy Review",
      head_sha: "abc123",
      conclusion: "failure",
      output: {
        title: "1 defect found",
        summary: "High: Unhandled rejection in src/app.ts",
      },
    })
  })

  test("GitHubClient rejects requests without installation token", () => {
    expect(() =>
      GitHubAppAuth.GitHubClient.createIssueComment({
        owner: "owner",
        repo: "repo",
        issueNumber: 1,
        body: "test",
        installationToken: "",
      }),
    ).toThrow()
  })

  test("GitHubClient includes appropriate User-Agent header", () => {
    const req = GitHubAppAuth.GitHubClient.createIssueComment({
      owner: "o",
      repo: "r",
      issueNumber: 1,
      body: "t",
      installationToken: "ghs_tok",
    })

    expect(req.headers["User-Agent"]).toMatch(/^synergy-github-app/)
  })
})
