import { OrganizationKnowledgeProtocol as Protocol } from "@ericsanchezok/synergy-organization-protocol"
import type { Credentials } from "../../src/auth/session"
import { OrganizationKnowledge as Knowledge } from "../../src/knowledge"

async function selection(credentials: Credentials, target: Protocol.SelectionTarget) {
  const releases: Protocol.Reference[] = []
  let cursor: string | undefined
  let summary: Protocol.SelectionSummary | undefined
  do {
    const page =
      target.kind === "member"
        ? await Knowledge.appliedPage(credentials, target.projectID, {
            cursor,
            limit: 100,
            manifestHash: summary?.manifestHash,
          })
        : await Knowledge.sessionSelectionPage(credentials, target.sessionID, {
            cursor,
            limit: 100,
            manifestHash: summary?.manifestHash,
          })
    summary = page.selection
    releases.push(...page.items)
    cursor = page.cursor
  } while (cursor)
  if (!summary) throw new Error("Knowledge fixture did not receive a selection summary")
  const { releaseCount, ...metadata } = summary
  if (releaseCount !== releases.length) throw new Error("Knowledge fixture selection is incomplete")
  return { ...metadata, releases }
}

async function replace(
  credentials: Credentials,
  target: Protocol.SelectionTarget,
  input: { expectedRevision: number; releases: Protocol.Reference[] },
) {
  const previous = await selection(credentials, target)
  const update = await Knowledge.beginSelectionUpdate(credentials, {
    requestID: crypto.randomUUID(),
    target,
    expectedRevision: input.expectedRevision,
  })
  const selected = new Set(input.releases.map((reference) => reference.itemID))
  const changes = [
    ...previous.releases
      .filter((reference) => !selected.has(reference.itemID))
      .map((reference) => ({ itemID: reference.itemID })),
    ...input.releases.map((reference) => ({ itemID: reference.itemID, reference })),
  ]
  let sequence = 0
  for (let start = 0; start < changes.length; start += 100)
    await Knowledge.patchSelectionUpdate(credentials, update.updateID, {
      sequence: sequence++,
      changes: changes.slice(start, start + 100),
    })
  await Knowledge.commitSelectionUpdate(credentials, update.updateID, { expectedSequence: sequence })
  return selection(credentials, target)
}

export const appliedSelection = (credentials: Credentials, projectID: string) =>
  selection(credentials, { kind: "member", projectID })
export const applySelection = (
  credentials: Credentials,
  projectID: string,
  input: { expectedRevision: number; releases: Protocol.Reference[] },
) => replace(credentials, { kind: "member", projectID }, input)
export const sessionSelection = (credentials: Credentials, sessionID: string) =>
  selection(credentials, { kind: "session", sessionID })
export const setSessionSelection = (
  credentials: Credentials,
  sessionID: string,
  input: { expectedRevision: number; releases: Protocol.Reference[] },
) => replace(credentials, { kind: "session", sessionID }, input)
