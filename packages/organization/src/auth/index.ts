import { z } from "zod"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { OrganizationIdentity as Identity, OrganizationProtocol } from "@ericsanchezok/synergy-organization-protocol"
import { OrganizationStoragePath as Keys } from "../storage/path"
import { OrganizationRecord as Record } from "../storage/records"
import { fail, revision } from "../error"
import { createPasswordHasher } from "./password"
import { token, digest, fingerprint, matches } from "./secret"

export const AuthenticationSettings = z.strictObject({
  bootstrapMs: z
    .number()
    .int()
    .positive()
    .default(30 * 60_000),
  inviteMs: z
    .number()
    .int()
    .positive()
    .default(7 * 24 * 60 * 60_000),
  resetMs: z
    .number()
    .int()
    .positive()
    .default(30 * 60_000),
  loginMs: z
    .number()
    .int()
    .positive()
    .default(30 * 24 * 60 * 60_000),
  hashConcurrency: z.number().int().min(1).max(16).default(2),
})
export type AuthenticationSettings = z.input<typeof AuthenticationSettings>
export type Credentials = { token: string; csrf?: string }

export async function authenticate(credentials: Credentials) {
  const login = await Record.read(Record.Login, Keys.login(digest(credentials.token)))
  if (!login || login.revokedAt || login.expiresAt <= Date.now())
    fail("AUTHENTICATION_REQUIRED", "Sign in to the organization")
  const account = await Record.read(Record.Account, Keys.account(login.accountID))
  if (!account || account.state !== "active" || account.authRevision !== login.authRevision)
    fail("AUTHENTICATION_REQUIRED", "Sign in to the organization")
  if (credentials.csrf !== undefined && !matches(credentials.csrf, login.csrfHash))
    fail("PERMISSION_DENIED", "Invalid request token")
  return { account, login }
}

export async function account(id: string) {
  const value = await Record.read(Record.Account, Keys.account(id))
  if (!value) fail("NOT_FOUND", "Account not found")
  return value
}

export function requireAdministrator(value: Identity.Account) {
  if (value.state !== "active" || value.role === "member")
    fail("PERMISSION_DENIED", "Organization administrator access is required")
}

async function info() {
  const value = await Record.read(Record.Info, Keys.info())
  if (!value) fail("NOT_FOUND", "Organization is not initialized")
  return value
}

function checkConsumption(
  value: { expiresAt: number; consumed?: { requestID: string; fingerprint: string; accountID: string } },
  requestID: string,
  hash: string,
) {
  if (value.consumed) {
    if (value.consumed.requestID !== requestID || value.consumed.fingerprint !== hash)
      fail("TOKEN_CONSUMED", "This link has already been used")
    return value.consumed.accountID
  }
  if (value.expiresAt <= Date.now()) fail("AUTHENTICATION_REQUIRED", "This link has expired")
}

export async function createAuthentication(options: AuthenticationSettings = {}) {
  const settings = AuthenticationSettings.parse(options)
  const passwords = await createPasswordHasher(settings.hashConcurrency)
  async function createAccount(
    input: { loginName: string; displayName: string },
    passwordHash: string,
    role: Identity.Account["role"],
  ) {
    const key = Keys.loginName(digest(input.loginName))
    if (await Record.read(Record.LoginIndex, key)) fail("LOGIN_NAME_TAKEN", "The login name is already in use")
    const deployment = OrganizationProtocol.Deployment.parse(await Storage.read(Keys.deployment()))
    const value = Record.Account.parse({
      schemaVersion: 1,
      accountID: crypto.randomUUID(),
      orgID: deployment.orgID,
      loginName: input.loginName,
      displayName: input.displayName,
      passwordHash,
      role,
      state: "active",
      revision: 1,
      authRevision: 1,
      createdAt: Date.now(),
    })
    await Storage.write(Keys.account(value.accountID), value)
    await Storage.write(key, { accountID: value.accountID })
    return Record.publicAccount(value)
  }

  return {
    async bootstrapToken() {
      return Storage.transaction(async () => {
        if (await Record.read(Record.Info, Keys.info()))
          fail("ALREADY_INITIALIZED", "Organization is already initialized")
        const secret = token()
        await Storage.write(
          Keys.bootstrap(),
          Record.Bootstrap.parse({
            schemaVersion: 1,
            tokenHash: digest(secret),
            expiresAt: Date.now() + settings.bootstrapMs,
          }),
        )
        return secret
      })
    },
    async bootstrap(input: Identity.Bootstrap) {
      const hash = fingerprint(input.token, [
        input.requestID,
        input.organizationName,
        input.loginName,
        input.displayName,
        input.password,
      ])
      const passwordHash = await passwords.hash(input.password)
      return Storage.transaction(async () => {
        const boot = await Record.read(Record.Bootstrap, Keys.bootstrap())
        if (!boot || !matches(input.token, boot.tokenHash))
          fail("AUTHENTICATION_REQUIRED", "Invalid initialization token")
        const previous = checkConsumption(boot, input.requestID, hash)
        if (previous) return boot.consumed!.result
        if (await Record.read(Record.Info, Keys.info()))
          fail("ALREADY_INITIALIZED", "Organization is already initialized")
        const owner = await createAccount(input, passwordHash, "owner")
        await Storage.write(
          Keys.info(),
          Record.Info.parse({
            schemaVersion: 1,
            orgID: owner.orgID,
            name: input.organizationName,
            owners: [owner.accountID],
            revision: 1,
          }),
        )
        await Storage.write(Keys.bootstrap(), {
          ...boot,
          consumed: { requestID: input.requestID, fingerprint: hash, accountID: owner.accountID, result: owner },
        })
        return owner
      })
    },
    async login(input: Identity.Login) {
      const indexed = await Record.read(Record.LoginIndex, Keys.loginName(digest(input.loginName)))
      const value = indexed ? await account(indexed.accountID) : undefined
      const valid = await passwords.verify(input.password, value?.passwordHash)
      if (!value || !valid || value.state !== "active")
        fail("AUTHENTICATION_REQUIRED", "Invalid login name or password")
      return Storage.transaction(async () => {
        const current = await account(value.accountID)
        if (
          current.state !== "active" ||
          current.authRevision !== value.authRevision ||
          current.passwordHash !== value.passwordHash
        )
          fail("AUTHENTICATION_REQUIRED", "Account changed; sign in again")
        const secret = token()
        const csrfToken = fingerprint(secret, ["csrf"])
        const login = Record.Login.parse({
          schemaVersion: 1,
          tokenHash: digest(secret),
          csrfHash: digest(csrfToken),
          accountID: current.accountID,
          authRevision: current.authRevision,
          expiresAt: Date.now() + settings.loginMs,
        })
        await Storage.write(Keys.login(login.tokenHash), login)
        return { token: secret, account: Record.publicAccount(current), csrfToken, expiresAt: login.expiresAt }
      })
    },
    async current(credentials: Credentials) {
      return Storage.snapshot(async () => {
        const { account, login } = await authenticate(credentials)
        return {
          account: Record.publicAccount(account),
          csrfToken: fingerprint(credentials.token, ["csrf"]),
          expiresAt: login.expiresAt,
        }
      })
    },
    async logout(credentials: Credentials) {
      await Storage.transaction(async () => {
        const { login } = await authenticate(credentials)
        await Storage.write(Keys.login(login.tokenHash), { ...login, revokedAt: Date.now() })
      })
      return { ok: true as const }
    },
    async password(credentials: Credentials, input: Identity.PasswordChange) {
      const original = await Storage.snapshot(async () => (await authenticate(credentials)).account)
      if (!(await passwords.verify(input.currentPassword, original.passwordHash)))
        fail("AUTHENTICATION_REQUIRED", "Invalid password")
      const passwordHash = await passwords.hash(input.password)
      await Storage.transaction(async () => {
        const { account } = await authenticate(credentials)
        if (account.authRevision !== original.authRevision)
          fail("AUTHENTICATION_REQUIRED", "Account changed; sign in again")
        await Storage.write(Keys.account(account.accountID), {
          ...account,
          passwordHash,
          revision: account.revision + 1,
          authRevision: account.authRevision + 1,
        })
      })
      return { ok: true as const }
    },
    async invite(credentials: Credentials, input: Identity.InviteCreate) {
      return Storage.transaction(async () => {
        const { account } = await authenticate(credentials)
        requireAdministrator(account)
        const secret = token()
        const invite = Record.Invite.parse({
          schemaVersion: 1,
          tokenHash: digest(secret),
          createdBy: account.accountID,
          issuerAuthRevision: account.authRevision,
          role: input.role,
          expiresAt: Date.now() + settings.inviteMs,
        })
        await Storage.write(Keys.invite(invite.tokenHash), invite)
        return { token: secret, expiresAt: invite.expiresAt }
      })
    },
    async consumeInvite(input: Identity.InviteConsume) {
      const hash = fingerprint(input.token, [input.requestID, input.loginName, input.displayName, input.password])
      const passwordHash = await passwords.hash(input.password)
      return Storage.transaction(async () => {
        const invite = await Record.read(Record.Invite, Keys.invite(digest(input.token)))
        if (!invite || invite.revokedAt) fail("AUTHENTICATION_REQUIRED", "Invalid invitation")
        const previous = checkConsumption(invite, input.requestID, hash)
        if (previous) return invite.consumed!.result
        const issuer = await account(invite.createdBy)
        requireAdministrator(issuer)
        if (issuer.authRevision !== invite.issuerAuthRevision)
          fail("AUTHENTICATION_REQUIRED", "Invitation is no longer valid")
        const joined = await createAccount(input, passwordHash, invite.role)
        await Storage.write(Keys.invite(invite.tokenHash), {
          ...invite,
          consumed: { requestID: input.requestID, fingerprint: hash, accountID: joined.accountID, result: joined },
        })
        return joined
      })
    },
    async organization(credentials: Credentials) {
      return Storage.snapshot(async () => {
        await authenticate(credentials)
        const value = await info()
        return { orgID: value.orgID, name: value.name, revision: value.revision }
      })
    },
    async accounts(credentials: Credentials, page: Identity.Page) {
      return Storage.snapshot(async () => {
        const { account } = await authenticate(credentials)
        requireAdministrator(account)
        const entries = await Storage.query({
          prefix: Keys.accounts(),
          after: page.cursor ? Keys.account(page.cursor) : undefined,
          limit: page.limit + 1,
        })
        const items = entries
          .slice(0, page.limit)
          .map((entry) => Record.publicAccount(Record.Account.parse(entry.value)))
        return { items, cursor: entries.length > page.limit ? items.at(-1)?.accountID : undefined }
      })
    },
    async updateAccount(credentials: Credentials, id: string, input: Identity.AccountChange) {
      return Storage.transaction(async () => {
        const { account: actor } = await authenticate(credentials)
        const target = await account(id)
        const managing = input.role !== undefined || input.state !== undefined
        if (managing || actor.accountID !== target.accountID) requireAdministrator(actor)
        if (managing && (target.role === "owner" || input.role === "owner") && actor.role !== "owner")
          fail("PERMISSION_DENIED", "Only an owner can change ownership")
        revision(input.expectedRevision, target.revision)
        if (target.state !== "active") fail("REVISION_CONFLICT", "Removed accounts cannot be changed", target.revision)
        const changed = Record.Account.parse({
          ...target,
          role: input.role ?? target.role,
          state: input.state ?? target.state,
          displayName: input.displayName ?? target.displayName,
          revision: target.revision + 1,
          authRevision: target.authRevision + (managing ? 1 : 0),
        })
        const organization = await info()
        const owners = organization.owners.filter((owner) => owner !== id)
        if (changed.role === "owner" && changed.state === "active") owners.push(id)
        if (!owners.length) fail("LAST_OWNER", "The last owner cannot leave, be removed or lose ownership")
        await Storage.write(Keys.account(id), changed)
        await Storage.write(Keys.info(), { ...organization, owners, revision: organization.revision + 1 })
        return Record.publicAccount(changed)
      })
    },
    async transferOwner(credentials: Credentials, input: Identity.TransferOwner) {
      return Storage.transaction(async () => {
        const { account: actor } = await authenticate(credentials)
        if (actor.role !== "owner") fail("PERMISSION_DENIED", "Only an owner can transfer ownership")
        const target = await account(input.accountID)
        const organization = await info()
        revision(input.expectedRevision, organization.revision)
        revision(input.targetRevision, target.revision)
        if (target.state !== "active" || target.accountID === actor.accountID)
          fail("REVISION_CONFLICT", "Select another active account")
        await Storage.write(Keys.account(actor.accountID), {
          ...actor,
          role: "admin",
          authRevision: actor.authRevision + 1,
          revision: actor.revision + 1,
        })
        await Storage.write(Keys.account(target.accountID), {
          ...target,
          role: "owner",
          authRevision: target.authRevision + 1,
          revision: target.revision + 1,
        })
        const owners = [...new Set([...organization.owners.filter((id) => id !== actor.accountID), target.accountID])]
        await Storage.write(Keys.info(), { ...organization, owners, revision: organization.revision + 1 })
        return { ok: true as const }
      })
    },
    async createReset(credentials: Credentials, id: string, expectedRevision: number) {
      return Storage.transaction(async () => {
        const { account: actor } = await authenticate(credentials)
        requireAdministrator(actor)
        const target = await account(id)
        if (target.state !== "active") fail("NOT_FOUND", "Active account not found")
        if (target.role === "owner" && actor.role !== "owner")
          fail("PERMISSION_DENIED", "Only an owner can reset an owner account")
        revision(expectedRevision, target.revision)
        const secret = token()
        const reset = Record.Reset.parse({
          schemaVersion: 1,
          tokenHash: digest(secret),
          createdBy: actor.accountID,
          issuerAuthRevision: actor.authRevision,
          accountID: id,
          authRevision: target.authRevision,
          expiresAt: Date.now() + settings.resetMs,
        })
        await Storage.write(Keys.reset(reset.tokenHash), reset)
        return { token: secret, expiresAt: reset.expiresAt }
      })
    },
    async consumeReset(input: Identity.ResetConsume) {
      const hash = fingerprint(input.token, [input.requestID, input.password])
      const passwordHash = await passwords.hash(input.password)
      await Storage.transaction(async () => {
        const reset = await Record.read(Record.Reset, Keys.reset(digest(input.token)))
        if (!reset) fail("AUTHENTICATION_REQUIRED", "Invalid reset link")
        if (checkConsumption(reset, input.requestID, hash)) return
        const issuer = await account(reset.createdBy)
        requireAdministrator(issuer)
        const target = await account(reset.accountID)
        if (
          issuer.authRevision !== reset.issuerAuthRevision ||
          target.state !== "active" ||
          target.authRevision !== reset.authRevision
        )
          fail("AUTHENTICATION_REQUIRED", "Reset link is no longer valid")
        await Storage.write(Keys.account(target.accountID), {
          ...target,
          passwordHash,
          authRevision: target.authRevision + 1,
          revision: target.revision + 1,
        })
        await Storage.write(Keys.reset(reset.tokenHash), {
          ...reset,
          consumed: { requestID: input.requestID, fingerprint: hash, accountID: target.accountID },
        })
      })
      return { ok: true as const }
    },
  }
}

export type Authentication = Awaited<ReturnType<typeof createAuthentication>>
