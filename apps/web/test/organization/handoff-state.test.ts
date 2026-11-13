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
  const source = { kind: "drive" as const, body: { operation: "cancel-source" as const, requestID: "cancel" } }
  expect(organizationHandoffOutcomeKnown(source, { ...view, cancelRequested: true })).toBe(false)
  expect(organizationHandoffOutcomeKnown(source, { ...view, phase: "surrendered", canCancel: false })).toBe(true)
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

test("cancellation retains an unresolved native request through reload and acknowledges each original slot independently", () => {
  const values = new Map<string, string>()
  const input = {
    storage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => void values.set(key, value),
      removeItem: (key: string) => void values.delete(key),
    },
    owner: '["organization","org","account","inc"]',
    projectID: "project",
    sessionID: "session",
  }
  const native = {
    kind: "drive" as const,
    body: { operation: "prepare-source" as const, requestID: "original-native" },
  }
  const state = createOrganizationHandoffState(input)
  state.save(prepare.handoffID, native)
  state.cancel(prepare.handoffID, { kind: "cancel" })
  const reloaded = createOrganizationHandoffState(input)
  expect(reloaded.read()?.pending).toEqual(native)
  expect(reloaded.read()?.cancellation).toEqual({ kind: "cancel" })
  expect(() => reloaded.cancel("another-move", { kind: "cancel" })).toThrow("original")
  reloaded.cancelConfirmed(prepare.handoffID)
  expect(reloaded.read()?.pending).toEqual(native)
  expect(reloaded.read()?.cancellation).toBeUndefined()
  const cancel = { kind: "drive" as const, body: { operation: "cancel-source" as const, requestID: "original-cancel" } }
  reloaded.cancel(prepare.handoffID, cancel)
  expect(
    reloaded.cancel(prepare.handoffID, { ...cancel, body: { ...cancel.body, requestID: "replacement-cancel" } })
      .accepted,
  ).toBe(false)
  reloaded.confirmed(prepare.handoffID)
  expect(reloaded.read()?.pending).toBeUndefined()
  expect(reloaded.read()?.cancellation).toEqual(cancel)
  expect(() => reloaded.save("another-move")).toThrow("original")
  expect(
    createOrganizationHandoffState({ ...input, owner: '["organization","org","account","new-inc"]' }).read(),
  ).toBeUndefined()
  expect([...values.values()].join()).not.toContain("signature")
  const [key, raw] = [...values.entries()][0]
  values.set(key, JSON.stringify({ ...JSON.parse(raw), cancellation: { ...cancel, signature: "private-proof" } }))
  expect(() => reloaded.read()).toThrow()
  values.set(key, raw)
  reloaded.cancelConfirmed(prepare.handoffID)
  reloaded.clear(prepare.handoffID)
  expect(reloaded.read()).toBeUndefined()
})

test("an unsent cancellation reply cannot clear a newer or legacy unknown intent", () => {
  const values = new Map<string, string>()
  const input = {
    storage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => void values.set(key, value),
      removeItem: (key: string) => void values.delete(key),
    },
    owner: '["organization","org","account","inc"]',
    projectID: "project",
    sessionID: "session",
  }
  const state = createOrganizationHandoffState(input)
  const native = {
    kind: "drive" as const,
    body: { operation: "prepare-source" as const, requestID: "original-native" },
  }
  state.save(prepare.handoffID, native)
  const first = state.cancel(prepare.handoffID, { kind: "cancel" })
  expect(first.accepted).toBe(true)
  if (!first.accepted) throw new Error("No first cancellation identity")
  expect(state.cancel(prepare.handoffID, { kind: "cancel" }).accepted).toBe(false)
  expect(state.cancel(prepare.handoffID, { kind: "cancel" }, first.nonce).accepted).toBe(false)
  state.cancelUnsent(prepare.handoffID, first.nonce)
  expect(state.read()?.cancellation).toBeUndefined()
  expect(state.read()?.pending).toEqual(native)
  const later = state.cancel(prepare.handoffID, { kind: "cancel" })
  expect(later.accepted).toBe(true)
  if (!later.accepted) throw new Error("No later cancellation identity")
  expect(later.nonce).not.toBe(first.nonce)
  expect(state.cancelUnsent(prepare.handoffID, first.nonce)?.cancellationNonce).toBe(later.nonce)
  expect(state.read()?.pending).toEqual(native)
  const [key, raw] = [...values.entries()][0]
  const legacy = JSON.parse(raw)
  delete legacy.cancellationNonce
  values.set(key, JSON.stringify(legacy))
  const before = values.get(key)
  const reloaded = createOrganizationHandoffState(input)
  const retained = reloaded.cancel(prepare.handoffID, { kind: "cancel" })
  expect(retained.accepted).toBe(false)
  expect(retained.retained).toBe(true)
  expect(retained.saved.cancellationNonce).toBeUndefined()
  reloaded.cancelUnsent(prepare.handoffID, later.nonce)
  expect(values.get(key)).toBe(before)
  expect(reloaded.read()?.pending).toEqual(native)
})

const difference = Handoff.Difference.parse({
  sourceSnapshotHash: "b".repeat(64),
  targetDigest: "c".repeat(64),
  diffHash: "d".repeat(64),
  mappingPlanRevision: 1,
  entries: 2,
  sourceEntries: 4,
  targetEntries: 4,
  mode: { source: 0o755, target: 0o755 },
})
const existing = Handoff.WorkspaceMapping.parse({
  kind: "organization-native",
  moveID: "native-move",
  source: { workspaceID: "cloud", generation: 4 },
  resource: { resourceID: "storage", workspaceID: "cloud", generation: 4, path: "project" },
  target: {
    kind: "existing",
    workspaceID: "native",
    generation: 2,
    expectedRevision: 3,
    projectRevision: "e".repeat(64),
  },
})

test("initial target acceptance cannot acknowledge a second native difference consent or a changed version", () => {
  const view = Handoff.View.parse({
    ...completed,
    phase: "preparing",
    currentDriver: "source",
    bindingEpoch: 7,
    canAccept: true,
    canCancel: true,
    canContinue: false,
    workspaceMapping: existing,
    workspaceDifference: difference,
    workspaceDifferenceAccepted: false,
  })
  const action = {
    kind: "accept" as const,
    body: {
      mappingPlanRevision: 1,
      mappingHash: view.mappingHash,
      workspaceDifference: Handoff.DifferenceConsent.strip().parse(difference),
    },
  }
  expect(organizationHandoffOutcomeKnown(action, view)).toBe(false)
  expect(organizationHandoffOutcomeKnown(action, { ...view, workspaceDifferenceAccepted: true })).toBe(true)
  expect(
    organizationHandoffOutcomeKnown(action, {
      ...view,
      workspaceDifferenceAccepted: true,
      workspaceDifference: { ...difference, targetDigest: "f".repeat(64) },
    }),
  ).toBe(false)
})

test("source cancellation alone cannot acknowledge an unknown native target preview", () => {
  const view = Handoff.View.parse({ ...completed, phase: "cancelled", workspaceMapping: existing })
  expect(
    organizationHandoffOutcomeKnown(
      { kind: "drive", body: { operation: "preview-target", requestID: "original-preview" } },
      view,
    ),
  ).toBe(false)
})

test("an authorized native directory label survives reload only with its original handoff plan", () => {
  const values = new Map<string, string>()
  const input = {
    storage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => void values.set(key, value),
      removeItem: (key: string) => void values.delete(key),
    },
    owner: '["organization","org","account","inc"]',
    projectID: "project",
    sessionID: "session",
  }
  const original = Handoff.CurrentPrepare.parse({ ...prepare, workspaceMapping: existing })
  const action = { kind: "prepare" as const, body: original }
  const directory = { plan: original, label: "Selected team folder" }
  const state = createOrganizationHandoffState(input)
  state.save(original.handoffID, action, directory)
  state.confirmed(original.handoffID)
  expect(createOrganizationHandoffState(input).read()?.nativeDirectory).toEqual(directory)
  expect(
    createOrganizationHandoffState({ ...input, owner: '["organization","org","another-account","inc"]' }).read(),
  ).toBeUndefined()
  expect(() =>
    state.save(original.handoffID, action, {
      ...directory,
      plan: { ...original, targetRuntimeID: "another-runtime" },
    }),
  ).toThrow("original")
})
