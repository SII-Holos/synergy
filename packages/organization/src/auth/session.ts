import { OrganizationRecord as Record } from "../storage/records"
import { OrganizationStoragePath as Keys } from "../storage/path"
import { digest, matches } from "./secret"
import { fail } from "../error"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { OrganizationProtocol } from "@ericsanchezok/synergy-organization-protocol"
import { ClientPolicy } from "./client-policy"
import type { OrganizationApiTokenProtocol } from "@ericsanchezok/synergy-organization-protocol"
import { authenticateApiToken } from "./api-token-session"

export type Credentials = {
  token: string
  csrf?: string
  kind?: "access" | "api"
  origin?: string
  apiOperation?: OrganizationApiTokenProtocol.Operation
}

export async function revokeAccessLogin(credentials: Credentials) {
  const access = await Record.read(Record.ClientAccess, Keys.clientAccess(digest(credentials.token)))
  if (!access) return
  const grant = await Record.read(Record.ClientGrant, Keys.clientGrant(access.grantID))
  if (!grant) return
  const deployment = OrganizationProtocol.Deployment.parse(await Storage.read(Keys.deployment()))
  if (
    grant.issuer !== ClientPolicy.issuer() ||
    grant.orgID !== deployment.orgID ||
    grant.deploymentIncarnation !== deployment.deploymentIncarnation
  )
    return
  if (credentials.origin) ClientPolicy.checkOrigin(ClientPolicy.client(grant.clientID), credentials.origin)
  const revokedAt = Date.now()
  if (grant.revokedAt === undefined) await Storage.write(Keys.clientGrant(grant.grantID), { ...grant, revokedAt })
  const login = await Record.read(Record.Login, Keys.login(grant.loginHash))
  if (login && login.revokedAt === undefined) await Storage.write(Keys.login(login.tokenHash), { ...login, revokedAt })
}

export async function authenticateClientGrant(grantID: string, origin?: string) {
  const grant = await Record.read(Record.ClientGrant, Keys.clientGrant(grantID))
  if (!grant || grant.revokedAt || grant.expiresAt <= Date.now())
    fail("AUTHENTICATION_REQUIRED", "Sign in to the organization")
  const client = ClientPolicy.client(grant.clientID)
  const deployment = OrganizationProtocol.Deployment.parse(await Storage.read(Keys.deployment()))
  if (
    grant.clientHash !== ClientPolicy.fingerprint(client) ||
    grant.issuer !== ClientPolicy.issuer() ||
    grant.orgID !== deployment.orgID ||
    grant.deploymentIncarnation !== deployment.deploymentIncarnation
  )
    fail("AUTHENTICATION_REQUIRED", "Sign in to the organization")
  ClientPolicy.checkOrigin(client, origin)
  const result = await authenticateLogin(grant.loginHash)
  return { ...result, grant, client }
}

export async function authenticate(credentials: Credentials) {
  if (credentials.kind === "api") return authenticateApiToken(credentials.token, credentials.apiOperation)
  return authenticateHuman(credentials)
}

export async function authenticateHuman(credentials: Credentials) {
  if (credentials.kind === "api") fail("PERMISSION_DENIED", "Use an organization sign-in session")
  if (credentials.kind === "access") {
    const access = await Record.read(Record.ClientAccess, Keys.clientAccess(digest(credentials.token)))
    if (!access || access.expiresAt <= Date.now()) fail("AUTHENTICATION_REQUIRED", "Sign in to the organization")
    const result = await authenticateClientGrant(access.grantID, credentials.origin)
    return {
      account: result.account,
      login: result.login,
      expiresAt: Math.min(access.expiresAt, result.login.expiresAt),
      clientKind: result.client.kind,
    }
  }
  const result = await authenticateLogin(digest(credentials.token))
  if (credentials.csrf !== undefined && !matches(credentials.csrf, result.login.csrfHash))
    fail("PERMISSION_DENIED", "Invalid request token")
  return { ...result, expiresAt: result.login.expiresAt, clientKind: "web" as const }
}

export async function authenticateLogin(hash: string) {
  const [raw] = await Storage.readMany<unknown>([Keys.login(hash)])
  const parsed = Record.Login.safeParse(raw)
  if (!parsed.success || parsed.data.tokenHash !== hash) fail("AUTHENTICATION_REQUIRED", "Sign in to the organization")
  const login = parsed.data
  const deployment = OrganizationProtocol.Deployment.parse(await Storage.read(Keys.deployment()))
  if (
    login.orgID !== deployment.orgID ||
    login.deploymentIncarnation !== deployment.deploymentIncarnation ||
    login.revokedAt ||
    login.expiresAt <= Date.now()
  )
    fail("AUTHENTICATION_REQUIRED", "Sign in to the organization")
  const account = await Record.read(Record.Account, Keys.account(login.accountID))
  if (
    !account ||
    account.orgID !== login.orgID ||
    account.state !== "active" ||
    account.authRevision !== login.authRevision
  )
    fail("AUTHENTICATION_REQUIRED", "Sign in to the organization")
  return { account, login }
}

export async function account(id: string, orgID?: string) {
  const value = await Record.read(Record.Account, Keys.account(id))
  if (!value || (orgID !== undefined && value.orgID !== orgID)) fail("NOT_FOUND", "Account not found")
  return value
}
