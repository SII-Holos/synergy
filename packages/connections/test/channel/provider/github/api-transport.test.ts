import { expect, spyOn, test } from "bun:test"
import { generateKeyPairSync } from "node:crypto"
import { GitHubApiError, GitHubChannelAuth } from "../../../../src/channel/provider/github/api"

test("GitHub auth negotiates and caches credentials, preserves response headers and exposes retryable failures", async () => {
  const originalApp = process.env.SYNERGY_GITHUB_APP_ID
  const originalKey = process.env.SYNERGY_GITHUB_APP_PRIVATE_KEY
  process.env.SYNERGY_GITHUB_APP_ID = "123"
  process.env.SYNERGY_GITHUB_APP_PRIVATE_KEY = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
    publicKeyEncoding: { type: "pkcs1", format: "pem" },
  }).privateKey
  const requests: { path: string; method: string; authorization: string | null }[] = []
  let invalid = false
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname
      requests.push({ path, method: request.method, authorization: request.headers.get("authorization") })
      if (path === "/app") return Response.json({ slug: invalid ? " " : " fixture-bot " })
      if (path.endsWith("access_tokens"))
        return Response.json(
          invalid ? {} : { token: "fixture-token", expires_at: new Date(Date.now() + 3_600_000).toISOString() },
        )
      if (path === "/limited") return new Response("slow down", { status: 429, headers: { "retry-after": "2" } })
      if (path === "/empty") return new Response(null, { status: 204 })
      return Response.json([{ id: 1 }], { headers: { link: '<https://api.github.com/page2>; rel="next"' } })
    },
  })
  const originalFetch = globalThis.fetch
  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(((input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url)
    if (url.hostname !== "api.github.com") throw new Error(`Unexpected network destination: ${url.hostname}`)
    return originalFetch(new URL(url.pathname + url.search, server.url), init)
  }) as typeof fetch)
  GitHubChannelAuth.reset()
  try {
    expect(await GitHubChannelAuth.getAppSlug()).toBe("fixture-bot")
    expect(await GitHubChannelAuth.getAppSlug()).toBe("fixture-bot")
    expect(await GitHubChannelAuth.getInstallationToken(7)).toBe("fixture-token")
    expect(await GitHubChannelAuth.getInstallationToken(7)).toBe("fixture-token")
    expect(requests).toHaveLength(2)
    expect(requests[0]!.authorization).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/)
    expect(requests[1]).toMatchObject({ path: "/app/installations/7/access_tokens", method: "POST" })
    const descriptor = GitHubChannelAuth.GitHubClient.getRepository({
      owner: "owner",
      repo: "repo",
      installationToken: "fixture-token",
    })
    const page = await GitHubChannelAuth.GitHubClient.sendPage<{ id: number }[]>(descriptor)
    expect(page.data).toEqual([{ id: 1 }])
    expect(page.headers.get("link")).toContain('rel="next"')
    const empty = { ...descriptor, url: "https://api.github.com/empty" }
    expect(await GitHubChannelAuth.GitHubClient.send(empty)).toBeUndefined()
    const limited = { ...descriptor, url: "https://api.github.com/limited" }
    const failure = await GitHubChannelAuth.GitHubClient.send(limited).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(GitHubApiError)
    expect(failure).toMatchObject({ status: 429, method: "GET", path: "/limited", retryAfterMs: 2000 })
    GitHubChannelAuth.reset()
    invalid = true
    await expect(GitHubChannelAuth.getAppSlug()).rejects.toThrow("no valid slug")
    await expect(GitHubChannelAuth.getInstallationToken(8)).rejects.toThrow("response is invalid")
  } finally {
    fetchSpy.mockRestore()
    GitHubChannelAuth.reset()
    server.stop(true)
    if (originalApp === undefined) delete process.env.SYNERGY_GITHUB_APP_ID
    else process.env.SYNERGY_GITHUB_APP_ID = originalApp
    if (originalKey === undefined) delete process.env.SYNERGY_GITHUB_APP_PRIVATE_KEY
    else process.env.SYNERGY_GITHUB_APP_PRIVATE_KEY = originalKey
  }
})
