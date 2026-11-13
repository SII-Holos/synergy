import { z } from "zod"
import { OrganizationHandoffProtocol as Handoff } from "@ericsanchezok/synergy-organization-protocol"

export function organizationNativeHandoffMapping(
  options: Handoff.Options,
  moveID: string,
  targetKind: "existing" | "private-copy" = "existing",
) {
  const source = options.source
  const target = options.native
  if (
    !source?.resource ||
    source.kind !== "organization" ||
    (targetKind === "existing" && !target) ||
    !options.choices.some(
      (choice) =>
        choice.kind === "organization-native" &&
        choice.targetKind === targetKind &&
        choice.requiresDifference === (targetKind === "existing"),
    )
  )
    return
  return Handoff.WorkspaceMapping.parse({
    kind: "organization-native",
    moveID,
    source: { workspaceID: source.reference.workspaceID, generation: source.reference.generation },
    resource: source.resource,
    target:
      targetKind === "existing" && target
        ? {
            kind: "existing",
            workspaceID: target.reference.workspaceID,
            generation: target.reference.generation,
            expectedRevision: target.reference.revision,
            projectRevision: target.projectRevision,
          }
        : { kind: "private-copy" },
  })
}

export function createOrganizationHandoffDifference(value: Handoff.Difference) {
  const summary = Handoff.Difference.parse(value)
  const positions: Array<{ cursor?: string; start: number; count?: number; next?: string }> = [{ start: 0 }]
  let index = 0
  let page: z.infer<typeof Handoff.DifferencePage> | undefined
  let complete = false
  return {
    summary,
    position(index: number) {
      const value = positions[index]
      if (!value) throw new Error("Load the preceding difference page first")
      return { cursor: value.cursor, index }
    },
    accept(position: { index: number; cursor?: string }, current: Handoff.Difference, input: unknown) {
      if (JSON.stringify(Handoff.Difference.parse(current)) !== JSON.stringify(summary))
        throw new Error("The native difference version changed")
      const value = Handoff.DifferencePage.parse(input)
      const at = positions[position.index]
      if (!at || at.cursor !== position.cursor || value.diffHash !== summary.diffHash)
        throw new Error("The native difference page belongs to another read")
      const end = at.start + value.items.length
      if (
        end > summary.entries ||
        (value.cursor ? !value.items.length || end >= summary.entries : end !== summary.entries)
      )
        throw new Error("The native difference page is incomplete")
      if (at.count !== undefined && (at.count !== value.items.length || at.next !== value.cursor))
        throw new Error("The native difference page changed")
      if (value.cursor && value.cursor === at.cursor) throw new Error("The native difference cursor did not advance")
      at.count = value.items.length
      at.next = value.cursor
      if (value.cursor) {
        const next = positions[position.index + 1]
        if (next && (next.cursor !== value.cursor || next.start !== end))
          throw new Error("The native difference cursor changed")
        if (!next) positions.push({ cursor: value.cursor, start: end })
      } else complete = true
      index = position.index
      page = value
      return { index, page, start: at.start, complete }
    },
    get current() {
      return { index, page, start: positions[index]!.start, complete }
    },
    consent() {
      if (positions[0]?.count === undefined)
        throw new Error("Load the first page of the complete native difference before accepting")
      return Handoff.DifferenceConsent.strip().parse(summary)
    },
  }
}
