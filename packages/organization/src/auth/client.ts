import { createHash } from "node:crypto"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { OrganizationClientAuth as Protocol, OrganizationProtocol } from "@ericsanchezok/synergy-organization-protocol"
import { OrganizationRecord as Record } from "../storage/records"
import { OrganizationStoragePath as Keys } from "../storage/path"
import { fail } from "../error"
import { ClientPolicy } from "./client-policy"
import { ClientAuthenticationSettings } from "../config-schema"
import { authenticateHuman, authenticateClientGrant, authenticateLogin, type Credentials } from "./session"
import { digest, token } from "./secret"

export function createClientAuthentication(options: ClientAuthenticationSettings = {}, issuer?: string) {
  const settings = ClientAuthenticationSettings.parse(options)
  ClientPolicy.configure(issuer, settings.clients)

  async function authority(input?: { issuer: string; orgID: string; deploymentIncarnation: string }) {
    const deployment = OrganizationProtocol.Deployment.parse(await Storage.read(Keys.deployment()))
    const result = {
      issuer: ClientPolicy.issuer(),
      orgID: deployment.orgID,
      deploymentIncarnation: deployment.deploymentIncarnation,
    }
    if (
      input &&
      (input.issuer !== result.issuer ||
        input.orgID !== result.orgID ||
        input.deploymentIncarnation !== result.deploymentIncarnation)
    )
      fail("AUTHENTICATION_REQUIRED", "The organization identity changed; sign in again")
    return result
  }

  async function mint(grant: Record.ClientGrant, account: Record.Account, client: Protocol.Client) {
    const accessToken = token()
    const expiresAt = Math.min(grant.expiresAt, Date.now() + settings.accessMs)
    const access = Record.ClientAccess.parse({
      schemaVersion: 1,
      tokenHash: digest(accessToken),
      grantID: grant.grantID,
      expiresAt,
    })
    await Storage.write(Keys.clientAccess(access.tokenHash), access)
    const refreshToken = client.kind === "desktop" ? token() : undefined
    if (refreshToken) {
      const refresh = Record.ClientRefresh.parse({
        schemaVersion: 1,
        tokenHash: digest(refreshToken),
        grantID: grant.grantID,
        expiresAt: grant.expiresAt,
      })
      await Storage.write(Keys.clientRefresh(refresh.tokenHash), refresh)
    }
    return Protocol.Tokens.parse({
      issuer: grant.issuer,
      orgID: grant.orgID,
      deploymentIncarnation: grant.deploymentIncarnation,
      clientID: grant.clientID,
      account: Record.publicAccount(account),
      tokenType: "Bearer",
      accessToken,
      expiresAt,
      ...(refreshToken ? { refreshToken, refreshExpiresAt: grant.expiresAt } : {}),
    })
  }

  return {
    async discovery(clientID: string) {
      return Storage.snapshot(async () => ({
        ...(await authority()),
        client: ClientPolicy.client(clientID),
        codeChallengeMethod: "S256" as const,
      }))
    },
    async authorize(credentials: Credentials, input: Protocol.Authorize) {
      if (credentials.kind === "access") fail("PERMISSION_DENIED", "Authorize using the organization sign-in session")
      return Storage.transaction(async () => {
        const identity = await authority(input)
        const { login } = await authenticateHuman(credentials)
        const client = ClientPolicy.client(input.clientID)
        if (input.redirectUri !== client.redirectUri) fail("PERMISSION_DENIED", "The client callback is not registered")
        const code = token()
        const expiresAt = Math.min(login.expiresAt, Date.now() + settings.codeMs)
        const record = Record.AuthorizationCode.parse({
          ...input,
          schemaVersion: 1,
          tokenHash: digest(code),
          clientHash: ClientPolicy.fingerprint(client),
          loginHash: login.tokenHash,
          expiresAt,
        })
        await Storage.write(Keys.authorizationCode(record.tokenHash), record)
        return Protocol.Code.parse({
          ...identity,
          clientID: client.clientID,
          redirectUri: client.redirectUri,
          state: input.state,
          code,
          expiresAt,
        })
      })
    },
    async exchange(input: Protocol.Exchange, origin?: string) {
      return Storage.transaction(async () => {
        const identity = await authority(input)
        const code = await Record.read(Record.AuthorizationCode, Keys.authorizationCode(digest(input.code)))
        const client = ClientPolicy.client(input.clientID)
        // Provenance: RFC 7636 §4.6, https://www.rfc-editor.org/rfc/rfc7636.html#section-4.6
        // The code is consumed atomically only after the S256 proof and current login are verified.
        if (
          !code ||
          code.consumedAt !== undefined ||
          code.expiresAt <= Date.now() ||
          code.clientID !== client.clientID ||
          code.redirectUri !== input.redirectUri ||
          client.redirectUri !== input.redirectUri ||
          code.clientHash !== ClientPolicy.fingerprint(client) ||
          code.issuer !== identity.issuer ||
          code.orgID !== identity.orgID ||
          code.deploymentIncarnation !== identity.deploymentIncarnation ||
          code.codeChallenge !== createHash("sha256").update(input.verifier).digest("base64url")
        )
          fail("AUTHENTICATION_REQUIRED", "The authorization code is invalid or expired")
        ClientPolicy.checkOrigin(client, origin)
        const { account, login } = await authenticateLogin(code.loginHash)
        const grant = Record.ClientGrant.parse({
          ...identity,
          schemaVersion: 1,
          grantID: crypto.randomUUID(),
          clientID: client.clientID,
          clientHash: code.clientHash,
          loginHash: code.loginHash,
          expiresAt: Math.min(
            login.expiresAt,
            Date.now() + (client.kind === "desktop" ? settings.refreshMs : settings.accessMs),
          ),
        })
        await Storage.write(Keys.authorizationCode(code.tokenHash), { ...code, consumedAt: Date.now() })
        await Storage.write(Keys.clientGrant(grant.grantID), grant)
        return mint(grant, account, client)
      })
    },
    async revoke(input: Protocol.Revoke, origin?: string) {
      if (origin !== undefined) fail("PERMISSION_DENIED", "Desktop revocation does not accept browser origins")
      await Storage.transaction(async () => {
        await authority(input)
        const refresh = await Record.read(Record.ClientRefresh, Keys.clientRefresh(digest(input.refreshToken)))
        if (!refresh) return
        const grant = await Record.read(Record.ClientGrant, Keys.clientGrant(refresh.grantID))
        if (
          !grant ||
          grant.clientID !== input.clientID ||
          grant.issuer !== input.issuer ||
          grant.orgID !== input.orgID ||
          grant.deploymentIncarnation !== input.deploymentIncarnation
        )
          return
        // Provenance: RFC 7009 §2, https://www.rfc-editor.org/rfc/rfc7009.html#section-2
        // Consumed tokens can revoke their originating login without replaying an uncertain rotation.
        const revokedAt = Date.now()
        if (grant.revokedAt === undefined) await Storage.write(Keys.clientGrant(grant.grantID), { ...grant, revokedAt })
        const login = await Record.read(Record.Login, Keys.login(grant.loginHash))
        if (login && login.revokedAt === undefined)
          await Storage.write(Keys.login(login.tokenHash), { ...login, revokedAt })
      })
      return { ok: true as const }
    },
    async refresh(input: Protocol.Refresh, origin?: string) {
      const result = await Storage.transaction(async () => {
        await authority(input)
        const refresh = await Record.read(Record.ClientRefresh, Keys.clientRefresh(digest(input.refreshToken)))
        if (!refresh || refresh.expiresAt <= Date.now())
          fail("AUTHENTICATION_REQUIRED", "The refresh token is invalid or expired")
        const { grant, account, client } = await authenticateClientGrant(refresh.grantID, origin)
        if (client.kind !== "desktop" || input.clientID !== client.clientID)
          fail("AUTHENTICATION_REQUIRED", "The client does not match this authorization")
        // Provenance: RFC 9700 §4.14.2, https://www.rfc-editor.org/rfc/rfc9700.html#section-4.14.2
        // Commit family revocation before reporting replay; throwing inside the transaction would roll it back.
        if (refresh.consumedAt !== undefined) {
          await Storage.write(Keys.clientGrant(grant.grantID), { ...grant, revokedAt: Date.now() })
          return undefined
        }
        await Storage.write(Keys.clientRefresh(refresh.tokenHash), { ...refresh, consumedAt: Date.now() })
        return mint(grant, account, client)
      })
      if (!result) fail("AUTHENTICATION_REQUIRED", "The refresh token was already used; sign in again")
      return result
    },
  }
}

export type ClientAuthentication = ReturnType<typeof createClientAuthentication>
