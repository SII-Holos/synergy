import {
  OrganizationApiTokenProtocol as Protocol,
  OrganizationProtocol,
  OrganizationCommandProtocol as Command,
} from "@ericsanchezok/synergy-organization-protocol"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { OrganizationRecord as Record } from "../storage/records"
import { OrganizationStoragePath as Keys } from "../storage/path"
import { ApiTokenRecord, ApiTokenIndex, apiTokenKeys } from "./api-token-record"
import { digest } from "./secret"
import { fail } from "../error"

export async function authenticateApiToken(secret: string, operation?: Protocol.Operation) {
  if (!operation) fail("PERMISSION_DENIED", "API tokens cannot use this operation")
  const hash = digest(secret)
  const index = await Record.read(ApiTokenIndex, apiTokenKeys.hash(hash))
  const token = index ? await Record.read(ApiTokenRecord, apiTokenKeys.record(index.tokenID)) : undefined
  const deployment = OrganizationProtocol.Deployment.parse(await Storage.read(Keys.deployment()))
  if (
    !token ||
    token.tokenHash !== hash ||
    token.revokedAt !== undefined ||
    token.expiresAt <= Date.now() ||
    token.orgID !== deployment.orgID ||
    token.deploymentIncarnation !== deployment.deploymentIncarnation
  )
    fail("AUTHENTICATION_REQUIRED", "The API token is no longer valid")
  if (!token.operations.includes(operation)) fail("PERMISSION_DENIED", "The API token does not allow this operation")
  const account = await Record.read(Record.Account, Keys.account(token.accountID))
  if (
    !account ||
    account.state !== "active" ||
    account.orgID !== token.orgID ||
    account.authRevision !== token.authRevision
  )
    fail("AUTHENTICATION_REQUIRED", "The API token is no longer valid")
  return { account, expiresAt: token.expiresAt, clientKind: "api" as const, apiToken: token, tokenID: token.tokenID }
}

export async function assertApiExecutionActor(permit: Command.Permit) {
  const actor = permit.actor
  if (actor.clientKind !== "api" || !actor.tokenID)
    fail("PERMISSION_DENIED", "Execution has no original API token actor")
  const token = await Record.read(ApiTokenRecord, apiTokenKeys.record(actor.tokenID))
  const account = await Record.read(Record.Account, Keys.account(actor.subjectID))
  const deployment = OrganizationProtocol.Deployment.parse(await Storage.read(Keys.deployment()))
  if (
    !token ||
    !account ||
    token.tokenID !== actor.tokenID ||
    token.accountID !== actor.subjectID ||
    token.orgID !== permit.orgID ||
    token.orgID !== account.orgID ||
    token.deploymentIncarnation !== permit.deploymentIncarnation ||
    token.deploymentIncarnation !== deployment.deploymentIncarnation ||
    token.orgID !== deployment.orgID ||
    token.revokedAt !== undefined ||
    token.expiresAt <= Date.now() ||
    account.state !== "active" ||
    token.authRevision !== account.authRevision ||
    permit.authRevision !== account.authRevision
  )
    fail("PERMISSION_DENIED", "The original execution API token is no longer valid")
  const operation =
    permit.operation === "input" ? "sessions.input" : permit.operation === "continue" ? "sessions.continue" : undefined
  if (!operation || !token.operations.includes(operation))
    fail("PERMISSION_DENIED", "The API token cannot continue this execution")
  assertApiTokenAction(token, operation, "session.execute", permit.projectID)
}

export function assertApiTokenAction(
  token: ApiTokenRecord,
  operation: Protocol.Operation | undefined,
  action: string,
  projectID?: string,
) {
  if (projectID !== undefined && projectID !== token.projectID)
    fail("PERMISSION_DENIED", "The API token belongs to a different project")
  if (operation === undefined) fail("PERMISSION_DENIED", "The API token has no operation context")
  const actions = ["organization.read", "project.read", "session.read"]
  if (operation === "sessions.create") actions.push("project.execute", "session.execute")
  if (operation === "sessions.configure") actions.push("session.execute", "resource.read", "resource.use")
  if (operation === "sessions.input" || operation === "sessions.continue") actions.push("session.execute")
  if (operation === "sessions.pause" || operation === "sessions.cancel" || operation === "sessions.reply")
    actions.push("session.stop")
  if (!actions.includes(action)) fail("PERMISSION_DENIED", "The API token cannot authorize this action")
}
