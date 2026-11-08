import { OrganizationRecord as Record } from "../storage/records"
import { OrganizationStoragePath as Keys } from "../storage/path"
import { digest, matches } from "./secret"
import { fail } from "../error"

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

export async function account(id: string, orgID?: string) {
  const value = await Record.read(Record.Account, Keys.account(id))
  if (!value || (orgID !== undefined && value.orgID !== orgID)) fail("NOT_FOUND", "Account not found")
  return value
}
