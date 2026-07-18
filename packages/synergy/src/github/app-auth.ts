import { createSign } from "node:crypto"

const GITHUB_API_VERSION = "2022-11-28"
const TOKEN_REFRESH_WINDOW_MS = 5 * 60 * 1_000
const REQUEST_TIMEOUT_MS = 30_000
const USER_AGENT = "synergy-github-app/1.0"

type InstallationToken = {
  token: string
  expiresAt: string
}

export type RequestDescriptor = {
  url: string
  method: "GET" | "POST"
  headers: Record<string, string>
  body?: string
}

export class GitHubApiError extends Error {
  readonly retryAfterMs: number | undefined

  constructor(
    readonly status: number,
    readonly method: string,
    readonly path: string,
    response: string,
    headers?: Headers,
  ) {
    super(`GitHub API ${method} ${path} failed (${status}): ${response}`)
    this.name = "GitHubApiError"
    const retryAfterHeader = headers?.get("retry-after")
    const resetHeader = headers?.get("x-ratelimit-reset")
    const retryAfterSeconds = retryAfterHeader ? Number(retryAfterHeader) : Number.NaN
    const resetDelay = resetHeader ? Number(resetHeader) * 1_000 - Date.now() : Number.NaN
    this.retryAfterMs = Number.isFinite(retryAfterSeconds)
      ? Math.max(0, retryAfterSeconds * 1_000)
      : Number.isFinite(resetDelay)
        ? Math.max(0, resetDelay)
        : undefined
  }
}

function requireNonEmpty(value: string, name: string) {
  if (!value.trim()) throw new Error(`${name} is required`)
  return value
}

function request(input: {
  path: string
  method?: RequestDescriptor["method"]
  installationToken: string
  body?: unknown
}): RequestDescriptor {
  const token = requireNonEmpty(input.installationToken, "GitHub installation token")
  return {
    url: `https://api.github.com${input.path}`,
    method: input.method ?? "GET",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": GITHUB_API_VERSION,
      "User-Agent": USER_AGENT,
      ...(input.body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
  }
}

function appRequest(input: {
  path: string
  method?: RequestDescriptor["method"]
  jwt: string
  body?: unknown
}): RequestDescriptor {
  const jwt = requireNonEmpty(input.jwt, "GitHub App JWT")
  return {
    url: `https://api.github.com${input.path}`,
    method: input.method ?? "GET",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${jwt}`,
      "X-GitHub-Api-Version": GITHUB_API_VERSION,
      "User-Agent": USER_AGENT,
      ...(input.body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
  }
}

async function executeResponse(descriptor: RequestDescriptor, signal?: AbortSignal) {
  const response = await fetch(descriptor.url, {
    method: descriptor.method,
    headers: descriptor.headers,
    body: descriptor.body,
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)])
      : AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  const text = await response.text()
  if (!response.ok) {
    throw new GitHubApiError(
      response.status,
      descriptor.method,
      new URL(descriptor.url).pathname,
      text,
      response.headers,
    )
  }
  return { data: text ? (JSON.parse(text) as unknown) : undefined, headers: response.headers }
}

async function execute<T>(descriptor: RequestDescriptor, signal?: AbortSignal): Promise<T> {
  return (await executeResponse(descriptor, signal)).data as T
}

function encodeJson(value: unknown) {
  return Buffer.from(JSON.stringify(value)).toString("base64url")
}

export namespace GitHubAppAuth {
  export function generateJWT(input: { appId: number; privateKey: string }) {
    if (!Number.isInteger(input.appId) || input.appId <= 0) throw new Error("GitHub App ID must be a positive integer")
    const privateKey = requireNonEmpty(input.privateKey, "GitHub App private key")
    const now = Math.floor(Date.now() / 1_000)
    const header = encodeJson({ alg: "RS256", typ: "JWT" })
    const payload = encodeJson({ iat: now - 60, exp: now + 9 * 60, iss: input.appId })
    const signingInput = `${header}.${payload}`
    const signature = createSign("RSA-SHA256").update(signingInput).end().sign(privateKey).toString("base64url")
    return `${signingInput}.${signature}`
  }

  export class TokenCache {
    private values = new Map<number, InstallationToken>()

    get(installationId: number): InstallationToken | undefined {
      const cached = this.values.get(installationId)
      if (!cached) return
      const expiresAt = Date.parse(cached.expiresAt)
      if (!Number.isFinite(expiresAt) || expiresAt - Date.now() <= TOKEN_REFRESH_WINDOW_MS) {
        this.values.delete(installationId)
        return
      }
      return cached
    }

    set(installationId: number, token: InstallationToken) {
      if (!Number.isInteger(installationId) || installationId <= 0) {
        throw new Error("GitHub installation ID must be a positive integer")
      }
      requireNonEmpty(token.token, "GitHub installation token")
      if (!Number.isFinite(Date.parse(token.expiresAt))) throw new Error("GitHub installation token expiry is invalid")
      this.values.set(installationId, token)
    }

    clear() {
      this.values.clear()
    }
  }

  const installationTokens = new TokenCache()

  export function reset() {
    installationTokens.clear()
  }

  export async function getInstallationToken(installationId: number, signal?: AbortSignal): Promise<string> {
    const cached = installationTokens.get(installationId)
    if (cached) return cached.token

    const appId = Number(process.env.SYNERGY_GITHUB_APP_ID)
    const privateKey = process.env.SYNERGY_GITHUB_APP_PRIVATE_KEY?.replaceAll("\\n", "\n") ?? ""
    const jwt = generateJWT({ appId, privateKey })
    const descriptor = appRequest({ path: `/app/installations/${installationId}/access_tokens`, method: "POST", jwt })
    const response = await execute<{ token?: unknown; expires_at?: unknown }>(descriptor, signal)
    if (typeof response.token !== "string" || typeof response.expires_at !== "string") {
      throw new Error("GitHub installation token response is invalid")
    }
    const token = { token: response.token, expiresAt: response.expires_at }
    installationTokens.set(installationId, token)
    return token.token
  }

  export namespace GitHubClient {
    export function resolveInstallation(input: { owner: string; repo: string; jwt: string }) {
      return appRequest({ path: `/repos/${input.owner}/${input.repo}/installation`, jwt: input.jwt })
    }

    export function listRepositoryIssues(input: {
      owner: string
      repo: string
      since: string
      pageSize: number
      installationToken: string
    }) {
      const query = new URLSearchParams({
        filter: "all",
        state: "all",
        since: input.since,
        sort: "updated",
        direction: "asc",
        per_page: String(input.pageSize),
      })
      return request({
        path: `/repos/${input.owner}/${input.repo}/issues?${query.toString()}`,
        installationToken: input.installationToken,
      })
    }

    export function followPagination(input: { url: string; installationToken: string }) {
      const url = new URL(input.url)
      if (url.protocol !== "https:" || url.origin !== "https://api.github.com") {
        throw new Error("GitHub pagination URL must use the api.github.com HTTPS origin")
      }
      const token = requireNonEmpty(input.installationToken, "GitHub installation token")
      return {
        url: url.toString(),
        method: "GET" as const,
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "X-GitHub-Api-Version": GITHUB_API_VERSION,
          "User-Agent": USER_AGENT,
        },
      }
    }

    export function listWorkflowRuns(input: {
      owner: string
      repo: string
      since?: string
      pageSize: number
      installationToken: string
    }) {
      const query = new URLSearchParams()
      if (input.since) query.set("created", `>=${input.since}`)
      query.set("per_page", String(input.pageSize))
      return request({
        path: `/repos/${input.owner}/${input.repo}/actions/runs?${query.toString()}`,
        installationToken: input.installationToken,
      })
    }

    export function getWorkflowRun(input: { owner: string; repo: string; runId: number; installationToken: string }) {
      return request({
        path: `/repos/${input.owner}/${input.repo}/actions/runs/${input.runId}`,
        installationToken: input.installationToken,
      })
    }
    export function createIssueComment(input: {
      owner: string
      repo: string
      issueNumber: number
      body: string
      installationToken: string
    }) {
      return request({
        path: `/repos/${input.owner}/${input.repo}/issues/${input.issueNumber}/comments`,
        method: "POST",
        installationToken: input.installationToken,
        body: { body: input.body },
      })
    }

    export function listIssueComments(input: {
      owner: string
      repo: string
      issueNumber: number
      installationToken: string
    }) {
      return request({
        path: `/repos/${input.owner}/${input.repo}/issues/${input.issueNumber}/comments?per_page=100`,
        installationToken: input.installationToken,
      })
    }

    export function createPullRequest(input: {
      owner: string
      repo: string
      head: string
      base: string
      title: string
      body: string
      installationToken: string
    }) {
      return request({
        path: `/repos/${input.owner}/${input.repo}/pulls`,
        method: "POST",
        installationToken: input.installationToken,
        body: { title: input.title, head: input.head, base: input.base, body: input.body },
      })
    }

    export function listPullRequestsForHead(input: {
      owner: string
      repo: string
      head: string
      installationToken: string
    }) {
      const query = new URLSearchParams({ state: "all", head: input.head, per_page: "100" })
      return request({
        path: `/repos/${input.owner}/${input.repo}/pulls?${query.toString()}`,
        installationToken: input.installationToken,
      })
    }

    export function createPullRequestReview(input: {
      owner: string
      repo: string
      pullNumber: number
      commitId: string
      body: string
      event: "COMMENT"
      installationToken: string
    }) {
      return request({
        path: `/repos/${input.owner}/${input.repo}/pulls/${input.pullNumber}/reviews`,
        method: "POST",
        installationToken: input.installationToken,
        body: { commit_id: input.commitId, body: input.body, event: input.event },
      })
    }

    export function listPullRequestReviews(input: {
      owner: string
      repo: string
      pullNumber: number
      installationToken: string
    }) {
      return request({
        path: `/repos/${input.owner}/${input.repo}/pulls/${input.pullNumber}/reviews?per_page=100`,
        installationToken: input.installationToken,
      })
    }

    export function createCheckRun(input: {
      owner: string
      repo: string
      name: string
      headSha: string
      externalId?: string
      conclusion: "success" | "failure" | "neutral" | "cancelled" | "skipped" | "timed_out" | "action_required"
      output: { title: string; summary: string; text?: string }
      installationToken: string
    }) {
      return request({
        path: `/repos/${input.owner}/${input.repo}/check-runs`,
        method: "POST",
        installationToken: input.installationToken,
        body: {
          name: input.name,
          ...(input.externalId ? { external_id: input.externalId } : {}),
          head_sha: input.headSha,
          status: "completed",
          conclusion: input.conclusion,
          output: input.output,
        },
      })
    }

    export function listCheckRunsForRef(input: {
      owner: string
      repo: string
      ref: string
      installationToken: string
    }) {
      return request({
        path: `/repos/${input.owner}/${input.repo}/commits/${encodeURIComponent(input.ref)}/check-runs?per_page=100`,
        installationToken: input.installationToken,
      })
    }

    export function getPullRequest(input: {
      owner: string
      repo: string
      pullNumber: number
      installationToken: string
    }) {
      return request({
        path: `/repos/${input.owner}/${input.repo}/pulls/${input.pullNumber}`,
        installationToken: input.installationToken,
      })
    }

    export function getBranch(input: { owner: string; repo: string; branch: string; installationToken: string }) {
      return request({
        path: `/repos/${input.owner}/${input.repo}/branches/${encodeURIComponent(input.branch)}`,
        installationToken: input.installationToken,
      })
    }

    export function getRepository(input: { owner: string; repo: string; installationToken: string }) {
      return request({
        path: `/repos/${input.owner}/${input.repo}`,
        installationToken: input.installationToken,
      })
    }

    export async function send<T>(descriptor: RequestDescriptor, signal?: AbortSignal) {
      return execute<T>(descriptor, signal)
    }
    export async function sendPage<T>(descriptor: RequestDescriptor, signal?: AbortSignal) {
      const response = await executeResponse(descriptor, signal)
      return { data: response.data as T, headers: response.headers }
    }
  }

  const credentialHelper =
    '!f() { test "$1" = get && printf "username=x-access-token\\npassword=%s\\n" "$SYNERGY_GITHUB_INSTALLATION_TOKEN"; }; f'

  export function buildCredentialCommand(input: { token: string; args: string[] }) {
    requireNonEmpty(input.token, "GitHub installation token")
    return {
      env: { SYNERGY_GITHUB_INSTALLATION_TOKEN: input.token },
      args: ["-c", `credential.helper=${credentialHelper}`, ...input.args],
    }
  }

  export function buildFixBranchName(input: { prefix: string; issueNumber: number; slug: string }) {
    if (!Number.isInteger(input.issueNumber) || input.issueNumber <= 0) throw new Error("Issue number must be positive")
    const prefix = requireNonEmpty(input.prefix, "Fix branch prefix")
    if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*\/$/.test(prefix) || prefix.includes("..") || prefix.includes("//")) {
      throw new Error("Fix branch prefix is invalid")
    }
    const slug = input.slug
      .normalize("NFKD")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60)
    return `${prefix}issue-${input.issueNumber}${slug ? `-${slug}` : ""}`
  }
}
