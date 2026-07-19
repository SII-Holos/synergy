import { describe, expect, test } from "bun:test"
import { GitHubAppAuth } from "../../src/github/app-auth"

describe("GitHub App polling client — installation resolution", () => {
  test("builds a request descriptor to resolve installation for a repository", () => {
    const req = GitHubAppAuth.GitHubClient.resolveInstallation({
      owner: "owner",
      repo: "repo",
      jwt: "eyJhbGciOiJSUzI1NiJ9.eyJpc3MiOjEyMzQ1fQ.signature",
    })

    expect(req.url).toBe("https://api.github.com/repos/owner/repo/installation")
    expect(req.method).toBe("GET")
    expect(req.headers.Authorization).toBe("Bearer eyJhbGciOiJSUzI1NiJ9.eyJpc3MiOjEyMzQ1fQ.signature")
    expect(req.headers.Accept).toBe("application/vnd.github+json")
  })

  test("rejects resolveInstallation without jwt", () => {
    expect(() =>
      GitHubAppAuth.GitHubClient.resolveInstallation({
        owner: "owner",
        repo: "repo",
        jwt: "",
      }),
    ).toThrow()
  })
})

describe("GitHub App polling client — issues endpoint", () => {
  test("builds a GET request for incremental issues with since and pagination", () => {
    const req = GitHubAppAuth.GitHubClient.listRepositoryIssues({
      owner: "owner",
      repo: "repo",
      since: "2025-01-01T00:00:00Z",
      pageSize: 100,
      installationToken: "ghs_test_token",
    })

    expect(req.url).toBe(
      "https://api.github.com/repos/owner/repo/issues?filter=all&state=all&since=2025-01-01T00%3A00%3A00Z&sort=updated&direction=asc&per_page=100",
    )
    expect(req.method).toBe("GET")
    expect(req.headers.Authorization).toBe("Bearer ghs_test_token")
    expect(req.headers.Accept).toBe("application/vnd.github+json")
  })

  test("builds a GET request to follow a same-origin Link rel=next", () => {
    const nextUrl = "https://api.github.com/repositories/123/issues?per_page=100&page=2"
    const req = GitHubAppAuth.GitHubClient.followPagination({
      url: nextUrl,
      installationToken: "ghs_test_token",
    })

    expect(req.url).toBe(nextUrl)
    expect(req.method).toBe("GET")
    expect(req.headers.Authorization).toBe("Bearer ghs_test_token")
  })

  test("rejects followPagination with a cross-origin URL", () => {
    expect(() =>
      GitHubAppAuth.GitHubClient.followPagination({
        url: "https://evil.example.com/repos/owner/repo/issues",
        installationToken: "ghs_test_token",
      }),
    ).toThrow()
  })

  test("followPagination rejects non-HTTPS URLs", () => {
    expect(() =>
      GitHubAppAuth.GitHubClient.followPagination({
        url: "http://api.github.com/repos/owner/repo/issues?page=2",
        installationToken: "ghs_test_token",
      }),
    ).toThrow()
  })

  test("listRepositoryIssues rejects without installation token", () => {
    expect(() =>
      GitHubAppAuth.GitHubClient.listRepositoryIssues({
        owner: "owner",
        repo: "repo",
        since: "2025-01-01T00:00:00Z",
        pageSize: 100,
        installationToken: "",
      }),
    ).toThrow()
  })
})

describe("GitHub App polling client — pull request fetch", () => {
  test("builds a GET request for full PR detail by number", () => {
    const req = GitHubAppAuth.GitHubClient.getPullRequest({
      owner: "owner",
      repo: "repo",
      pullNumber: 7,
      installationToken: "ghs_test_token",
    })

    expect(req.url).toBe("https://api.github.com/repos/owner/repo/pulls/7")
    expect(req.method).toBe("GET")
  })
})

describe("GitHub App polling client — workflow runs", () => {
  test("builds a GET request for workflow runs with since", () => {
    const req = GitHubAppAuth.GitHubClient.listWorkflowRuns({
      owner: "owner",
      repo: "repo",
      since: "2025-01-01T00:00:00Z",
      pageSize: 50,
      installationToken: "ghs_test_token",
    })

    expect(req.url).toBe(
      "https://api.github.com/repos/owner/repo/actions/runs?created=%3E%3D2025-01-01T00%3A00%3A00Z&per_page=50",
    )
    expect(req.method).toBe("GET")
    expect(req.headers.Authorization).toBe("Bearer ghs_test_token")
  })
})
