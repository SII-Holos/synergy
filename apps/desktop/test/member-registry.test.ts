import { afterAll, beforeAll, expect, test } from "bun:test"
import { createHash, randomBytes } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { DesktopOrganizationAccounts } from "../src/organization/accounts"
import { DesktopMemberRuntimes } from "../src/organization/member-runtimes"
import { organizationFixture } from "./fixture/organization"

let resourcesPath: string
beforeAll(async () => {
  resourcesPath = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-member-registry-assets-"))
  const output = path.join(resourcesPath, "synergy/bin", process.platform === "win32" ? "synergy.exe" : "synergy")
  await fs.mkdir(path.dirname(output), { recursive: true })
  const build = await Bun.build({
    entrypoints: [path.join(import.meta.dir, "fixture/member-server.ts")],
    compile: { outfile: output, autoloadBunfig: false, autoloadDotenv: false },
  })
  if (!build.success) throw new AggregateError(build.logs, "Member registry fixture build failed")
}, 20_000)
afterAll(async () => {
  if (resourcesPath) await fs.rm(resourcesPath, { recursive: true, force: true })
})

async function authorized(f: Awaited<ReturnType<typeof organizationFixture>>, accounts = f.accounts) {
  const verifier = randomBytes(32).toString("base64url")
  const { issuer, orgID, deploymentIncarnation } = f.info
  const input = {
    issuer,
    orgID,
    deploymentIncarnation,
    clientID: "desktop",
    redirectUri: "synergy://organization-auth/callback",
  }
  const code = await f.consent({
    ...input,
    state: randomBytes(32).toString("base64url"),
    codeChallengeMethod: "S256",
    codeChallenge: createHash("sha256").update(verifier).digest("base64url"),
  })
  const grant = await f.api.orgAuth.exchange(
    { orgCodeExchangeInput: { ...input, code: code.code, verifier } },
    { throwOnError: true },
  )
  return accounts.accept(grant.data)
}

function registry(
  root: string,
  accounts: DesktopOrganizationAccounts,
  fetch: typeof globalThis.fetch,
  services?: ConstructorParameters<typeof DesktopMemberRuntimes>[0]["services"],
) {
  const previous = process.env.SYNERGY_TEST_HOME
  process.env.SYNERGY_TEST_HOME = root
  const options = {
    root: path.join(root, "members"),
    accounts,
    fetch,
    server: { channel: "dev" as const, resourcesPath },
    services,
  }
  const owners: DesktopMemberRuntimes[] = []
  const create = () => {
    const result = new DesktopMemberRuntimes(options)
    owners.push(result)
    return result
  }
  return {
    root: options.root,
    owner: create(),
    restart: create,
    async [Symbol.asyncDispose]() {
      try {
        await Promise.all(owners.map((owner) => owner.close()))
      } finally {
        if (previous === undefined) delete process.env.SYNERGY_TEST_HOME
        else process.env.SYNERGY_TEST_HOME = previous
      }
    },
  }
}

test("member native services receive private connections once and drain before shutdown completes", async () => {
  await using service = await organizationFixture()
  const account = await authorized(service)
  const opened: Array<Parameters<NonNullable<ConstructorParameters<typeof DesktopMemberRuntimes>[0]["services"]>>[0]> =
    []
  let release!: () => void
  let wait = Promise.resolve()
  let closed = 0
  await using f = registry(service.root, service.accounts, service.transport, (member) => {
    opened.push(member)
    return {
      async close() {
        await wait
        closed++
      },
    }
  })
  expect((await f.owner.status(account.id)).state).toBe("stopped")
  expect(opened).toHaveLength(0)
  const [first, duplicate] = await Promise.all([f.owner.start(account.id), f.owner.start(account.id)])
  expect(first).toEqual(duplicate)
  expect(opened).toHaveLength(1)
  const original = opened[0]
  expect(original).toMatchObject({ connectionID: account.id, runtimeID: first.runtimeID })
  expect(
    (
      await fetch(original.browser.url + "/native", {
        headers: { ...original.browser.headers, "x-fixture-browser-token": original.browser.token },
      })
    ).status,
  ).toBe(200)
  expect(JSON.stringify(first)).not.toContain(original.browser.token)
  wait = new Promise<void>((resolve) => {
    release = resolve
  })
  let stopped = false
  const stopping = f.owner.stopAll().then(() => {
    stopped = true
  })
  try {
    await Bun.sleep(15)
    expect(stopped).toBe(false)
  } finally {
    release()
    await stopping
  }
  expect(closed).toBe(1)
  expect(f.owner.running()).toEqual([])
  await f.owner.start(account.id)
  expect(opened).toHaveLength(2)
  expect(opened[1].browser.token).not.toBe(original.browser.token)
  await f.owner.close()
  expect(closed).toBe(2)
}, 20_000)

test("failed or cancelled native attachment releases its member child and late-created services", async () => {
  await using service = await organizationFixture()
  const account = await authorized(service)
  const cancellation = new AbortController()
  let attempts = 0,
    closed = 0
  await using f = registry(service.root, service.accounts, service.transport, () => {
    attempts++
    if (attempts === 1) throw new Error("Native attachment unavailable")
    if (attempts === 2) cancellation.abort()
    return {
      async close() {
        closed++
      },
    }
  })
  await expect(f.owner.start(account.id)).rejects.toThrow("Native attachment unavailable")
  expect(f.owner.running()).toEqual([])
  await expect(f.owner.start(account.id, cancellation.signal)).rejects.toMatchObject({ code: "cancelled" })
  await f.owner.stopAll()
  expect(closed).toBe(1)
  expect(f.owner.running()).toEqual([])
  expect((await f.owner.start(account.id)).state).toBe("running")
  await f.owner.close()
  expect(closed).toBe(2)
}, 20_000)

test("the main registry lazily provisions independent members and deduplicates actual child starts", async () => {
  await using a = await organizationFixture()
  await using b = await organizationFixture()
  const one = await authorized(a)
  const two = await authorized(b, a.accounts)
  const transport = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init)
    const token = request.headers.get("authorization")?.slice(7)
    return token === (await a.accounts.access(one.id)).accessToken ? a.transport(request) : b.transport(request)
  }) as typeof fetch
  await using f = registry(a.root, a.accounts, transport)
  expect(await f.owner.status(one.id)).toMatchObject({ connectionID: one.id, state: "stopped" })
  await expect(fs.access(f.root)).rejects.toMatchObject({ code: "ENOENT" })
  const results = await Promise.all([f.owner.start(one.id), f.owner.start(two.id), f.owner.start(one.id)])
  expect(results[0]).toEqual(results[2])
  expect(results[0].runtimeID).not.toBe(results[1].runtimeID)
  expect(results.every((result) => result.state === "running")).toBe(true)
  const running = f.owner.running()
  expect(running).toHaveLength(2)
  const probes = await Promise.all(
    running.map(async ({ connection }) =>
      (await fetch(connection.url + "/probe", { headers: connection.headers })).json(),
    ),
  )
  expect(new Set(probes.map((probe) => probe.identity.orgID)).size).toBe(2)
  expect(new Set(probes.map((probe) => probe.home)).size).toBe(2)
  expect(new Set(probes.map((probe) => probe.identity.deviceID)).size).toBe(1)
  for (const probe of probes) {
    expect((await fs.readFile(path.join(probe.root, "fixture-starts"), "utf8")).trim().split("\n")).toHaveLength(1)
    expect(JSON.stringify(results)).not.toContain(probe.home)
  }
  for (const item of running) expect(JSON.stringify(results)).not.toContain(item.connection.headers.authorization)
  await f.owner.stopAll()
  expect(f.owner.running()).toEqual([])
  await f.owner.close()
  const restored = f.restart()
  expect(await restored.start(one.id)).toEqual(results[0])
  const endpoint = restored.running()[0].connection
  const probe = await (await fetch(endpoint.url + "/probe", { headers: endpoint.headers })).json()
  expect(probe.home).toBe(probes.find((item) => item.identity.orgID === one.orgID).home)
  await a.accounts.signOut(one.id)
  await expect(restored.start(one.id)).rejects.toMatchObject({ code: "signed_out" })
  expect(restored.running()).toHaveLength(1)
}, 30_000)

test("one cancelled request cannot stop another caller's launch and final cancellation drains late preparation", async () => {
  await using service = await organizationFixture()
  const account = await authorized(service)
  let entered = Promise.withResolvers<void>()
  let release = Promise.withResolvers<void>()
  let calls = 0
  const transport = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls++
    entered.resolve()
    await release.promise
    return service.transport(input, init)
  }) as typeof fetch
  await using f = registry(service.root, service.accounts, transport)
  const cancelled = new AbortController()
  const survivor = new AbortController()
  const first = f.owner.start(account.id, cancelled.signal).catch((error: unknown) => error)
  const second = f.owner.start(account.id, survivor.signal)
  try {
    await entered.promise
    expect((await f.owner.status(account.id)).state).toBe("starting")
    cancelled.abort()
    expect(await first).toMatchObject({ code: "cancelled" })
    release.resolve()
    expect(await second).toMatchObject({ state: "running" })
    expect(calls).toBe(1)
    survivor.abort()
    expect(f.owner.running()).toHaveLength(1)
    await f.owner.stopAll()
    entered = Promise.withResolvers<void>()
    release = Promise.withResolvers<void>()
    const controller = new AbortController()
    const abandoned = f.owner.start(account.id, controller.signal).catch((error: unknown) => error)
    await entered.promise
    controller.abort()
    expect(await abandoned).toMatchObject({ code: "cancelled" })
    release.resolve()
    await f.owner.close()
    expect(f.owner.running()).toEqual([])
    await expect(f.owner.start(account.id)).rejects.toMatchObject({ code: "cancelled" })
  } finally {
    cancelled.abort()
    survivor.abort()
    release.resolve()
    await Promise.allSettled([first, second])
  }
}, 20_000)

test("foreign tickets and lost device identity never silently replace established member Homes", async () => {
  await using service = await organizationFixture()
  const account = await authorized(service)
  let foreign = true
  const transport = (async (...args: Parameters<typeof fetch>) => {
    const response = await service.transport(...args)
    if (!foreign) return response
    const ticket = await response.json()
    return Response.json({ ...ticket, runtime: { ...ticket.runtime, accountID: "another-account" } })
  }) as typeof fetch
  await using f = registry(service.root, service.accounts, transport)
  await expect(f.owner.start(account.id)).rejects.toMatchObject({ code: "identity_changed" })
  expect((await f.owner.status(account.id)).state).toBe("failed")
  expect(f.owner.running()).toEqual([])
  foreign = false
  expect(await f.owner.start(account.id)).toMatchObject({ state: "running" })
  await f.owner.close()
  await fs.rm(path.join(f.root, "device.json"))
  const restored = f.restart()
  await expect(restored.start(account.id)).rejects.toMatchObject({ code: "identity_changed" })
  expect(restored.running()).toEqual([])
  await expect(fs.access(path.join(f.root, "device.json"))).rejects.toMatchObject({ code: "ENOENT" })
}, 20_000)
