import { expect, test } from "bun:test"
import { randomBytes, createHash } from "node:crypto"
import { DesktopOrganizationAuthorization } from "../src/organization/authorization"
import { DesktopOrganizationIPC } from "../src/organization/ipc"
import { organizationFixture } from "./fixture/organization"
import { OrganizationReadProtocol as Read } from "@ericsanchezok/synergy-organization-protocol"

async function setup() {
  const f = await organizationFixture()
  try {
    const verifier = randomBytes(32).toString("base64url")
    const request = {
      issuer: f.info.issuer,
      orgID: f.info.orgID,
      deploymentIncarnation: f.info.deploymentIncarnation,
      clientID: "desktop",
      redirectUri: "synergy://organization-auth/callback",
      state: randomBytes(32).toString("base64url"),
      codeChallengeMethod: "S256" as const,
      codeChallenge: createHash("sha256").update(verifier).digest("base64url"),
    }
    const code = await f.consent(request)
    const exchanged = await f.api.orgAuth.exchange(
      {
        orgCodeExchangeInput: {
          issuer: f.info.issuer,
          orgID: f.info.orgID,
          deploymentIncarnation: f.info.deploymentIncarnation,
          clientID: "desktop",
          redirectUri: request.redirectUri,
          code: code.code,
          verifier,
        },
      },
      { throwOnError: true },
    )
    const connection = await f.accounts.accept(exchanged.data)
    const state = { epoch: 1, nativeEpoch: 1, creatorID: connection.account.accountID, conflict: false, hold: false }
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const queries: Read.Query[] = []
    const binding = () => ({
      schemaVersion: 1 as const,
      orgID: connection.orgID,
      projectID: "project-a",
      creatorID: state.creatorID,
      driverRuntimeID: "runtime-a",
      bindingEpoch: state.epoch,
    })
    const transport = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init)
        const url = new URL(request.url)
        if (url.origin === "http://127.0.0.1:43210") {
          expect(request.headers.get("authorization")).toBe("Bearer private-member-credential")
          expect(url.pathname).toBe("/organization/session/read")
          const query = Read.Query.parse(await request.json())
          queries.push(query)
          const value = Read.Result.parse({
            operation: "status",
            rootSessionID: "session-a",
            sourceSessionID: "session-a",
            binding: { ...binding(), bindingEpoch: state.nativeEpoch },
            status: { type: "idle", observedAt: 1, controlVersion: 0 },
          })
          if (state.hold) {
            entered.resolve()
            await release.promise
          }
          return state.conflict
            ? Response.json(
                {
                  code: "REVISION_CONFLICT",
                  message: "/private/path changed",
                  outcome: "not_dispatched",
                  retryable: false,
                },
                { status: 409 },
              )
            : Response.json(value)
        }
        if (url.pathname === "/org/v1/sessions/session-a")
          return Response.json({
            sessionID: "session-a",
            projectID: "project-a",
            creatorID: state.creatorID,
            driverRuntimeID: "runtime-a",
            bindingEpoch: state.epoch,
            createdAt: 0,
            shareState: "private",
            resourceIDs: [],
            permissions: { read: true, execute: false, stop: false },
          })
        if (url.pathname === "/org/v1/runtimes/runtime-a")
          return Response.json({
            runtimeID: "runtime-a",
            orgID: f.info.orgID,
            deploymentIncarnation: f.info.deploymentIncarnation,
            accountID: connection.account.accountID,
            runtimeKind: "member",
            deviceID: "device-a",
            publicKey: "a".repeat(64),
            state: "active",
            revision: 1,
            connectionEpoch: 1,
            createdAt: 0,
          })
        return f.transport(request)
      },
      { preconnect() {} },
    )
    const trusted = {}
    const authorization = new DesktopOrganizationAuthorization({
      accounts: f.accounts,
      fetch: transport,
      openExternal: async () => {},
    })
    const ipc = new DesktopOrganizationIPC({
      accounts: f.accounts,
      authorization,
      fetch: transport,
      trusted: (event) => event === trusted,
      members: {
        running: () => [
          {
            connectionID: connection.id,
            runtimeID: "runtime-a",
            connection: {
              url: "http://127.0.0.1:43210",
              headers: { authorization: "Bearer private-member-credential" },
            },
          },
        ],
        status: () => {
          throw new Error("Unused status")
        },
        start: async () => {
          throw new Error("Unused start")
        },
      },
    })
    const input = {
      requestID: "native-read",
      connectionID: connection.id,
      query: { rootSessionID: "session-a", operation: "status" },
    }
    return {
      f,
      ipc,
      trusted,
      input,
      state,
      entered,
      release,
      queries,
      binding,
      async [Symbol.asyncDispose]() {
        release.resolve()
        ipc.dispose()
        await f[Symbol.asyncDispose]()
      },
    }
  } catch (error) {
    await f[Symbol.asyncDispose]()
    throw error
  }
}

test("main reads private native status through its fixed generated API for a creator without execute permission", async () => {
  await using f = await setup()
  const result = await f.ipc.handle(f.trusted, "memberRequest", f.input)
  expect(result).toMatchObject({
    ok: true,
    value: { kind: "result", result: { operation: "status", binding: f.binding() } },
  })
  expect(f.queries).toEqual([{ rootSessionID: "session-a", operation: "status" }])
  expect(JSON.stringify(result)).not.toMatch(/private-member|43210|scope|directory|path/)
})

test("organization administration cannot read a different creator's native private Session", async () => {
  await using f = await setup()
  f.state.creatorID = "another-account"
  expect(await f.ipc.handle(f.trusted, "memberRequest", f.input)).toMatchObject({
    ok: false,
    error: { code: "permission_denied" },
  })
  expect(f.queries).toHaveLength(0)
})

test("changed service or native binding evidence rejects a late native read without changing organization identity", async () => {
  await using f = await setup()
  f.state.nativeEpoch = 2
  expect(await f.ipc.handle(f.trusted, "memberRequest", f.input)).toMatchObject({
    ok: true,
    value: { kind: "binding_changed" },
  })
  f.state.nativeEpoch = 1
  f.state.hold = true
  const result = f.ipc.handle(f.trusted, "memberRequest", f.input)
  await f.entered.promise
  f.state.epoch = 2
  f.release.resolve()
  expect(await result).toMatchObject({ ok: true, value: { kind: "binding_changed" } })
})

test("native conflicts expose a fixed outcome without native error data", async () => {
  await using f = await setup()
  f.state.conflict = true
  const result = await f.ipc.handle(f.trusted, "memberRequest", f.input)
  expect(result).toEqual({ ok: true, value: { kind: "revision_conflict" } })
})
