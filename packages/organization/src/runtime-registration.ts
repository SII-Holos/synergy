import { RuntimeRegistrationSettings } from "./config-schema"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import {
  OrganizationIdentity as Identity,
  OrganizationProtocol,
  OrganizationRuntimeProtocol as Runtime,
} from "@ericsanchezok/synergy-organization-protocol"
import { authorize, runtimeView } from "./authorization"
import { account, type Credentials } from "./auth/session"
import { token, digest } from "./auth/secret"
import { OrganizationRecord as Record } from "./storage/records"
import { OrganizationStoragePath as Keys } from "./storage/path"
import { fail, revision } from "./error"

export function createRuntimeRegistrations(
  options: RuntimeRegistrationSettings = {},
  onRevoke?: (runtimeID: string) => void,
) {
  const settings = RuntimeRegistrationSettings.parse(options)
  return {
    async member(credentials: Credentials, input: Runtime.MemberRegistration) {
      return Storage.transaction(async () => {
        const { account } = await authorize(credentials, "runtimes.register")
        const deployment = OrganizationProtocol.Deployment.parse(await Storage.read(Keys.deployment()))
        const existing = await Record.read(Record.RuntimeIndex, Keys.runtimeDevice(account.accountID, input.deviceID))
        const runtime = existing
          ? await Record.read(Record.RuntimeRegistration, Keys.runtime(existing.runtimeID))
          : Record.RuntimeRegistration.parse({
              schemaVersion: 1,
              runtimeID: crypto.randomUUID(),
              orgID: account.orgID,
              deploymentIncarnation: deployment.deploymentIncarnation,
              runtimeKind: "member",
              accountID: account.accountID,
              deviceID: input.deviceID,
              publicKey: input.publicKey,
              state: "pending",
              revision: 1,
              connectionEpoch: 0,
              createdAt: Date.now(),
            })
        if (!runtime) fail("SERVICE_UNAVAILABLE", "Runtime registration is inconsistent")
        if (
          runtime.publicKey !== input.publicKey ||
          runtime.state === "revoked" ||
          runtime.deploymentIncarnation !== deployment.deploymentIncarnation
        )
          fail("REVISION_CONFLICT", "This device already has another or revoked Runtime registration", runtime.revision)
        const publicRuntime = runtimeView(account, runtime, "runtime.read")
        if (!existing) {
          await Storage.write(Keys.runtime(runtime.runtimeID), runtime)
          await Storage.write(Keys.runtimeDevice(account.accountID, input.deviceID), { runtimeID: runtime.runtimeID })
          await Storage.write(Keys.accountRuntime(account.accountID, runtime.runtimeID), {
            runtimeID: runtime.runtimeID,
          })
        }
        const secret = token()
        const expiresAt = Date.now() + settings.ticketMs
        await Storage.write(
          Keys.runtimeTicket(digest(secret)),
          Record.RuntimeTicket.parse({
            schemaVersion: 1,
            tokenHash: digest(secret),
            runtimeID: runtime.runtimeID,
            accountID: account.accountID,
            authRevision: account.authRevision,
            registrationRevision: runtime.revision,
            expiresAt,
          }),
        )
        return { token: secret, expiresAt, runtime: publicRuntime }
      })
    },
    async consume(input: Runtime.ConsumeTicket) {
      return Storage.transaction(async () => {
        const hash = digest(input.token)
        const ticket = await Record.read(Record.RuntimeTicket, Keys.runtimeTicket(hash))
        if (!ticket) fail("AUTHENTICATION_REQUIRED", "Invalid Runtime registration ticket")
        const runtime = await Record.read(Record.RuntimeRegistration, Keys.runtime(ticket.runtimeID))
        const deployment = OrganizationProtocol.Deployment.parse(await Storage.read(Keys.deployment()))
        if (
          !runtime ||
          input.proof.ticketHash !== hash ||
          input.proof.runtimeID !== runtime.runtimeID ||
          input.proof.orgID !== deployment.orgID ||
          input.proof.deploymentIncarnation !== deployment.deploymentIncarnation ||
          runtime.orgID !== deployment.orgID ||
          runtime.deploymentIncarnation !== deployment.deploymentIncarnation ||
          !(await Runtime.verify(input.proof, input.signature, runtime.publicKey))
        )
          fail("AUTHENTICATION_REQUIRED", "Invalid Runtime registration proof")
        if (ticket.consumed) return ticket.consumed
        const member = await account(ticket.accountID, runtime.orgID)
        if (ticket.expiresAt <= Date.now() || member.state !== "active" || member.authRevision !== ticket.authRevision)
          fail("AUTHENTICATION_REQUIRED", "Runtime registration ticket is no longer valid")
        if (runtime.state === "revoked") fail("PERMISSION_DENIED", "Runtime registration is revoked")
        revision(ticket.registrationRevision, runtime.revision)
        const next =
          runtime.state === "pending"
            ? { ...runtime, state: "active" as const, revision: runtime.revision + 1 }
            : runtime
        const result = runtimeView(member, next, "runtime.read")
        await Storage.write(Keys.runtime(runtime.runtimeID), next)
        await Storage.write(Keys.runtimeTicket(hash), { ...ticket, consumed: result })
        return result
      })
    },
    async get(credentials: Credentials, runtimeID: string) {
      return Storage.snapshot(async () => (await authorize(credentials, "runtime.read", { runtimeID })).view)
    },
    async list(credentials: Credentials, page: Identity.Page) {
      return Storage.snapshot(async () => {
        const { account } = await authorize(credentials, "runtimes.list")
        const prefix = account.role === "member" ? Keys.accountRuntimes(account.accountID) : Keys.runtimes()
        const entries = await Storage.query({
          prefix,
          after: page.cursor ? [...prefix, page.cursor] : undefined,
          limit: page.limit + 1,
        })
        const ids = entries.slice(0, page.limit).map((entry) => entry.key.at(-1)!)
        const records = await Storage.readMany(ids.map(Keys.runtime))
        const items = records.map((value) =>
          runtimeView(account, Record.RuntimeRegistration.parse(value), "runtime.read"),
        )
        return { items, cursor: entries.length > page.limit ? items.at(-1)?.runtimeID : undefined }
      })
    },
    async revoke(credentials: Credentials, runtimeID: string, expectedRevision: number) {
      return Storage.transaction(async () => {
        const { account, runtime } = await authorize(credentials, "runtime.revoke", { runtimeID })
        revision(expectedRevision, runtime.revision)
        if (runtime.state === "revoked") return runtimeView(account, runtime, "runtime.read")
        const updated = Record.RuntimeRegistration.parse({
          ...runtime,
          state: "revoked",
          revision: runtime.revision + 1,
        })
        await Storage.write(Keys.runtime(runtimeID), updated)
        Storage.afterCommit(() => onRevoke?.(runtimeID))
        return runtimeView(account, updated, "runtime.read")
      })
    },
  }
}

export type RuntimeRegistrations = ReturnType<typeof createRuntimeRegistrations>
