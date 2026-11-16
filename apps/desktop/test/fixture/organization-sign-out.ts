import { randomUUID } from "node:crypto"
import type { DesktopOrganizationAccounts } from "../../src/organization/accounts"

export async function prepareAccountSignOut(accounts: DesktopOrganizationAccounts, connectionID: string) {
  const connection = (await accounts.list()).find((value) => value.id === connectionID)
  if (!connection) throw new Error("Missing fixture connection")
  const requestID =
    connection.state === "sign_out_pending" || connection.state === "signed_out" ? connection.revision : randomUUID()
  return accounts.signOut({ connectionID, phase: "prepare", expectedRevision: connection.revision, requestID })
}
export async function signOutAccount(accounts: DesktopOrganizationAccounts, connectionID: string) {
  const prepared = await prepareAccountSignOut(accounts, connectionID)
  return accounts.signOut({
    connectionID,
    phase: "commit",
    expectedRevision: prepared.revision,
    requestID: prepared.revision,
  })
}
