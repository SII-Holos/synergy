import { createHash, randomUUID } from "node:crypto"
import { constants } from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"
import { z } from "zod"
import { AtomicFile } from "@ericsanchezok/synergy-util/atomic-file"
import { createOrganizationClient } from "@ericsanchezok/synergy-sdk/organization"
import {
  OrganizationClientAuth as Auth,
  OrganizationDesktop as Desktop,
  OrganizationIdentity as Identity,
} from "@ericsanchezok/synergy-organization-protocol"
import { DesktopOrganizationError as Failure } from "./error.js"

export type OrganizationEncryption = {
  available(): Promise<boolean>
  encrypt(value: string): Promise<Buffer>
  decrypt(value: Buffer): Promise<string>
}
const tokens = Auth.Tokens.extend({ refreshToken: Identity.Token, refreshExpiresAt: z.number().int() })
type Tokens = z.infer<typeof tokens>
const profile = Desktop.Connection.omit({ state: true })
const record = profile
  .extend({
    version: z.literal(1),
    revision: z.uuid(),
    state: z.enum(["ready", "refreshing", "sign_out_pending", "signed_out"]),
    encrypted: z.string().min(1).max(32_768).optional(),
  })
  .refine((value) => (value.state === "signed_out" ? value.encrypted === undefined : value.encrypted !== undefined))
type Record = z.infer<typeof record>
const credential = Auth.Authority.extend({
  version: z.literal(1),
  clientID: Identity.ID,
  accountID: Identity.ID,
  refreshToken: Identity.Token,
  expiresAt: z.number().int(),
})
type Credential = z.infer<typeof credential>
type Access = { connection: Desktop.Connection; accessToken: string; expiresAt: number }

export function organizationConnectionID(input: { orgID: string; accountID: string; deploymentIncarnation: string }) {
  return createHash("sha256")
    .update(JSON.stringify([input.orgID, input.accountID, input.deploymentIncarnation]))
    .digest("hex")
}

function connection(value: Record): Desktop.Connection {
  return {
    id: value.id,
    revision: value.revision,
    issuer: value.issuer,
    orgID: value.orgID,
    deploymentIncarnation: value.deploymentIncarnation,
    clientID: value.clientID,
    account: value.account,
    state: value.state === "refreshing" ? "reauthorization_required" : value.state,
  }
}

function bound(a: Credential, b: z.infer<typeof profile>) {
  return (
    a.issuer === b.issuer &&
    a.orgID === b.orgID &&
    a.deploymentIncarnation === b.deploymentIncarnation &&
    a.clientID === b.clientID &&
    a.accountID === b.account.accountID
  )
}

function validateTokens(input: unknown, expected?: z.infer<typeof profile>): Tokens {
  const parsed = tokens.safeParse(input)
  if (!parsed.success) throw new Failure("invalid_response")
  const value = parsed.data
  if (
    value.account.orgID !== value.orgID ||
    value.account.state !== "active" ||
    value.expiresAt <= Date.now() ||
    value.refreshExpiresAt <= Date.now() ||
    value.expiresAt > value.refreshExpiresAt
  )
    throw new Failure("invalid_response")
  if (
    expected &&
    !bound({ ...value, version: 1, accountID: value.account.accountID, expiresAt: value.refreshExpiresAt }, expected)
  )
    throw new Failure("identity_changed")
  return value
}

export class DesktopOrganizationAccounts {
  private queues = new Map<string, Promise<unknown>>()
  private epochs = new Map<string, number>()
  private blocked = new Set<string>()
  private cache = new Map<string, Access>()
  private rotations = new Map<string, { controller: AbortController; result: Promise<Access> }>()
  private signouts = new Map<string, { requestID: string; result: Promise<Desktop.Connection> }>()
  private disposed = false

  constructor(private options: { root: string; encryption: OrganizationEncryption; fetch?: typeof fetch }) {
    if (!path.isAbsolute(options.root)) throw new Failure("invalid_request")
  }

  async list(): Promise<Desktop.Connection[]> {
    const entries = await fs.readdir(this.options.root).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return []
      throw new Failure("storage_unavailable")
    })
    const ids = entries.filter((entry) => /^[a-f0-9]{64}\.json$/.test(entry)).sort()
    if (ids.length > 1000) throw new Failure("storage_unavailable")
    return Promise.all(
      ids.map((name) => this.queue(name.slice(0, -5), async () => connection(await this.required(name.slice(0, -5))))),
    )
  }

  async accept(input: unknown, current: () => boolean = () => true): Promise<Desktop.Connection> {
    const value = validateTokens(input)
    const id = organizationConnectionID({ ...value, accountID: value.account.accountID })
    const epoch = this.epochs.get(id) ?? 0
    const valid = () => !this.disposed && current() && (this.epochs.get(id) ?? 0) === epoch
    const encrypted = await this.seal(value)
    return this.queue(id, async () => {
      if (!valid()) throw new Failure("cancelled")
      const previous = await this.read(id)
      if (previous && (previous.issuer !== value.issuer || previous.clientID !== value.clientID))
        throw new Failure("identity_changed")
      if (previous?.state === "sign_out_pending") throw new Failure("revocation_pending")
      const next: Record = {
        id,
        issuer: value.issuer,
        orgID: value.orgID,
        deploymentIncarnation: value.deploymentIncarnation,
        clientID: value.clientID,
        account: value.account,
        version: 1,
        revision: randomUUID(),
        state: "ready",
        encrypted,
      }
      await this.write(next)
      if (!valid()) {
        await this.write(previous ?? { ...next, state: "signed_out", encrypted: undefined })
        throw new Failure("cancelled")
      }
      this.blocked.delete(id)
      const result = connection(next)
      this.cache.set(id, { connection: result, accessToken: value.accessToken, expiresAt: value.expiresAt })
      return result
    })
  }

  async access(id: string): Promise<Access> {
    this.check(id)
    const saved = this.cache.get(id)
    if (saved && saved.expiresAt > Date.now() + 10_000) return saved
    const running = this.rotations.get(id)
    if (running) return running.result
    const controller = new AbortController()
    const result = this.rotate(id, controller.signal).finally(() => {
      if (this.rotations.get(id)?.result === result) this.rotations.delete(id)
    })
    this.rotations.set(id, { controller, result })
    return result
  }

  signOut(input: Desktop.SignOut): Promise<Desktop.Connection> {
    const parsed = Desktop.SignOut.safeParse(input)
    if (!parsed.success) return Promise.reject(new Failure("invalid_request"))
    const request = Object.freeze(parsed.data)
    const id = request.connectionID
    if (request.phase === "prepare") return this.prepareSignOut(request)
    const running = this.signouts.get(id)
    if (running)
      return running.requestID === request.requestID
        ? running.result
        : Promise.reject(new Failure("connection_changed"))
    const result = this.revoke(request).finally(() => {
      if (this.signouts.get(id)?.result === result) this.signouts.delete(id)
    })
    this.signouts.set(id, { requestID: request.requestID, result })
    return result
  }

  private block(id: string) {
    this.blocked.add(id)
    this.epochs.set(id, (this.epochs.get(id) ?? 0) + 1)
    this.cache.delete(id)
    this.rotations.get(id)?.controller.abort()
  }

  private prepareSignOut(request: Desktop.SignOut): Promise<Desktop.Connection> {
    return this.queue(request.connectionID, async () => {
      if (this.disposed) throw new Failure("cancelled")
      const saved = await this.required(request.connectionID)
      if (
        saved.revision === request.requestID &&
        (saved.state === "sign_out_pending" || saved.state === "signed_out")
      ) {
        this.block(saved.id)
        return connection(saved)
      }
      if (
        saved.revision !== request.expectedRevision ||
        saved.state === "sign_out_pending" ||
        saved.state === "signed_out"
      )
        throw new Failure("connection_changed")
      this.block(saved.id)
      const pending: Record = { ...saved, state: "sign_out_pending", revision: request.requestID }
      await this.write(pending)
      return connection(pending)
    })
  }

  dispose() {
    this.disposed = true
    this.cache.clear()
    for (const rotation of this.rotations.values()) rotation.controller.abort()
  }

  async settle() {
    await Promise.allSettled([...this.queues.values()])
  }

  private async rotate(id: string, signal: AbortSignal): Promise<Access> {
    const start = await this.queue(id, async () => {
      this.check(id)
      const saved = await this.required(id)
      if (saved.state === "signed_out" || saved.state === "sign_out_pending") throw new Failure("signed_out")
      if (saved.state !== "ready") throw new Failure("reauthorization_required")
      const secret = await this.unseal(saved)
      if (secret.expiresAt <= Date.now()) throw new Failure("reauthorization_required")
      this.check(id)
      const intent: Record = { ...saved, state: "refreshing", revision: randomUUID() }
      // RFC 9700 §4.14.2: an uncertain rotation must never replay the old refresh token.
      // https://www.rfc-editor.org/rfc/rfc9700.html#section-4.14.2
      await this.write(intent)
      return { intent, secret }
    })
    try {
      this.check(id)
      const response = await this.client(start.intent.issuer).orgAuth.refresh(
        {
          orgTokenRefreshInput: this.revocationInput(start.secret),
        },
        { signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]) },
      )
      this.check(id)
      if (!response.response.ok) throw new Failure("reauthorization_required")
      const next = validateTokens(response.data, start.intent)
      const encrypted = await this.seal(next)
      return await this.queue(id, async () => {
        this.check(id)
        const saved = await this.required(id)
        if (saved.revision !== start.intent.revision || saved.state !== "refreshing") throw new Failure("cancelled")
        const ready: Record = { ...saved, account: next.account, state: "ready", revision: randomUUID(), encrypted }
        await this.write(ready)
        this.check(id)
        const result = { connection: connection(ready), accessToken: next.accessToken, expiresAt: next.expiresAt }
        this.cache.set(id, result)
        return result
      })
    } catch {
      this.check(id)
      throw new Failure("reauthorization_required")
    }
  }

  private async revoke(request: Desktop.SignOut): Promise<Desktop.Connection> {
    const id = request.connectionID
    const saved = await this.queue(id, async () => {
      if (this.disposed) throw new Failure("cancelled")
      const saved = await this.required(id)
      if (
        request.expectedRevision !== request.requestID ||
        saved.revision !== request.requestID ||
        (saved.state !== "sign_out_pending" && saved.state !== "signed_out")
      )
        throw new Failure("connection_changed")
      this.block(id)
      return saved
    })
    if (saved.state === "signed_out") return connection(saved)
    try {
      const secret = await this.unseal(saved)
      const response = await this.client(saved.issuer).orgAuth.revoke(
        { orgClientRevocationInput: this.revocationInput(secret) },
        {
          signal: AbortSignal.timeout(30_000),
        },
      )
      if (
        response.response.status !== 401 &&
        (!response.response.ok || !Identity.Success.safeParse(response.data).success)
      )
        throw new Failure("revocation_pending")
      return await this.queue(id, async () => {
        const latest = await this.required(id)
        if (latest.revision !== saved.revision || latest.state !== "sign_out_pending")
          throw new Failure("revocation_pending")
        const signedOut: Record = { ...latest, state: "signed_out", encrypted: undefined }
        await this.write(signedOut)
        return connection(signedOut)
      })
    } catch {
      throw new Failure("revocation_pending")
    }
  }

  private client(issuer: string) {
    return createOrganizationClient({
      baseUrl: issuer,
      fetch: this.options.fetch,
      credentials: "omit",
      redirect: "error",
      referrerPolicy: "no-referrer",
    })
  }

  private revocationInput(value: Credential): Auth.Revoke {
    return {
      issuer: value.issuer,
      orgID: value.orgID,
      deploymentIncarnation: value.deploymentIncarnation,
      clientID: value.clientID,
      refreshToken: value.refreshToken,
    }
  }

  private check(id: string) {
    if (!Identity.Token.safeParse(id).success) throw new Failure("invalid_request")
    if (this.disposed) throw new Failure("cancelled")
    if (this.blocked.has(id)) throw new Failure("signed_out")
  }

  private async seal(value: Tokens) {
    try {
      if (!(await this.options.encryption.available())) throw new Failure("credentials_unavailable")
      const sealed: Credential = {
        version: 1,
        issuer: value.issuer,
        orgID: value.orgID,
        deploymentIncarnation: value.deploymentIncarnation,
        accountID: value.account.accountID,
        clientID: value.clientID,
        refreshToken: value.refreshToken,
        expiresAt: value.refreshExpiresAt,
      }
      return (await this.options.encryption.encrypt(JSON.stringify(sealed))).toString("base64")
    } catch {
      throw new Failure("credentials_unavailable")
    }
  }

  private async unseal(saved: Record): Promise<Credential> {
    try {
      if (!(await this.options.encryption.available())) throw new Failure("credentials_unavailable")
      const value = credential.parse(
        JSON.parse(await this.options.encryption.decrypt(Buffer.from(saved.encrypted!, "base64"))),
      )
      if (!bound(value, saved)) throw new Failure("credentials_invalid")
      return value
    } catch (error) {
      if (error instanceof Failure) throw error
      throw new Failure("credentials_invalid")
    }
  }

  private async required(id: string) {
    const value = await this.read(id)
    if (!value) throw new Failure("signed_out")
    return value
  }

  private async read(id: string): Promise<Record | undefined> {
    try {
      const file = await fs.open(
        path.join(this.options.root, `${id}.json`),
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      )
      try {
        const stat = await file.stat()
        if (!stat.isFile() || stat.size > 65_536) throw new Failure("storage_unavailable")
        const buffer = Buffer.alloc(65_537)
        const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
        if (bytesRead > 65_536) throw new Failure("storage_unavailable")
        const value = record.parse(JSON.parse(buffer.subarray(0, bytesRead).toString("utf8")))
        if (
          value.id !== id ||
          value.id !== organizationConnectionID({ ...value, accountID: value.account.accountID }) ||
          value.account.orgID !== value.orgID
        )
          throw new Failure("storage_unavailable")
        return value
      } finally {
        await file.close()
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
      throw new Failure("storage_unavailable")
    }
  }

  private async write(value: Record) {
    try {
      await AtomicFile.writeJsonAtomic(
        path.join(this.options.root, `${value.id}.json`),
        JSON.stringify(record.parse(value)),
        { private: true, durable: true },
      )
    } catch {
      throw new Failure("storage_unavailable")
    }
  }

  private queue<T>(id: string, run: () => Promise<T>): Promise<T> {
    const next = (this.queues.get(id) ?? Promise.resolve()).catch(() => {}).then(run)
    this.queues.set(id, next)
    void next
      .finally(() => {
        if (this.queues.get(id) === next) this.queues.delete(id)
      })
      .catch(() => {})
    return next
  }
}
