import { afterAll, expect, spyOn, test } from "bun:test"
import { generateKeyPairSync } from "node:crypto"
import { WorkspaceAccess } from "@ericsanchezok/synergy-harness/workspace/access"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { StoragePath } from "@ericsanchezok/synergy-harness/storage/path"
import { externalIdentityHash } from "@ericsanchezok/synergy-harness/util/identity"
import { ChannelHost } from "../../../../src/channel/host"
import { GitHubChannelAuth } from "../../../../src/channel/provider/github/api"
import { pollRepository } from "../../../../src/channel/provider/github/poll"
import { initializeBaseline } from "../../../../src/channel/provider/github/synthesizer"
import { testRuntime } from "../../../support/runtime"

const privateKey = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "pkcs1", format: "pem" },
}).privateKey
const runtime = await testRuntime({ env: { SYNERGY_GITHUB_APP_ID: "123", SYNERGY_GITHUB_APP_PRIVATE_KEY: privateKey } })
afterAll(() => runtime.close())

test.each(["first", "established"] as const)(
  "GitHub polling retains unaccepted events after a busy checkout (%s)",
  (kind) =>
    runtime.run(async () => {
      const accountId = crypto.randomUUID()
      const accountHash = externalIdentityHash(accountId)
      const repository = "fixture/project"
      const key = StoragePath.githubChannelPollState(accountHash, repository)
      const baseline = kind === "first" ? undefined : initializeBaseline(repository)
      if (baseline) await Storage.write(key, baseline)
      const paths: string[] = []
      const created = new Date(Date.now() - 3_600_000).toISOString()
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch(request) {
          const url = new URL(request.url)
          paths.push(url.pathname + url.search)
          if (url.pathname.endsWith("/installation")) return Response.json({ id: 701 })
          if (url.pathname.endsWith("/access_tokens"))
            return Response.json({ token: "fixture-token", expires_at: new Date(Date.now() + 3_600_000).toISOString() })
          if (url.pathname.endsWith("/comments"))
            return Response.json(
              [1, 2].map((id) => ({
                id,
                body: "@fixture-bot help",
                user: { login: "fixture-user", type: "User" },
                created_at: created,
              })),
            )
          return Response.json([
            {
              id: 11,
              number: 1,
              title: "Fixture",
              user: { login: "fixture-user" },
              created_at: created,
              updated_at: new Date().toISOString(),
            },
          ])
        },
      })
      const originalFetch = globalThis.fetch
      const transport = spyOn(globalThis, "fetch").mockImplementation(((input, init) => {
        const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url)
        if (url.hostname !== "api.github.com") throw new Error(`Unexpected network destination: ${url.hostname}`)
        return originalFetch(new URL(url.pathname + url.search, server.url), init)
      }) as typeof fetch)
      let busy = true
      const attempts: string[] = []
      const accepted = new Set<string>()
      const host = ChannelHost.create({
        channelType: "github",
        accountId,
        async onConversationMessage(message) {
          attempts.push(message.messageId)
          if (busy && attempts.length === 2) throw new WorkspaceAccess.BusyError("Fixture checkout is busy")
          accepted.add(message.messageId)
          return { accepted: true, execution: Promise.resolve() }
        },
      })
      const input = {
        accountId,
        accountHash,
        repository,
        intervalMs: 300_000,
        pageSize: 30,
        maxPages: 2,
        autoReview: false,
        autoRespond: true,
        mention: "fixture-bot",
        signal: new AbortController().signal,
        host,
      }
      GitHubChannelAuth.reset()
      try {
        await expect(pollRepository(input)).rejects.toThrow("Fixture checkout is busy")
        const retained = await Storage.read(key).catch((error) => {
          if (error instanceof Storage.NotFoundError) return undefined
          throw error
        })
        expect(retained).toEqual(baseline)
        busy = false
        await pollRepository(input)
        expect(attempts.slice(2)).toEqual(attempts.slice(0, 2))
        expect(accepted.size).toBe(2)
        const settled = attempts.length
        await pollRepository(input)
        expect(attempts.length).toBe(settled)
        if (kind === "first") {
          const reads = paths.filter((value) => value.startsWith("/repos/fixture/project/issues?"))
          const first = new URL(reads[0], server.url).searchParams.get("since")!
          const retry = new URL(reads[1], server.url).searchParams.get("since")!
          expect(Date.parse(retry) - Date.parse(first)).toBeLessThan(60_000)
        }
      } finally {
        transport.mockRestore()
        GitHubChannelAuth.reset()
        server.stop(true)
      }
    }),
)
