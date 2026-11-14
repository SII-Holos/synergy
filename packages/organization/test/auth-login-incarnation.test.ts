import { expect, spyOn, test } from "bun:test"
import { createHash, randomBytes } from "node:crypto"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { StoreTransaction, TransactionalStore } from "@ericsanchezok/synergy-harness/storage/transactional-store"
import { StoragePath } from "@ericsanchezok/synergy-harness/storage/path"
import path from "node:path"
import { OrganizationClientAuth as Client, OrganizationProtocol } from "@ericsanchezok/synergy-organization-protocol"
import { OrganizationStoragePath as Keys } from "../src/storage/path"
import { fixture, password } from "./support/organization"
import { OrganizationRecord as Record } from "../src/storage/records"
import { OrganizationLoginSessions } from "../src/auth/login-sessions"
import { digest } from "../src/auth/secret"

const issuer = "https://organization.example"
const desktop = {
  clientID: "desktop",
  kind: "desktop" as const,
  redirectUri: "synergy://organization-auth/callback" as const,
}
type Fixture = Awaited<ReturnType<typeof fixture>>
function request(f: Fixture, route: string, body?: unknown, accessToken?: string) {
  return f.service.fetch(
    new Request(`${issuer}/org/v1${route}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        "content-type": "application/json",
        ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  )
}
async function grant(f: Fixture, owner: ReturnType<Fixture["client"]>) {
  const deployment = await f.service.deployment()
  const authority = { issuer, orgID: deployment.orgID, deploymentIncarnation: deployment.deploymentIncarnation }
  const verifier = randomBytes(32).toString("base64url")
  const input = {
    ...authority,
    clientID: desktop.clientID,
    redirectUri: desktop.redirectUri,
    codeChallengeMethod: "S256" as const,
    codeChallenge: createHash("sha256").update(verifier).digest("base64url"),
    state: randomBytes(32).toString("base64url"),
  }
  const authorization = await owner.request("POST", "/auth/authorize", input)
  expect(authorization.status).toBe(200)
  const code = Client.Code.parse(await authorization.json())
  const response = await request(f, "/auth/exchange", {
    ...authority,
    clientID: desktop.clientID,
    redirectUri: desktop.redirectUri,
    code: code.code,
    verifier,
  })
  expect(response.status).toBe(200)
  return { tokens: Client.Tokens.parse(await response.json()), input }
}

test("a real H0 login cookie cannot authorize a fresh H1 client grant after deployment publication", async () => {
  await using f = await fixture(undefined, { clientAuthentication: { clients: [desktop] } })
  const owner = await f.initialize()
  const original = await grant(f, owner)
  expect((await owner.request("GET", "/auth/session")).status).toBe(200)
  const before = await f.service.deployment()
  const next = OrganizationProtocol.Deployment.parse({ ...before, deploymentIncarnation: crypto.randomUUID() })
  await f.service.maintenance.run(() => Storage.transaction(() => Storage.write(Keys.deployment(), next)))
  expect(
    (
      await owner.request("POST", "/auth/authorize", {
        ...original.input,
        deploymentIncarnation: next.deploymentIncarnation,
      })
    ).status,
  ).toBe(401)
  expect((await owner.request("GET", "/auth/session")).status).toBe(401)
  const fresh = f.client()
  await fresh.login("owner", password)
  expect((await fresh.request("GET", "/auth/session")).status).toBe(200)
  expect((await grant(f, fresh)).tokens.deploymentIncarnation).toBe(next.deploymentIncarnation)
})

test("existing refresh and access authority rejects both the old deployment and relabeling an old refresh to H1", async () => {
  await using f = await fixture(undefined, { clientAuthentication: { clients: [desktop] } })
  const owner = await f.initialize()
  const original = await grant(f, owner)
  const before = await f.service.deployment()
  const next = OrganizationProtocol.Deployment.parse({ ...before, deploymentIncarnation: crypto.randomUUID() })
  await f.service.maintenance.run(() => Storage.transaction(() => Storage.write(Keys.deployment(), next)))
  const refresh = {
    issuer,
    orgID: before.orgID,
    deploymentIncarnation: before.deploymentIncarnation,
    clientID: desktop.clientID,
    refreshToken: original.tokens.refreshToken!,
  }
  expect((await request(f, "/auth/refresh", refresh)).status).toBe(401)
  expect(
    (await request(f, "/auth/refresh", { ...refresh, deploymentIncarnation: next.deploymentIncarnation })).status,
  ).toBe(401)
  expect((await request(f, "/auth/session", undefined, original.tokens.accessToken)).status).toBe(401)
})

test("cookie and fresh login publication reject an account belonging to another actual deployment organization", async () => {
  await using f = await fixture()
  const owner = await f.initialize()
  const before = await f.service.deployment()
  const next = OrganizationProtocol.Deployment.parse({
    ...before,
    orgID: "foreign-org",
    deploymentIncarnation: crypto.randomUUID(),
  })
  await f.service.maintenance.run(() => Storage.transaction(() => Storage.write(Keys.deployment(), next)))
  expect((await owner.request("GET", "/auth/session")).status).toBe(401)
  expect((await f.client().request("POST", "/auth/login", { loginName: "owner", password })).status).toBe(401)
})

test("the central startup migration preserves actual H0 cookie and refresh credentials across a legacy upgrade and restart", async () => {
  await using f = await fixture(undefined, { clientAuthentication: { clients: [desktop] } })
  const owner = await f.initialize()
  const original = await grant(f, owner)
  const before = await f.service.deployment()
  await f.service.close()
  const store = await TransactionalStore.open({
    backend: "sqlite",
    namespace: "organization",
    filename: path.join(f.service.home, ".synergy", "data", "organization.sqlite"),
  })
  try {
    const rows = await store.query({ prefix: ["organization", "logins"], limit: 128 })
    expect(rows).toHaveLength(1)
    for (const row of rows) {
      const {
        orgID: _org,
        deploymentIncarnation: _incarnation,
        schemaVersion: _version,
        ...old
      } = Record.Login.parse(row.value)
      await store.write(row.key, { ...old, schemaVersion: 1 })
      for (let index = 0; index < 130; index++) {
        const tokenHash = digest(`legacy-upgrade-extra-${index}`)
        await store.write(Keys.login(tokenHash), { ...old, schemaVersion: 1, tokenHash })
      }
    }
    const key = StoragePath.metaMigrationLogDomain("organization")
    const log = await store.read<Record<string, number>>(key)
    delete log[OrganizationLoginSessions.migration.id]
    await store.write(key, log)
  } finally {
    await store.close()
  }
  await f.restart()
  expect(await f.service.deployment()).toEqual(before)
  expect((await owner.request("GET", "/auth/session")).status).toBe(200)
  const refresh = await request(f, "/auth/refresh", {
    issuer,
    orgID: before.orgID,
    deploymentIncarnation: before.deploymentIncarnation,
    clientID: desktop.clientID,
    refreshToken: original.tokens.refreshToken!,
  })
  expect(refresh.status).toBe(200)
  expect(Client.Tokens.parse(await refresh.json()).deploymentIncarnation).toBe(before.deploymentIncarnation)
  await f.service.maintenance.run(async () => {
    const rows = await Storage.query({ prefix: ["organization", "logins"], limit: 200 })
    expect(rows).toHaveLength(131)
    for (const row of rows)
      expect(Record.Login.parse(row.value)).toMatchObject({
        schemaVersion: 2,
        orgID: before.orgID,
        deploymentIncarnation: before.deploymentIncarnation,
      })
  })
  await f.restart()
  expect((await owner.request("GET", "/auth/session")).status).toBe(200)
})

test("unbound legacy cookies fail authentication instead of receiving the current deployment in a request handler", async () => {
  await using f = await fixture()
  const owner = await f.initialize()
  await f.service.maintenance.run(() =>
    Storage.transaction(async () => {
      const rows = await Storage.query({ prefix: ["organization", "logins"], limit: 128 })
      for (const row of rows) {
        const {
          orgID: _org,
          deploymentIncarnation: _incarnation,
          schemaVersion: _version,
          ...old
        } = Record.Login.parse(row.value)
        await Storage.write(row.key, { ...old, schemaVersion: 1 })
      }
    }),
  )
  expect((await owner.request("GET", "/auth/session")).status).toBe(401)
  await f.service.maintenance.run(async () => {
    const rows = await Storage.query({ prefix: ["organization", "logins"], limit: 128 })
    expect(rows[0]?.value).toHaveProperty("schemaVersion", 1)
    expect(rows[0]?.value).not.toHaveProperty("deploymentIncarnation")
  })
})

test("a deployment switched ahead of its original signing authority cannot re-endorse legacy cookies through migration", async () => {
  await using f = await fixture()
  const owner = await f.initialize()
  const before = await f.service.deployment()
  await f.service.maintenance.run(() =>
    Storage.transaction(async () => {
      const rows = await Storage.query({ prefix: ["organization", "logins"], limit: 128 })
      for (const row of rows) {
        const {
          orgID: _org,
          deploymentIncarnation: _incarnation,
          schemaVersion: _version,
          ...old
        } = Record.Login.parse(row.value)
        await Storage.write(row.key, { ...old, schemaVersion: 1 })
      }
      await Storage.write(Keys.deployment(), { ...before, deploymentIncarnation: crypto.randomUUID() })
    }),
  )
  await expect(f.service.maintenance.run(() => OrganizationLoginSessions.migration.up(() => {}))).rejects.toThrow(
    "does not match this deployment",
  )
  expect((await owner.request("GET", "/auth/session")).status).toBe(401)
  await f.service.maintenance.run(async () => {
    const rows = await Storage.query({ prefix: ["organization", "logins"], limit: 128 })
    expect(rows[0]?.value).toHaveProperty("schemaVersion", 1)
    expect(rows[0]?.value).not.toHaveProperty("deploymentIncarnation")
  })
})

test("legacy retirement pages the original deployment in the actual write transaction, rolls back and cannot run after publication", async () => {
  await using f = await fixture()
  const owner = await f.initialize()
  const session = (await (await owner.request("GET", "/auth/session")).json()) as {
    account: { accountID: string; authRevision: number }
  }
  const before = await f.service.deployment()
  const next = OrganizationProtocol.Deployment.parse({ ...before, deploymentIncarnation: crypto.randomUUID() })
  await f.service.maintenance.run(() =>
    Storage.transaction(async () => {
      for (let index = 0; index < 131; index++) {
        const tokenHash = digest(`legacy-${index}`)
        await Storage.write(Keys.login(tokenHash), {
          schemaVersion: 1,
          tokenHash,
          accountID: session.account.accountID,
          authRevision: session.account.authRevision,
          csrfHash: digest("legacy-csrf"),
          expiresAt: Date.now() + 60_000,
        })
      }
    }),
  )
  await expect(f.service.maintenance.run(() => OrganizationLoginSessions.retireLegacyLogins(before))).rejects.toThrow(
    "original write transaction",
  )
  await expect(
    f.service.maintenance.run(() => Storage.transaction(() => OrganizationLoginSessions.retireLegacyLogins(next))),
  ).rejects.toThrow("original deployment")
  await expect(
    f.service.maintenance.run(() =>
      Storage.transaction(async () => {
        expect(await OrganizationLoginSessions.retireLegacyLogins(before)).toBe(131)
        await Storage.write(Keys.deployment(), next)
        throw new Error("Final publication rolled back")
      }),
    ),
  ).rejects.toThrow("Final publication rolled back")
  expect(await f.service.deployment()).toEqual(before)
  expect((await owner.request("GET", "/auth/session")).status).toBe(200)
  await f.service.maintenance.run(async () => {
    const rows = await Storage.query({ prefix: ["organization", "logins"], limit: 200 })
    expect(rows).toHaveLength(132)
  })
  await f.service.maintenance.run(() =>
    Storage.transaction(async () => {
      const mutable = { ...before }
      const retiring = OrganizationLoginSessions.retireLegacyLogins(mutable)
      mutable.deploymentIncarnation = next.deploymentIncarnation
      expect(await retiring).toBe(131)
      await Storage.write(Keys.deployment(), next)
    }),
  )
  expect((await owner.request("GET", "/auth/session")).status).toBe(401)
  await expect(
    f.service.maintenance.run(() => Storage.transaction(() => OrganizationLoginSessions.retireLegacyLogins(before))),
  ).rejects.toThrow("original deployment")
  await f.service.maintenance.run(async () => {
    const rows = await Storage.query({ prefix: ["organization", "logins"], limit: 200 })
    expect(rows).toHaveLength(1)
    expect(Record.Login.parse(rows[0]!.value).deploymentIncarnation).toBe(before.deploymentIncarnation)
  })
})

test("a caught late legacy deletion failure still prevents the original outer transaction from publishing a fresh deployment", async () => {
  await using f = await fixture()
  const owner = await f.initialize()
  const before = await f.service.deployment()
  const next = OrganizationProtocol.Deployment.parse({ ...before, deploymentIncarnation: crypto.randomUUID() })
  await f.service.maintenance.run(() =>
    Storage.transaction(async () => {
      const rows = await Storage.query({ prefix: ["organization", "logins"], limit: 1 })
      const login = Record.Login.parse(rows[0]?.value)
      const { orgID: _org, deploymentIncarnation: _incarnation, ...old } = login
      for (let index = 0; index < 131; index++) {
        const tokenHash = digest(`legacy-late-failure-${index}`)
        await Storage.write(Keys.login(tokenHash), { ...old, schemaVersion: 1, tokenHash })
      }
    }),
  )
  const failure = new Error("Second legacy page deletion failed after its actual staged removal")
  const remove = StoreTransaction.prototype.remove
  let deleted = 0
  using boundary = spyOn(StoreTransaction.prototype, "remove").mockImplementation(async function (
    this: StoreTransaction,
    ...args: Parameters<StoreTransaction["remove"]>
  ) {
    await remove.apply(this, args)
    if (args[0][0] === "organization" && args[0][1] === "logins" && ++deleted === 129) throw failure
  })
  await expect(
    f.service.maintenance.run(() =>
      Storage.transaction(async () => {
        await expect(OrganizationLoginSessions.retireLegacyLogins(before)).rejects.toBe(failure)
        expect(deleted).toBe(129)
        await Storage.write(Keys.deployment(), next)
      }),
    ),
  ).rejects.toBe(failure)
  boundary.mockRestore()
  expect(await f.service.deployment()).toEqual(before)
  expect((await owner.request("GET", "/auth/session")).status).toBe(200)
  await f.service.maintenance.run(async () => {
    const rows = await Storage.query({ prefix: ["organization", "logins"], limit: 200 })
    expect(rows).toHaveLength(132)
    expect(rows.filter((row) => Record.Login.safeParse(row.value).success)).toHaveLength(1)
  })
})

test("an unfinished legacy retirement cannot escape its original deployment publication transaction", async () => {
  await using f = await fixture()
  await f.initialize()
  const before = await f.service.deployment()
  const next = OrganizationProtocol.Deployment.parse({ ...before, deploymentIncarnation: crypto.randomUUID() })
  const tokenHash = digest("unfinished-retirement")
  await f.service.maintenance.run(() =>
    Storage.transaction(async () => {
      const rows = await Storage.query({ prefix: ["organization", "logins"], limit: 1 })
      const { orgID: _org, deploymentIncarnation: _incarnation, ...old } = Record.Login.parse(rows[0]?.value)
      await Storage.write(Keys.login(tokenHash), { ...old, schemaVersion: 1, tokenHash })
    }),
  )
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const remove = StoreTransaction.prototype.remove
  using boundary = spyOn(StoreTransaction.prototype, "remove").mockImplementation(async function (
    this: StoreTransaction,
    ...args: Parameters<StoreTransaction["remove"]>
  ) {
    await remove.apply(this, args)
    if (args[0][2] !== tokenHash) return
    entered.resolve()
    await release.promise
  })
  let retiring: Promise<unknown> | undefined
  try {
    await expect(
      f.service.maintenance.run(() =>
        Storage.transaction(async () => {
          retiring = OrganizationLoginSessions.retireLegacyLogins(before).catch((error: unknown) => error)
          await entered.promise
          await Storage.write(Keys.deployment(), next)
        }),
      ),
    ).rejects.toThrow("must complete before deployment publication")
  } finally {
    release.resolve()
    await retiring
  }
  expect(await f.service.deployment()).toEqual(before)
  await f.service.maintenance.run(async () => {
    expect(await Storage.read(Keys.login(tokenHash))).toHaveProperty("schemaVersion", 1)
  })
})
