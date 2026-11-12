import { expect, test } from "bun:test"
import { OrganizationHandoffProtocol as Handoff } from "@ericsanchezok/synergy-organization-protocol"
import { createOrganizationHandoffState, organizationHandoffOutcomeKnown } from "../../src/organization/handoff-state"

const prepare = Handoff.CurrentPrepare.parse({
  handoffID: "move-a",
  targetRuntimeID: "target",
  expectedBindingEpoch: 7,
  expectedControlRevision: 11,
  mappingPlanRevision: 1,
  workspaceMapping: { kind: "native" },
})
const completed = Handoff.View.parse({
  schemaVersion: 1,
  orgID: "org",
  deploymentIncarnation: "inc",
  handoffID: "move-b",
  sessionID: "session",
  sourceRuntimeID: "source",
  targetRuntimeID: "target",
  fromEpoch: 7,
  toEpoch: 8,
  mappingPlanRevision: 1,
  shareGeneration: 0,
  phase: "completed",
  initiator: "account",
  targetAccepted: true,
  cancelRequested: false,
  commandSeq: 3,
  missingRequirements: [],
  canCancel: false,
  canAccept: false,
  canContinue: true,
  currentDriver: "target",
  bindingEpoch: 8,
  workspaceMapping: { kind: "native" },
  mappingHash: "a".repeat(64),
})

test("another completed move cannot confirm the original unknown preparation", () => {
  expect(organizationHandoffOutcomeKnown({ kind: "prepare", body: prepare }, completed)).toBe(false)
})

test("a read cancellation intent acknowledges only its service request, including a surrender race", () => {
  const view = Handoff.View.parse({
    ...completed,
    handoffID: prepare.handoffID,
    phase: "prepared",
    currentDriver: "source",
    bindingEpoch: 7,
    canCancel: true,
    canContinue: false,
    cancelRequested: false,
  })
  expect(organizationHandoffOutcomeKnown({ kind: "cancel" }, view)).toBe(false)
  expect(organizationHandoffOutcomeKnown({ kind: "cancel" }, { ...view, cancelRequested: true })).toBe(true)
  expect(view.phase).toBe("prepared")
  expect(organizationHandoffOutcomeKnown({ kind: "cancel" }, { ...view, phase: "surrendered", canCancel: false })).toBe(
    true,
  )
})

test("reload retains the exact pending body and another account or incarnation cannot claim it", () => {
  const values = new Map<string, string>()
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value)
    },
    removeItem: (key: string) => {
      values.delete(key)
    },
  }
  const input = { storage, owner: '["organization","org","account","inc"]', projectID: "project", sessionID: "session" }
  createOrganizationHandoffState(input).save(prepare.handoffID, { kind: "prepare", body: prepare })
  const reloaded = createOrganizationHandoffState(input)
  expect(reloaded.read()?.pending).toEqual({ kind: "prepare", body: prepare })
  expect(() => reloaded.save("another-move")).toThrow("original")
  expect(() =>
    reloaded.save(prepare.handoffID, { kind: "prepare", body: { ...prepare, targetRuntimeID: "another-target" } }),
  ).toThrow("original")
  expect(
    createOrganizationHandoffState({ ...input, owner: '["organization","org","another-account","inc"]' }).read(),
  ).toBeUndefined()
  expect(
    createOrganizationHandoffState({ ...input, owner: '["organization","org","account","new-inc"]' }).read(),
  ).toBeUndefined()
  reloaded.confirmed(prepare.handoffID)
  expect(reloaded.read()?.pending).toBeUndefined()
  reloaded.clear(prepare.handoffID)
  expect(reloaded.read()).toBeUndefined()
})
