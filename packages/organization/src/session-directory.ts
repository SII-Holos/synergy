import { z } from "zod"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import {
  OrganizationIdentity as Identity,
  OrganizationSessionProtocol as Protocol,
  OrganizationRuntimeProtocol as Runtime,
} from "@ericsanchezok/synergy-organization-protocol"
import type { Credentials } from "./auth/session"
import { authorize, sessionView } from "./authorization"
import { OrganizationRecord as Record } from "./storage/records"
import { OrganizationStoragePath as Keys } from "./storage/path"
import { fail } from "./error"
import { OrganizationKnowledge } from "./knowledge"
import { OrganizationSharing } from "./sharing"

const Reservation = z.strictObject({ sessionID: Identity.ID, projectID: Identity.ID, runtimeID: Identity.ID })
type RuntimeStatusReader = (runtimeID: string) => Promise<z.infer<typeof Runtime.ConnectionStatus>>
const presentation = RuntimeContext.state(() => ({ runtimeStatus: undefined as RuntimeStatusReader | undefined }))

async function present(session: Record.SessionDirectory, view: Protocol.View) {
  const [runtime, shared, sync] = await Promise.all([
    Record.read(Record.RuntimeRegistration, Keys.runtime(session.driverRuntimeID)),
    session.shareState === "shared"
      ? Record.read(
          Record.SharedSession,
          Keys.sharedSession(session.sessionID, session.shareGeneration, session.sessionID),
        )
      : undefined,
    OrganizationSharing.describe(session),
  ])
  const availability =
    runtime && runtime.orgID === session.orgID
      ? ((await presentation().runtimeStatus?.(runtime.runtimeID)) ?? {
          runtimeID: runtime.runtimeID,
          state: "offline" as const,
          connectionEpoch: runtime.connectionEpoch,
          ...(runtime.lastSeen === undefined ? {} : { lastSeen: runtime.lastSeen }),
        })
      : undefined
  return Protocol.View.parse({
    ...view,
    sync,
    ...(shared?.projection.title === undefined ? {} : { title: shared.projection.title }),
    ...(shared?.projection.status === undefined ? {} : { status: shared.projection.status }),
    ...(availability && runtime
      ? {
          runtime: {
            ...availability,
            runtimeKind: runtime.runtimeKind,
            ...(runtime.runtimeKind === "member" ? { ownerID: runtime.accountID } : { name: runtime.name }),
          },
        }
      : {}),
  })
}

export namespace OrganizationSessionDirectory {
  export function registerRuntimeStatus(reader: RuntimeStatusReader) {
    RuntimeContext.assertCompositionOpen("Organization Session runtime presence")
    if (presentation().runtimeStatus) throw new Error("Organization Session runtime presence is already registered")
    presentation().runtimeStatus = reader
  }
  export async function reservePrivate(credentials: Credentials, input: z.infer<typeof Reservation>) {
    const request = Reservation.parse(input)
    return Storage.transaction(async () => {
      const { account } = await authorize(credentials, "project.execute", { projectID: request.projectID })
      const runtime = await Record.read(Record.RuntimeRegistration, Keys.runtime(request.runtimeID))
      if (
        !runtime ||
        runtime.runtimeID !== request.runtimeID ||
        runtime.orgID !== account.orgID ||
        (runtime.runtimeKind === "member" && runtime.accountID !== account.accountID)
      )
        fail("NOT_FOUND", "Runtime not found")
      if (runtime.state !== "active") fail("PERMISSION_DENIED", "Runtime registration is not active")
      if (await Record.read(Record.SessionDirectory, Keys.session(request.sessionID)))
        fail("REVISION_CONFLICT", "Session identity is already reserved")
      const directory = Record.SessionDirectory.parse({
        schemaVersion: 2,
        orgID: account.orgID,
        sessionID: request.sessionID,
        projectID: request.projectID,
        creatorID: account.accountID,
        driverRuntimeID: runtime.runtimeID,
        bindingEpoch: 1,
        nextBindingEpoch: 2,
        createdAt: Date.now(),
        shareState: "private",
        shareGeneration: 0,
        controlRevision: 0,
        rowRevision: 0,
        resourceIDs: [],
        retainedExecutionGrants: 0,
      })
      const index = Record.SessionIndex.parse({ sessionID: directory.sessionID })
      await Storage.write(Keys.session(directory.sessionID), directory)
      await Storage.write(Keys.creatorSession(directory.projectID, directory.creatorID, directory.sessionID), index)
      await Storage.write(Keys.visibleSession("private", directory.projectID, directory.sessionID), index)
      await OrganizationKnowledge.inheritSession(directory.sessionID)
      return directory
    })
  }

  export async function get(credentials: Credentials, sessionID: string) {
    return Storage.snapshot(async () => {
      const current = await authorize(credentials, "session.read", { sessionID })
      return present(current.session, current.view)
    })
  }

  export async function list(credentials: Credentials, projectID: string, page: Identity.Page) {
    return Storage.snapshot(async () => {
      const { account, view: project } = await authorize(credentials, "project.read", { projectID })
      const prefixes = [Keys.creatorSessions(projectID, account.accountID), Keys.sessionVisibility("shared", projectID)]
      const pages = await Promise.all(
        prefixes.map((prefix) =>
          Storage.query({
            prefix,
            after: page.cursor ? [...prefix, page.cursor] : undefined,
            limit: page.limit + 1,
          }),
        ),
      )
      const ids = [
        ...new Set(
          pages.flatMap((rows) =>
            rows.map((row) => {
              const index = Record.SessionIndex.parse(row.value)
              if (row.key.at(-1) !== index.sessionID)
                fail("SERVICE_UNAVAILABLE", "Session directory index is inconsistent")
              return index.sessionID
            }),
          ),
        ),
      ].sort()
      const selected = ids.slice(0, page.limit)
      const rows = await Storage.readMany(selected.map(Keys.session))
      const items = await Promise.all(
        rows.map(async (raw, index) => {
          const row = Record.parse(Record.SessionDirectory, Keys.session(selected[index]!), raw)
          if (row.sessionID !== selected[index] || row.projectID !== projectID)
            fail("SERVICE_UNAVAILABLE", "Session directory index is inconsistent")
          return present(row, sessionView(account, row, project, "session.read"))
        }),
      )
      return Protocol.Page.parse({ items, cursor: ids.length > page.limit ? selected.at(-1) : undefined })
    })
  }

  export async function capacity(credentials: Credentials) {
    return Storage.snapshot(async () => {
      await authorize(credentials, "sessions.capacity")
      const [privateSessions, sharedSessions] = await Promise.all([
        Storage.count({ prefix: Keys.sessionVisibility("private") }),
        Storage.count({ prefix: Keys.sessionVisibility("shared") }),
      ])
      return Protocol.Capacity.parse({ privateSessions, sharedSessions })
    })
  }
}
