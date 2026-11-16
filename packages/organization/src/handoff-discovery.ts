import { z } from "zod"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { WorkspaceContent } from "@ericsanchezok/synergy-harness/workspace/content"
import {
  OrganizationHandoffProtocol as Handoff,
  OrganizationIdentity as Identity,
} from "@ericsanchezok/synergy-organization-protocol"
import { OrganizationRecord as Record } from "./storage/records"
import { OrganizationStoragePath as Keys } from "./storage/path"
import { projectView } from "./authorization"
import { OrganizationError, fail } from "./error"
import { assertRuntimeConnection, runtimeAuthority } from "./runtime-authority"
import type { RuntimeConnections } from "./runtime-connection"
import type { StoredRecord } from "@ericsanchezok/synergy-harness/storage/transactional-store"

const Position = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("accounts"), after: Identity.ID.optional() }),
  z.strictObject({ kind: z.literal("devices"), accountID: Identity.ID, after: Identity.ID.optional() }),
  z.strictObject({ kind: z.literal("hosted"), after: Identity.ID.optional() }),
])
type Position = z.infer<typeof Position>
const Scope = z.strictObject({
  accountID: Identity.ID,
  orgID: Identity.ID,
  deploymentIncarnation: Identity.ID,
  projectID: Identity.ID,
  sessionID: Identity.ID,
  sourceRuntimeID: Identity.ID,
  bindingEpoch: z.number().int().positive().safe(),
  controlRevision: Identity.Revision,
  shareGeneration: Identity.Revision,
})
const Cursor = Scope.extend({ version: z.literal(1), position: Position })
type Context = {
  account: z.infer<typeof Identity.Account>
  session: Record.SessionDirectory
  project: z.infer<typeof Record.Project>
  source: Record.RuntimeRegistration
  connections: RuntimeConnections
  signal: AbortSignal
}

function position(value: string | undefined, scope: z.infer<typeof Scope>): Position {
  if (!value) return { kind: "accounts" }
  let cursor: z.infer<typeof Cursor>
  try {
    if (Buffer.from(value, "base64url").toString("base64url") !== value) throw new Error("Invalid cursor encoding")
    cursor = Cursor.parse(JSON.parse(Buffer.from(value, "base64url").toString("utf8")))
  } catch {
    fail("INVALID_REQUEST", "Handoff destination cursor is invalid")
  }
  const { version: _, position: selected, ...original } = cursor
  if (JSON.stringify(original) !== JSON.stringify(scope))
    fail("STALE_BINDING", "Handoff destinations changed; start from the first page")
  return selected
}

async function member(context: Context, accountID: string) {
  if (context.session.shareState !== "shared" && accountID !== context.session.creatorID) return
  const [account, membership] = await Promise.all([
    Record.read(Record.Account, Keys.account(accountID)),
    Record.read(Record.ProjectMember, Keys.projectMember(context.session.projectID, accountID)),
  ])
  if (!account || !membership) return
  try {
    projectView(account, context.project, membership, "project.execute")
  } catch (error) {
    if (error instanceof OrganizationError && ["PERMISSION_DENIED", "NOT_FOUND"].includes(error.data.code)) return
    throw error
  }
  return account
}

async function availability(
  context: Context,
  runtime: Record.RuntimeRegistration,
): Promise<Handoff.Target["availability"]> {
  if (runtime.state !== "active") return "offline"
  try {
    const connection = context.connections.captureHandoff(runtime.runtimeID)
    const authority = await runtimeAuthority({
      runtimeID: runtime.runtimeID,
      orgID: runtime.orgID,
      deploymentIncarnation: runtime.deploymentIncarnation,
      connectionEpoch: connection.handshake.connectionEpoch,
    })
    assertRuntimeConnection(authority.runtime, connection.handshake)
    if (authority.runtime.publicKey !== runtime.publicKey) fail("STALE_CONNECTION", "Handoff destination key changed")
    connection.assertCurrent()
    return connection.handshake.schemas.handoffs >= 4 ? "ready" : "incompatible"
  } catch (error) {
    if (error instanceof OrganizationError && error.data.code === "RUNTIME_OFFLINE") return "offline"
    if (error instanceof OrganizationError && error.data.code === "PROTOCOL_MISMATCH") return "incompatible"
    throw error
  }
}

export async function listHandoffTargets(context: Context, input: Handoff.TargetsQuery): Promise<Handoff.TargetPage> {
  const assert = WorkspaceContent.captureOwner(context.signal)
  assert()
  const query = Handoff.TargetsQuery.parse(input)
  const scope = Scope.parse({
    accountID: context.account.accountID,
    orgID: context.session.orgID,
    deploymentIncarnation: context.source.deploymentIncarnation,
    projectID: context.session.projectID,
    sessionID: context.session.sessionID,
    sourceRuntimeID: context.source.runtimeID,
    bindingEpoch: context.session.bindingEpoch,
    controlRevision: context.session.controlRevision,
    shareGeneration: context.session.shareGeneration,
  })
  let next: Position | undefined = position(query.cursor, scope)
  const items: Handoff.Target[] = []
  for (let scanned = 0; next && scanned < query.limit * 4 && items.length < query.limit; scanned++) {
    assert()
    if (next.kind === "accounts") {
      const prefix = Keys.projectMembers(scope.projectID)
      const [row]: StoredRecord[] = await Storage.query({
        prefix,
        after: next.after ? [...prefix, next.after] : undefined,
        limit: 1,
      })
      if (!row) {
        next = { kind: "hosted" }
        continue
      }
      const membership: z.infer<typeof Record.ProjectMember> = Record.parse(Record.ProjectMember, row.key, row.value)
      if (row.key.length !== 4 || row.key.at(-1) !== membership.accountID || membership.projectID !== scope.projectID)
        fail("SERVICE_UNAVAILABLE", "Handoff project participant index is inconsistent")
      next = (await member(context, membership.accountID))
        ? { kind: "devices", accountID: membership.accountID }
        : { kind: "accounts", after: membership.accountID }
      continue
    }
    const account = next.kind === "devices" ? await member(context, next.accountID) : undefined
    if (next.kind === "devices" && !account) {
      next = { kind: "accounts", after: next.accountID }
      continue
    }
    const prefix: string[] =
      next.kind === "devices" ? Keys.accountRuntimes(next.accountID) : ["organization", "hosted-runtimes"]
    const [row]: StoredRecord[] = await Storage.query({
      prefix,
      after: next.after ? [...prefix, next.after] : undefined,
      limit: 1,
    })
    if (!row) {
      next = next.kind === "devices" ? { kind: "accounts", after: next.accountID } : undefined
      continue
    }
    const entry = Record.RuntimeIndex.parse(row.value)
    if (row.key.length !== prefix.length + 1 || row.key.at(-1) !== entry.runtimeID)
      fail("SERVICE_UNAVAILABLE", "Handoff destination index is inconsistent")
    const runtime: Record.RuntimeRegistration | undefined = await Record.read(
      Record.RuntimeRegistration,
      Keys.runtime(entry.runtimeID),
    )
    if (
      !runtime ||
      runtime.runtimeID !== entry.runtimeID ||
      runtime.orgID !== scope.orgID ||
      runtime.deploymentIncarnation !== scope.deploymentIncarnation ||
      (next.kind === "devices"
        ? runtime.runtimeKind !== "member" || runtime.accountID !== next.accountID
        : runtime.runtimeKind !== "hosted")
    )
      fail("SERVICE_UNAVAILABLE", "Handoff destination index belongs to another Runtime")
    next = { ...next, after: runtime.runtimeID }
    if (runtime.runtimeID === scope.sourceRuntimeID) continue
    const observed = await availability(context, runtime)
    assert()
    items.push(
      Handoff.Target.parse({
        runtimeID: runtime.runtimeID,
        runtimeKind: runtime.runtimeKind,
        state: runtime.state,
        availability: observed,
        ...(runtime.runtimeKind === "member"
          ? { accountID: runtime.accountID, deviceID: runtime.deviceID, displayName: account?.displayName }
          : { name: runtime.name }),
      }),
    )
  }
  assert()
  return Handoff.TargetPage.parse({
    sessionID: scope.sessionID,
    sourceRuntimeID: scope.sourceRuntimeID,
    bindingEpoch: scope.bindingEpoch,
    controlRevision: scope.controlRevision,
    shareGeneration: scope.shareGeneration,
    items,
    ...(next
      ? { cursor: Buffer.from(JSON.stringify({ ...scope, version: 1, position: next })).toString("base64url") }
      : {}),
  })
}
