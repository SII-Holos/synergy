import { AuthenticationSettings } from "../config-schema"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { OrganizationIdentity as Identity, OrganizationProtocol } from "@ericsanchezok/synergy-organization-protocol"
import { OrganizationStoragePath as Keys } from "../storage/path"
import { OrganizationRecord as Record } from "../storage/records"
import { fail, revision } from "../error"
import { createPasswordHasher } from "./password"
import { token, digest, fingerprint, matches } from "./secret"
import { authenticateHuman, account, revokeAccessLogin, type Credentials } from "./session"
import { authorize, requireAdministrator } from "../authorization"
import { OrganizationAuthorityHistory as History } from "../authority-history"
export type { Credentials } from "./session"

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

async function inviteView(invite: Record.Invite): Promise<Identity.Invite> {
  const issuer = await Record.read(Record.Account, Keys.account(invite.createdBy))
  const valid =
    issuer?.orgID === invite.orgID &&
    issuer.state === "active" &&
    issuer.role !== "member" &&
    issuer.authRevision === invite.issuerAuthRevision
  return Identity.Invite.parse({
    inviteID: invite.inviteID,
    createdBy: invite.createdBy,
    createdAt: invite.createdAt,
    expiresAt: invite.expiresAt,
    role: invite.role,
    revision: invite.revision,
    state: invite.consumed
      ? "consumed"
      : invite.revokedAt !== undefined
        ? "revoked"
        : invite.expiresAt <= Date.now()
          ? "expired"
          : valid
            ? "open"
            : "invalidated",
  })
}

export async function createAuthentication(
  options: AuthenticationSettings = {},
  onAccountRemoved?: (accountID: string) => void,
) {
  const settings = AuthenticationSettings.parse(options)
  const passwords = await createPasswordHasher(settings.hashConcurrency)
  async function changeAccount(target: Record.Account, input: Identity.AccountChange) {
    revision(input.expectedRevision, target.revision)
    if (target.state !== "active") fail("REVISION_CONFLICT", "Removed accounts cannot be changed", target.revision)
    const managing = input.role !== undefined || input.state !== undefined
    const changed = Record.Account.parse({
      ...target,
      role: input.role ?? target.role,
      state: input.state ?? target.state,
      displayName: input.displayName ?? target.displayName,
      revision: target.revision + 1,
      authRevision: target.authRevision + (managing ? 1 : 0),
    })
    const organization = await info()
    const owners = organization.owners.filter((owner) => owner !== target.accountID)
    if (changed.role === "owner" && changed.state === "active") owners.push(target.accountID)
    if (!owners.length) fail("LAST_OWNER", "The last owner cannot leave, be removed or lose ownership")
    await Storage.write(Keys.account(target.accountID), changed)
    if (changed.state === "removed") Storage.afterCommit(() => onAccountRemoved?.(target.accountID))
    await Storage.write(Keys.info(), { ...organization, owners, revision: organization.revision + 1 })
    return Record.publicAccount(changed)
  }
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
      return History.system("organization.bootstrap", async (identify) => {
        const boot = await Record.read(Record.Bootstrap, Keys.bootstrap())
        if (!boot || !matches(input.token, boot.tokenHash))
          fail("AUTHENTICATION_REQUIRED", "Invalid initialization token")
        const previous = checkConsumption(boot, input.requestID, hash)
        if (previous) return boot.consumed!.result
        if (await Record.read(Record.Info, Keys.info()))
          fail("ALREADY_INITIALIZED", "Organization is already initialized")
        const deployment = OrganizationProtocol.Deployment.parse(await Storage.read(Keys.deployment()))
        identify({
          kind: "system",
          orgID: deployment.orgID,
          subjectID: "organization-bootstrap",
          displayName: "Organization initialization",
          clientKind: "system",
          requestID: input.requestID,
        })
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
        const { account, expiresAt } = await authenticateHuman(credentials)
        return {
          account: Record.publicAccount(account),
          csrfToken: fingerprint(credentials.token, ["csrf"]),
          expiresAt,
        }
      })
    },
    async logout(credentials: Credentials) {
      await Storage.transaction(async () => {
        if (credentials.kind === "access") return revokeAccessLogin(credentials)
        const { login } = await authenticateHuman(credentials)
        await Storage.write(Keys.login(login.tokenHash), { ...login, revokedAt: Date.now() })
      })
      return { ok: true as const }
    },
    async password(credentials: Credentials, input: Identity.PasswordChange) {
      const original = await Storage.snapshot(async () => (await authenticateHuman(credentials)).account)
      if (!(await passwords.verify(input.currentPassword, original.passwordHash)))
        fail("AUTHENTICATION_REQUIRED", "Invalid password")
      const passwordHash = await passwords.hash(input.password)
      await History.credentials(credentials, "account.password", async () => {
        const { account } = await authenticateHuman(credentials)
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
        const { account } = await authorize(credentials, "invites.create")
        const secret = token()
        const invite = Record.Invite.parse({
          schemaVersion: 2,
          inviteID: crypto.randomUUID(),
          orgID: account.orgID,
          revision: 1,
          createdAt: Date.now(),
          tokenHash: digest(secret),
          createdBy: account.accountID,
          issuerAuthRevision: account.authRevision,
          role: input.role,
          expiresAt: Date.now() + settings.inviteMs,
        })
        await Storage.write(Keys.invite(invite.tokenHash), invite)
        const indexed = { tokenHash: invite.tokenHash }
        await Storage.write(Keys.inviteID(invite.orgID, invite.inviteID), indexed)
        await Storage.write(Keys.issuedInvite(invite.orgID, invite.createdBy, invite.inviteID), indexed)
        return { token: secret, expiresAt: invite.expiresAt }
      })
    },
    async invites(credentials: Credentials, page: Identity.Page) {
      return Storage.snapshot(async () => {
        const { account } = await authorize(credentials, "invites.list")
        const prefix =
          account.role === "member"
            ? Keys.issuedInvites(account.orgID, account.accountID)
            : Keys.inviteCatalog(account.orgID)
        const entries = await Storage.query({
          prefix,
          after: page.cursor ? [...prefix, page.cursor] : undefined,
          limit: page.limit + 1,
        })
        const items = await Promise.all(
          entries.slice(0, page.limit).map(async (entry) => {
            const index = Record.InviteIndex.parse(entry.value)
            const invite = await Record.read(Record.Invite, Keys.invite(index.tokenHash))
            if (
              !invite ||
              invite.orgID !== account.orgID ||
              invite.inviteID !== entry.key.at(-1) ||
              (account.role === "member" && invite.createdBy !== account.accountID)
            )
              fail("NOT_FOUND", "Invitation not found")
            return inviteView(invite)
          }),
        )
        return { items, cursor: entries.length > page.limit ? items.at(-1)?.inviteID : undefined }
      })
    },
    async revokeInvite(credentials: Credentials, inviteID: string, expectedRevision: number) {
      return Storage.transaction(async () => {
        const { invite } = await authorize(credentials, "invite.revoke", { inviteID })
        revision(expectedRevision, invite.revision)
        if (invite.consumed) fail("TOKEN_CONSUMED", "This invitation has already been used")
        if (invite.revokedAt !== undefined) return inviteView(invite)
        const changed = { ...invite, revokedAt: Date.now(), revision: invite.revision + 1 }
        await Storage.write(Keys.invite(invite.tokenHash), changed)
        return inviteView(changed)
      })
    },
    async consumeInvite(input: Identity.InviteConsume) {
      const hash = fingerprint(input.token, [input.requestID, input.loginName, input.displayName, input.password])
      const passwordHash = await passwords.hash(input.password)
      return History.system("account.join", async (identify) => {
        const invite = await Record.read(Record.Invite, Keys.invite(digest(input.token)))
        if (!invite || invite.revokedAt !== undefined) fail("AUTHENTICATION_REQUIRED", "Invalid invitation")
        const previous = checkConsumption(invite, input.requestID, hash)
        if (previous) return invite.consumed!.result
        const issuer = await account(invite.createdBy)
        if (issuer.orgID !== invite.orgID) fail("AUTHENTICATION_REQUIRED", "Invalid invitation")
        requireAdministrator(issuer)
        if (issuer.authRevision !== invite.issuerAuthRevision)
          fail("AUTHENTICATION_REQUIRED", "Invitation is no longer valid")
        identify({
          kind: "system",
          orgID: invite.orgID,
          subjectID: "organization-invitation",
          displayName: "Organization invitation",
          clientKind: "system",
          requestID: input.requestID,
          causedBy: [
            {
              kind: "account",
              orgID: issuer.orgID,
              subjectID: issuer.accountID,
              displayName: issuer.displayName,
              clientKind: "system",
              requestID: input.requestID,
            },
          ],
        })
        const joined = await createAccount(input, passwordHash, invite.role)
        await Storage.write(Keys.invite(invite.tokenHash), {
          ...invite,
          revision: invite.revision + 1,
          consumed: { requestID: input.requestID, fingerprint: hash, accountID: joined.accountID, result: joined },
        })
        return joined
      })
    },
    async organization(credentials: Credentials) {
      return Storage.snapshot(async () => {
        await authorize(credentials, "organization.read")
        const value = await info()
        return { orgID: value.orgID, name: value.name, revision: value.revision }
      })
    },
    async accounts(credentials: Credentials, page: Identity.Page) {
      return Storage.snapshot(async () => {
        await authorize(credentials, "accounts.list")
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
      return History.credentials(credentials, "account.update", async () => {
        const managing = input.role !== undefined || input.state !== undefined
        const action =
          input.role === "owner" ? "account.promote-owner" : managing ? "account.manage" : "account.profile"
        const { target } = await authorize(credentials, action, { accountID: id })
        return changeAccount(target, input)
      })
    },
    async leave(credentials: Credentials, expectedRevision: number) {
      return History.credentials(credentials, "account.leave", async () => {
        const { account } = await authorize(credentials, "organization.leave")
        await changeAccount(account, { expectedRevision, state: "removed" })
        return { ok: true as const }
      })
    },
    async transferOwner(credentials: Credentials, input: Identity.TransferOwner) {
      return History.credentials(credentials, "account.transfer-owner", async () => {
        const { account: actor, target } = await authorize(credentials, "account.transfer-owner", {
          accountID: input.accountID,
        })
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
        const { account: actor, target } = await authorize(credentials, "account.reset", { accountID: id })
        if (target.state !== "active") fail("NOT_FOUND", "Active account not found")
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
      await History.system("account.password-reset", async (identify) => {
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
        identify({
          kind: "system",
          orgID: target.orgID,
          subjectID: "organization-password-reset",
          displayName: "Organization password reset",
          clientKind: "system",
          requestID: input.requestID,
          causedBy: [
            {
              kind: "account",
              orgID: issuer.orgID,
              subjectID: issuer.accountID,
              displayName: issuer.displayName,
              clientKind: "system",
              requestID: input.requestID,
            },
          ],
        })
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
