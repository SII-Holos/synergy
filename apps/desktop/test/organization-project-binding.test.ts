import { expect, test } from "bun:test"
import { randomBytes, createHash } from "node:crypto"
import { DesktopOrganizationAuthorization } from "../src/organization/authorization"
import { DesktopOrganizationIPC } from "../src/organization/ipc"
import { organizationFixture } from "./fixture/organization"

async function setup(choose: () => Promise<string | undefined>) {
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
    const writes: { url: string; body: unknown }[] = []
    const state = { allowed: true, conflict: false, revision: "b".repeat(64) }
    const summary = () => ({ projectID: "project-a", revision: state.revision, binding: null })
    const transport = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init)
        const url = new URL(request.url)
        if (url.origin === "http://127.0.0.1:43210") {
          expect(request.headers.get("authorization")).toBe("Bearer private-member-credential")
          expect(url.pathname).toBe("/organization-local-project/project-a")
          if (request.method === "POST") {
            writes.push({ url: request.url, body: await request.json() })
            if (state.conflict) {
              state.revision = "d".repeat(64)
              return Response.json(
                {
                  code: "REVISION_CONFLICT",
                  message: "/private/project failed",
                  outcome: "not_dispatched",
                  retryable: false,
                },
                { status: 409 },
              )
            }
          }
          return Response.json(summary())
        }
        if (url.pathname === "/org/v1/projects/project-a")
          return Response.json({
            projectID: "project-a",
            orgID: f.info.orgID,
            name: "Project",
            description: "",
            state: "active",
            revision: 1,
            createdAt: 0,
            role: "maintainer",
            permissions: { read: true, manage: true, execute: state.allowed },
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
      chooseDirectory: choose,
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
    const input = { requestID: "project-read", connectionID: connection.id, projectID: "project-a" }
    return {
      f,
      ipc,
      trusted,
      input,
      state,
      writes,
      summary,
      async [Symbol.asyncDispose]() {
        ipc.dispose()
        await f[Symbol.asyncDispose]()
      },
    }
  } catch (error) {
    await f[Symbol.asyncDispose]()
    throw error
  }
}

test("native directory binding keeps paths and bearer in main and returns a bounded conflict summary", async () => {
  await using f = await setup(async () => "/private/project")
  expect(await f.ipc.handle(f.trusted, "projectBinding", f.input)).toEqual({
    ok: true,
    value: { kind: "ready", summary: f.summary() },
  })
  f.state.conflict = true
  const result = await f.ipc.handle(f.trusted, "bindProject", {
    ...f.input,
    requestID: "choose-project",
    expectedRevision: f.state.revision,
  })
  expect(result).toEqual({ ok: true, value: { kind: "revision_conflict", current: f.summary() } })
  expect(f.writes).toHaveLength(1)
  expect(f.writes[0]?.body).toEqual({
    requestID: "choose-project",
    expectedRevision: "b".repeat(64),
    directory: "/private/project",
  })
  expect(JSON.stringify(result)).not.toMatch(/private|credential|stack|43210/)
  expect(
    await f.ipc.handle(f.trusted, "bindProject", {
      ...f.input,
      expectedRevision: f.state.revision,
      directory: "/injected/path",
    }),
  ).toMatchObject({ ok: false, error: { code: "invalid_request" } })
})

test("permission loss while the native picker is open prevents the local write", async () => {
  const chosen = Promise.withResolvers<string>()
  const entered = Promise.withResolvers<void>()
  await using f = await setup(async () => {
    entered.resolve()
    return chosen.promise
  })
  const result = f.ipc.handle(f.trusted, "bindProject", { ...f.input, expectedRevision: f.state.revision })
  await entered.promise
  f.state.allowed = false
  chosen.resolve("/private/project")
  expect(await result).toMatchObject({ ok: false, error: { code: "permission_denied" } })
  expect(f.writes).toHaveLength(0)
})

test("document cancellation during the native picker cannot publish a late directory choice", async () => {
  const chosen = Promise.withResolvers<string>()
  const entered = Promise.withResolvers<void>()
  await using f = await setup(async () => {
    entered.resolve()
    return chosen.promise
  })
  const result = f.ipc.handle(f.trusted, "bindProject", { ...f.input, expectedRevision: f.state.revision })
  await entered.promise
  f.ipc.invalidate()
  expect(await result).toMatchObject({ ok: false, error: { code: "cancelled" } })
  chosen.resolve("/private/project")
  await Bun.sleep(0)
  expect(f.writes).toHaveLength(0)
})
