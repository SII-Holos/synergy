import { signOutAccount, prepareAccountSignOut } from "./fixture/organization-sign-out"
import { expect, test } from "bun:test"
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { DesktopOrganizationAccounts } from "../src/organization/accounts"

const authority = { issuer: "https://organization.example", orgID: "org-a", deploymentIncarnation: "deployment-a" }
function tokens(overrides: Record<string, unknown> = {}) {
  return {
    ...authority,
    clientID: "desktop",
    account: {
      orgID: authority.orgID,
      accountID: "account-a",
      loginName: "owner",
      displayName: "Owner",
      role: "owner" as const,
      state: "active" as const,
      revision: 0,
      authRevision: 0,
      createdAt: Date.now(),
    },
    tokenType: "Bearer" as const,
    accessToken: randomBytes(32).toString("hex"),
    expiresAt: Date.now() + 60_000,
    refreshToken: randomBytes(32).toString("hex"),
    refreshExpiresAt: Date.now() + 3600_000,
    ...overrides,
  }
}
async function fixture() {
  const root = await fs.mkdtemp(path.join(tmpdir(), "synergy-organization-accounts-"))
  const key = randomBytes(32)
  const encryption = {
    available: async () => true,
    encrypt: async (value: string) => {
      const iv = randomBytes(12)
      const cipher = createCipheriv("aes-256-gcm", key, iv)
      const data = Buffer.concat([cipher.update(value, "utf8"), cipher.final()])
      return Buffer.concat([iv, cipher.getAuthTag(), data])
    },
    decrypt: async (value: Buffer) => {
      const cipher = createDecipheriv("aes-256-gcm", key, value.subarray(0, 12))
      cipher.setAuthTag(value.subarray(12, 28))
      return Buffer.concat([cipher.update(value.subarray(28)), cipher.final()]).toString("utf8")
    },
  }
  const requests: Request[] = []
  let respond = async (_request: Request): Promise<Response> => Response.json(tokens())
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request && init === undefined ? input : new Request(input, init)
    requests.push(request)
    return respond(request)
  }) as typeof fetch
  const options = { root, encryption, fetch: fetcher }
  return {
    root,
    encryption,
    requests,
    store: new DesktopOrganizationAccounts(options),
    restart: () => new DesktopOrganizationAccounts(options),
    response: (next: typeof respond) => {
      respond = next
    },
    file: (id: string) => path.join(root, `${id}.json`),
    async [Symbol.asyncDispose]() {
      await fs.rm(root, { recursive: true, force: true })
    },
  }
}

test("Desktop accounts persist only sealed refresh credentials and isolate deployment and account identity", async () => {
  await using f = await fixture()
  const grant = tokens()
  const connection = await f.store.accept(grant)
  expect(connection.state).toBe("ready")
  expect(connection.account.accountID).toBe("account-a")
  const serialized = await fs.readFile(f.file(connection.id), "utf8")
  expect(serialized).not.toContain(grant.refreshToken)
  expect(serialized).not.toContain(grant.accessToken)
  expect(JSON.stringify(connection)).not.toContain("encrypted")
  expect(JSON.stringify(await f.store.list())).not.toContain(grant.refreshToken)
  expect((await f.store.access(connection.id)).accessToken).toBe(grant.accessToken)
  expect(f.requests).toHaveLength(0)
  if (process.platform !== "win32") expect((await fs.stat(f.file(connection.id))).mode & 0o777).toBe(0o600)
  const other = await f.store.accept(tokens({ account: { ...grant.account, accountID: "account-b" } }))
  const restored = await f.store.accept(tokens({ deploymentIncarnation: "deployment-b" }))
  expect(new Set([connection.id, other.id, restored.id]).size).toBe(3)
  expect(await f.restart().list()).toHaveLength(3)
  await expect(f.store.accept(tokens({ issuer: "https://different.example" }))).rejects.toMatchObject({
    code: "identity_changed",
  })
})

test("a prepared Desktop logout is durable before revocation and its receipt cannot revoke a later login", async () => {
  await using f = await fixture()
  const original = await f.store.accept(tokens())
  f.response(async () => Response.json({ ok: true }))
  const requestID = randomUUID()
  const intent = { connectionID: original.id, expectedRevision: original.revision, requestID }
  const pending = await f.store.signOut({ ...intent, phase: "prepare" })
  expect(pending).toMatchObject({ state: "sign_out_pending", revision: requestID })
  expect(f.requests).toHaveLength(0)
  const restarted = f.restart()
  expect((await restarted.list())[0]).toEqual(pending)
  await expect(restarted.access(original.id)).rejects.toMatchObject({ code: "signed_out" })
  await expect(restarted.accept(tokens())).rejects.toMatchObject({ code: "revocation_pending" })
  const commit = { ...intent, phase: "commit" as const, expectedRevision: requestID }
  expect(await restarted.signOut(commit)).toMatchObject({ state: "signed_out", revision: requestID })
  expect(f.requests).toHaveLength(1)
  expect(await f.restart().signOut(commit)).toMatchObject({ state: "signed_out", revision: requestID })
  expect(f.requests).toHaveLength(1)
  const next = tokens()
  const later = await restarted.accept(next)
  expect(later.revision).not.toBe(original.revision)
  for (const phase of ["prepare", "commit"] as const)
    await expect(
      restarted.signOut({
        ...intent,
        phase,
        expectedRevision: phase === "commit" ? requestID : intent.expectedRevision,
      }),
    ).rejects.toMatchObject({ code: "connection_changed" })
  expect(f.requests).toHaveLength(1)
  expect((await restarted.access(later.id)).accessToken).toBe(next.accessToken)
})

test("a Desktop refresh invalidates an older logout selector without revoking its replacement", async () => {
  await using f = await fixture()
  const original = await f.store.accept(tokens())
  const replacement = tokens()
  f.response(async () => Response.json(replacement))
  const restored = f.restart()
  const current = await restored.access(original.id)
  expect(current.connection.revision).not.toBe(original.revision)
  await expect(
    restored.signOut({
      phase: "prepare",
      connectionID: original.id,
      expectedRevision: original.revision,
      requestID: randomUUID(),
    }),
  ).rejects.toMatchObject({ code: "connection_changed" })
  expect(f.requests).toHaveLength(1)
  expect((await restored.access(original.id)).accessToken).toBe(replacement.accessToken)
})

test("a legacy pending Desktop logout adopts only its actual durable revision", async () => {
  await using f = await fixture()
  const original = await f.store.accept(tokens())
  const legacyRevision = randomUUID()
  const legacy = JSON.parse(await fs.readFile(f.file(original.id), "utf8"))
  await fs.writeFile(
    f.file(original.id),
    JSON.stringify({ ...legacy, state: "sign_out_pending", revision: legacyRevision }),
  )
  f.response(async () => Response.json({ ok: true }))
  const restored = f.restart()
  await expect(
    restored.signOut({
      phase: "prepare",
      connectionID: original.id,
      expectedRevision: legacyRevision,
      requestID: randomUUID(),
    }),
  ).rejects.toMatchObject({ code: "connection_changed" })
  expect(f.requests).toHaveLength(0)
  const intent = { connectionID: original.id, expectedRevision: legacyRevision, requestID: legacyRevision }
  expect(await restored.signOut({ ...intent, phase: "prepare" })).toMatchObject({
    state: "sign_out_pending",
    revision: legacyRevision,
  })
  expect(f.requests).toHaveLength(0)
  expect(await restored.signOut({ ...intent, phase: "commit" })).toMatchObject({
    state: "signed_out",
    revision: legacyRevision,
  })
})

test("concurrent Desktop callers share one rotation and only use the durably saved replacement", async () => {
  await using f = await fixture()
  const grant = tokens()
  const connection = await f.store.accept(grant)
  const next = tokens()
  const entered = Promise.withResolvers<void>()
  const response = Promise.withResolvers<Response>()
  f.response(async () => {
    entered.resolve()
    return response.promise
  })
  const recovered = f.restart()
  const first = recovered.access(connection.id)
  const second = recovered.access(connection.id)
  await entered.promise
  expect((await f.restart().list())[0]!.state).toBe("reauthorization_required")
  response.resolve(Response.json(next))
  expect((await first).accessToken).toBe(next.accessToken)
  expect((await second).accessToken).toBe(next.accessToken)
  expect((await recovered.access(connection.id)).accessToken).toBe(next.accessToken)
  expect(f.requests).toHaveLength(1)
  expect(f.requests[0]!.url).toBe(`${authority.issuer}/org/v1/auth/refresh`)
  expect(f.requests[0]!.redirect).toBe("error")
  expect(f.requests[0]!.headers.has("cookie")).toBe(false)
  expect(await f.requests[0]!.json()).toMatchObject({
    ...authority,
    clientID: "desktop",
    refreshToken: grant.refreshToken,
  })
  expect((await f.restart().list())[0]!.state).toBe("ready")
})

test("a lost rotation survives restart as reauthorization required and the old credential can only revoke", async () => {
  await using f = await fixture()
  const grant = tokens()
  const connection = await f.store.accept(grant)
  f.response(async () => {
    throw new Error(`Lost response with secret ${grant.refreshToken}`)
  })
  await expect(f.restart().access(connection.id)).rejects.toMatchObject({ code: "reauthorization_required" })
  const again = f.restart()
  await expect(again.access(connection.id)).rejects.toMatchObject({ code: "reauthorization_required" })
  expect(f.requests).toHaveLength(1)
  f.response(async () => Response.json({ ok: true }))
  expect((await signOutAccount(again, connection.id)).state).toBe("signed_out")
  expect(f.requests).toHaveLength(2)
  expect(f.requests[1]!.url).toBe(`${authority.issuer}/org/v1/auth/revoke`)
  expect((await f.requests[1]!.json()).refreshToken).toBe(grant.refreshToken)
  expect(await fs.readFile(f.file(connection.id), "utf8")).not.toContain("encrypted")
  await expect(f.restart().access(connection.id)).rejects.toMatchObject({ code: "signed_out" })
})

test("offline logout blocks local access across restart and only explicit logout retries use its credential", async () => {
  await using f = await fixture()
  const connection = await f.store.accept(tokens())
  const other = await f.store.accept(tokens({ deploymentIncarnation: "other-deployment" }))
  f.response(async () => {
    throw new Error("offline")
  })
  await expect(signOutAccount(f.store, connection.id)).rejects.toMatchObject({ code: "revocation_pending" })
  await expect(f.store.access(connection.id)).rejects.toMatchObject({ code: "signed_out" })
  expect((await f.store.access(other.id)).connection.id).toBe(other.id)
  const recovered = f.restart()
  expect((await recovered.list()).find((item) => item.id === connection.id)?.state).toBe("sign_out_pending")
  await expect(recovered.access(connection.id)).rejects.toMatchObject({ code: "signed_out" })
  expect(f.requests).toHaveLength(1)
  f.response(async () => Response.json({ ok: true }))
  expect((await signOutAccount(recovered, connection.id)).state).toBe("signed_out")
  expect((await signOutAccount(recovered, connection.id)).state).toBe("signed_out")
  expect(f.requests).toHaveLength(2)
})

test("logout wins against a late refresh response and cannot resurrect stored or memory credentials", async () => {
  await using f = await fixture()
  const connection = await f.store.accept(tokens())
  const entered = Promise.withResolvers<void>()
  const response = Promise.withResolvers<Response>()
  f.response(async (request) => {
    if (request.url.endsWith("/revoke")) return Response.json({ ok: true })
    entered.resolve()
    return response.promise
  })
  const recovered = f.restart()
  const pending = recovered.access(connection.id)
  const rejected = pending.catch((error: unknown) => error)
  await entered.promise
  const prepared = await prepareAccountSignOut(recovered, connection.id)
  const request = {
    connectionID: connection.id,
    phase: "commit" as const,
    expectedRevision: prepared.revision,
    requestID: prepared.revision,
  }
  const signOut = recovered.signOut(request)
  const same = recovered.signOut(request)
  expect((await signOut).state).toBe("signed_out")
  expect((await same).state).toBe("signed_out")
  response.resolve(Response.json(tokens()))
  expect(await rejected).toMatchObject({ code: "signed_out" })
  expect((await f.restart().list())[0]!.state).toBe("signed_out")
  await expect(recovered.access(connection.id)).rejects.toMatchObject({ code: "signed_out" })
  expect(f.requests).toHaveLength(2)
})

test("unavailable OS encryption preserves existing records and does not send a refresh", async () => {
  await using f = await fixture()
  const connection = await f.store.accept(tokens())
  const before = await fs.readFile(f.file(connection.id), "utf8")
  f.encryption.available = async () => false
  await expect(f.restart().access(connection.id)).rejects.toMatchObject({ code: "credentials_unavailable" })
  await expect(f.store.accept(tokens())).rejects.toMatchObject({ code: "credentials_unavailable" })
  expect(await fs.readFile(f.file(connection.id), "utf8")).toBe(before)
  expect(f.requests).toHaveLength(0)
  f.encryption.available = async () => true
  expect((await f.restart().access(connection.id)).connection.id).toBe(connection.id)
})

test("corrupt files and swapped encrypted account credentials fail closed without leaking or overwriting data", async () => {
  await using f = await fixture()
  const connection = await f.store.accept(tokens())
  const other = await f.store.accept(tokens({ deploymentIncarnation: "other-deployment" }))
  const first = JSON.parse(await fs.readFile(f.file(connection.id), "utf8"))
  const second = JSON.parse(await fs.readFile(f.file(other.id), "utf8"))
  first.encrypted = second.encrypted
  const swapped = JSON.stringify(first)
  await fs.writeFile(f.file(connection.id), swapped)
  await expect(f.restart().access(connection.id)).rejects.toMatchObject({ code: "credentials_invalid" })
  expect(await fs.readFile(f.file(connection.id), "utf8")).toBe(swapped)
  const corrupt = '{"sensitive": "never-report-this-value"'
  await fs.writeFile(f.file(connection.id), corrupt)
  await expect(f.restart().list()).rejects.toMatchObject({
    code: "storage_unavailable",
    message: "Organization credentials could not be read or saved. Existing data has been preserved.",
  })
  expect(await fs.readFile(f.file(connection.id), "utf8")).toBe(corrupt)
  expect(f.requests).toHaveLength(0)
})

test("failure to persist a rotation intent prevents network use and failure to seal its result prevents access", async () => {
  await using f = await fixture()
  const connection = await f.store.accept(tokens())
  const decrypt = f.encryption.decrypt
  f.encryption.decrypt = async (value) => {
    const result = await decrypt(value)
    await fs.rename(f.file(connection.id), `${f.file(connection.id)}.preserved`)
    await fs.mkdir(f.file(connection.id))
    return result
  }
  await expect(f.restart().access(connection.id)).rejects.toMatchObject({ code: "storage_unavailable" })
  expect(f.requests).toHaveLength(0)
  await fs.rmdir(f.file(connection.id))
  await fs.rename(`${f.file(connection.id)}.preserved`, f.file(connection.id))
  f.encryption.decrypt = decrypt
  f.encryption.encrypt = async () => {
    throw new Error("secret-bearing encryption failure")
  }
  await expect(f.restart().access(connection.id)).rejects.toMatchObject({ code: "reauthorization_required" })
  expect((await f.restart().list())[0]!.state).toBe("reauthorization_required")
  await expect(f.restart().access(connection.id)).rejects.toMatchObject({ code: "reauthorization_required" })
  expect(f.requests).toHaveLength(1)
})

test("a refresh cannot change authority or account and late authorization cannot undo logout", async () => {
  await using f = await fixture()
  const grant = tokens()
  const connection = await f.store.accept(grant)
  f.response(async () => Response.json(tokens({ account: { ...grant.account, accountID: "different-account" } })))
  await expect(f.restart().access(connection.id)).rejects.toMatchObject({ code: "reauthorization_required" })
  const encrypt = f.encryption.encrypt
  const entered = Promise.withResolvers<void>()
  const resume = Promise.withResolvers<void>()
  f.encryption.encrypt = async (value) => {
    entered.resolve()
    await resume.promise
    return encrypt(value)
  }
  const pending = f.store.accept(tokens())
  const rejected = pending.catch((error: unknown) => error)
  await entered.promise
  f.response(async () => Response.json({ ok: true }))
  await signOutAccount(f.store, connection.id)
  resume.resolve()
  expect(await rejected).toMatchObject({ code: "cancelled" })
  expect((await f.restart().list())[0]!.state).toBe("signed_out")
})
