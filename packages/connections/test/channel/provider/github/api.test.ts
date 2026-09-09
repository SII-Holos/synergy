import { describe, expect, test } from "bun:test"
import { generateKeyPairSync } from "node:crypto"
import { GitHubChannelAuth, buildCredentialCommand } from "../../../../src/channel/provider/github/api"

function testPrivateKey(): string {
  // Deterministic RSA-2048 key pair generated at test runtime; OpenSSL rejects
  // hard-coded placeholder PEM, so generate a real one.
  return generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
    publicKeyEncoding: { type: "pkcs1", format: "pem" },
  }).privateKey
}

describe("github channel auth — JWT", () => {
  test("generates a three-part RS256 JWT", () => {
    const jwt = GitHubChannelAuth.generateJWT({ appId: 123, privateKey: testPrivateKey() })
    const parts = jwt.split(".")
    expect(parts).toHaveLength(3)
    const header = JSON.parse(Buffer.from(parts[0]!, "base64url").toString())
    expect(header).toMatchObject({ alg: "RS256", typ: "JWT" })
    const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString())
    expect(payload.iss).toBe(123)
    expect(payload.exp - payload.iat).toBe(600)
  })

  test("rejects a non-positive app ID", () => {
    expect(() => GitHubChannelAuth.generateJWT({ appId: 0, privateKey: testPrivateKey() })).toThrow()
  })

  test("rejects an empty private key", () => {
    expect(() => GitHubChannelAuth.generateJWT({ appId: 1, privateKey: "" })).toThrow()
  })
})

describe("github channel auth — installation token cache", () => {
  test("caches and returns a token before the refresh window", () => {
    const cache = new GitHubChannelAuth.TokenCache()
    cache.set(42, { token: "tok-1", expiresAt: new Date(Date.now() + 10 * 60 * 1_000).toISOString() })
    expect(cache.get(42)?.token).toBe("tok-1")
  })

  test("evicts tokens inside the refresh window", () => {
    const cache = new GitHubChannelAuth.TokenCache()
    cache.set(42, { token: "tok-1", expiresAt: new Date(Date.now() + 60_000).toISOString() })
    expect(cache.get(42)).toBeUndefined()
  })

  test("clears all tokens", () => {
    const cache = new GitHubChannelAuth.TokenCache()
    cache.set(1, { token: "a", expiresAt: new Date(Date.now() + 10 * 60 * 1_000).toISOString() })
    cache.set(2, { token: "b", expiresAt: new Date(Date.now() + 10 * 60 * 1_000).toISOString() })
    cache.clear()
    expect(cache.get(1)).toBeUndefined()
    expect(cache.get(2)).toBeUndefined()
  })
})

describe("github channel auth — request descriptors", () => {
  test("builds a comment creation request", () => {
    const descriptor = GitHubChannelAuth.GitHubClient.createIssueComment({
      owner: "owner",
      repo: "repo",
      issueNumber: 7,
      body: "hello",
      installationToken: "tok",
    })
    expect(descriptor.method).toBe("POST")
    expect(descriptor.url).toBe("https://api.github.com/repos/owner/repo/issues/7/comments")
    expect(descriptor.headers["Authorization"]).toBe("Bearer tok")
    expect(JSON.parse(descriptor.body!)).toEqual({ body: "hello" })
  })

  test("builds a reaction creation request", () => {
    const descriptor = GitHubChannelAuth.GitHubClient.createIssueCommentReaction({
      owner: "owner",
      repo: "repo",
      commentId: 123,
      content: "eyes",
      installationToken: "tok",
    })
    expect(descriptor.url).toBe("https://api.github.com/repos/owner/repo/issues/comments/123/reactions")
    expect(JSON.parse(descriptor.body!)).toEqual({ content: "eyes" })
  })

  test("builds a PR detail request", () => {
    const descriptor = GitHubChannelAuth.GitHubClient.getPullRequest({
      owner: "owner",
      repo: "repo",
      pullNumber: 9,
      installationToken: "tok",
    })
    expect(descriptor.method).toBe("GET")
    expect(descriptor.url).toBe("https://api.github.com/repos/owner/repo/pulls/9")
  })

  test("builds the git credential helper command with the process environment preserved", () => {
    const command = buildCredentialCommand({ token: "secret-token", args: ["clone", "x"] })
    // Bun's shell .env() replaces the child environment, so the helper must
    // carry the parent environment through (HOME, PATH, proxies) and overlay
    // the installation token.
    expect(command.env).toEqual({ ...process.env, SYNERGY_GITHUB_INSTALLATION_TOKEN: "secret-token" })
    expect(command.env.SYNERGY_GITHUB_INSTALLATION_TOKEN).toBe("secret-token")
    expect(command.env.HOME).toBe(process.env.HOME)
    expect(command.args[0]).toBe("-c")
    expect(command.args[1]).toContain("credential.helper=")
    // The token must never appear on the argv.
    expect(command.args.join(" ")).not.toContain("secret-token")
  })
})
