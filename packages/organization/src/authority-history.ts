import { createHash } from "node:crypto"
import { AuthorityJournal } from "@ericsanchezok/synergy-harness/storage/authority-journal"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import type { TransactionOptions } from "@ericsanchezok/synergy-harness/storage/transactional-store"
import type { Migration } from "@ericsanchezok/synergy-harness/migration/types"
import { ActorStamp } from "@ericsanchezok/synergy-util/actor-stamp"
import { JsonValue } from "@ericsanchezok/synergy-util/json-value"
import { OrganizationProtocol } from "@ericsanchezok/synergy-organization-protocol"
import { authenticate, type Credentials } from "./auth/session"
import { OrganizationRecord as Record } from "./storage/records"
import { OrganizationStoragePath as Keys } from "./storage/path"
import { ApiTokenRecord } from "./auth/api-token-record"
import { upgradeSigningIdentityForAuthorityHistory } from "./signing"

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex")

export namespace OrganizationAuthorityHistory {
  export function register() {
    AuthorityJournal.register({
      id: "organization-authority",
      version: 1,
      prefixes: [
        Keys.info(),
        Keys.accounts(),
        Keys.projects(),
        ["organization", "project-members"],
        ["organization", "resources"],
        ["organization", "resource-secrets"],
        ["organization", "resource-grants"],
        Keys.sessions(),
        ["organization", "session-resources"],
        Keys.runtimes(),
        ["organization-api-tokens", "records"],
      ],
      project(key, value) {
        const kind = key[0] === "organization-api-tokens" ? "api-token" : key[1]
        switch (kind) {
          case "info": {
            const info = Record.Info.parse(value)
            return {
              orgID: info.orgID,
              ownersHash: digest([...info.owners].sort()),
              ownerCount: info.owners.length,
              revision: info.revision,
            }
          }
          case "accounts": {
            const account = Record.Account.parse(value)
            return {
              accountID: account.accountID,
              orgID: account.orgID,
              role: account.role,
              state: account.state,
              authRevision: account.authRevision,
              revision: account.revision,
              passwordHash: digest(account.passwordHash),
            }
          }
          case "projects": {
            const project = Record.Project.parse(value)
            return {
              projectID: project.projectID,
              orgID: project.orgID,
              state: project.state,
              revision: project.revision,
            }
          }
          case "project-members":
            return JsonValue.parse(Record.ProjectMember.parse(value))
          case "resources": {
            const resource = Record.Resource.parse(value)
            return {
              resourceID: resource.resourceID,
              orgID: resource.orgID,
              scope: resource.scope,
              state: resource.state,
              revision: resource.revision,
              configurationHash: digest(resource.configuration),
              credentialHash: digest([resource.credential, resource.secretID]),
            }
          }
          case "resource-secrets": {
            const secret = Record.ResourceSecret.parse(value)
            return { resourceID: secret.resourceID, orgID: secret.orgID, credentialHash: digest(secret.credential) }
          }
          case "resource-grants":
            return JsonValue.parse(Record.ResourceGrant.parse(value))
          case "sessions": {
            const session = Record.parse(Record.SessionDirectory, [...key], value)
            return {
              sessionID: session.sessionID,
              orgID: session.orgID,
              projectID: session.projectID,
              creatorID: session.creatorID,
              driverRuntimeID: session.driverRuntimeID,
              bindingEpoch: session.bindingEpoch,
              nextBindingEpoch: session.nextBindingEpoch,
              shareState: session.shareState,
              shareGeneration: session.shareGeneration,
              controlRevision: session.controlRevision,
              resourceIDs: session.resourceIDs,
              handoffID: session.handoffID ?? null,
            }
          }
          case "session-resources":
            return JsonValue.parse(Record.SessionResources.parse(value))
          case "runtimes": {
            const runtime = Record.RuntimeRegistration.parse(value)
            return {
              runtimeID: runtime.runtimeID,
              orgID: runtime.orgID,
              deploymentIncarnation: runtime.deploymentIncarnation,
              runtimeKind: runtime.runtimeKind,
              ownerID: runtime.runtimeKind === "member" ? runtime.accountID : runtime.createdBy,
              publicKey: runtime.publicKey,
              state: runtime.state,
              revision: runtime.revision,
            }
          }
          case "api-token": {
            const token = ApiTokenRecord.parse(value)
            return {
              tokenID: token.tokenID,
              orgID: token.orgID,
              accountID: token.accountID,
              projectID: token.projectID,
              operations: token.operations,
              authRevision: token.authRevision,
              revision: token.revision,
              deploymentIncarnation: token.deploymentIncarnation,
              expiresAt: token.expiresAt,
              revokedAt: token.revokedAt ?? null,
              credentialHash: digest(token.tokenHash),
            }
          }
          default:
            throw new Error("The organization authority projection has no canonical owner")
        }
      },
    })
  }

  export async function initialize(deployment: OrganizationProtocol.Deployment) {
    return AuthorityJournal.initialize({ namespaceID: deployment.orgID })
  }

  export async function attach(deployment: OrganizationProtocol.Deployment) {
    const head = await AuthorityJournal.head()
    const identity = await Record.read(Record.SigningIdentity, Keys.signingIdentity())
    if (
      head.namespaceID !== deployment.orgID ||
      head.contractHash !== AuthorityJournal.definition().hash ||
      identity?.historyContractHash !== head.contractHash
    )
      throw new Error("Organization signing authority history requires its owning recovery or migration")
  }

  export async function credentials<T>(
    credentials: Credentials,
    operation: string,
    body: () => Promise<T>,
    options?: TransactionOptions,
  ) {
    return AuthorityJournal.transaction(
      operation,
      async (journal) => {
        const current = await authenticate(credentials)
        journal.identify({
          kind: "account",
          orgID: current.account.orgID,
          subjectID: current.account.accountID,
          displayName: current.account.displayName,
          clientKind: current.clientKind,
          requestID: journal.actionID,
          ...("tokenID" in current ? { tokenID: current.tokenID } : {}),
        })
        return body()
      },
      options,
    )
  }

  export function system<T>(
    operation: string,
    body: (identify: (actor: ActorStamp.Info) => void, actionID: string) => Promise<T>,
    options?: TransactionOptions,
  ) {
    return AuthorityJournal.transaction(operation, (journal) => body(journal.identify, journal.actionID), options)
  }
}

export const organizationAuthorityMigration: Migration = {
  id: "20261111-organization-authority-history",
  description: "Establish a redacted authority-history baseline for controlled deployment recovery",
  scope: "global",
  execution: "startup",
  dependsOn: ["20261109-organization-signing-identity"],
  async up(progress) {
    if (!AuthorityJournal.selected()) return
    const deployment = OrganizationProtocol.Deployment.parse(await Storage.read(Keys.deployment()))
    await Storage.transaction(async () => {
      await upgradeSigningIdentityForAuthorityHistory(AuthorityJournal.definition().hash)
      await OrganizationAuthorityHistory.initialize(deployment)
    })
    progress(1, 1)
  },
}
