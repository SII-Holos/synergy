export namespace NoteBlueprintPolicy {
  export type Kind = "note" | "blueprint"
  export type WriteAction = "create" | "update" | "edit"
  export type BlockReason = "non_plan_mode_blueprint_write"

  export type Decision =
    | {
        allowed: true
      }
    | {
        allowed: false
        reason: BlockReason
        action: WriteAction
      }

  export function requestedKind(input: {
    kind?: Kind
    description?: string
    defaultAgent?: string
    auditAgent?: string
    fallback?: Kind
  }): Kind | undefined {
    return (
      input.kind ??
      (input.description !== undefined || input.defaultAgent !== undefined || input.auditAgent !== undefined
        ? "blueprint"
        : input.fallback)
    )
  }

  export function evaluateWrite(input: {
    planMode: boolean
    latticeActive: boolean
    action: WriteAction
    existingKind?: Kind
    requestedKind?: Kind
  }): Decision {
    if (input.planMode || input.latticeActive) return { allowed: true }
    const touchesBlueprint = input.existingKind === "blueprint" || input.requestedKind === "blueprint"
    if (!touchesBlueprint) return { allowed: true }
    return {
      allowed: false,
      reason: "non_plan_mode_blueprint_write",
      action: input.action,
    }
  }

  export function blockedResult(input: { action: WriteAction; id?: string; title?: string }) {
    const actionLabel =
      input.action === "create"
        ? "create a Blueprint"
        : input.action === "edit"
          ? "edit a Blueprint"
          : "modify a Blueprint"

    return {
      title: "Blueprint write blocked",
      output: [
        `Error: this session is not in Plan Mode, so note tools cannot ${actionLabel}.`,
        "Outside Plan Mode, Blueprint notes are read-only: use note_read, note_search, or note_list to inspect them.",
        'You may still use note_write or note_edit for ordinary notes. To store a deliverable, create or update a regular note with kind: "note" and do not pass Blueprint fields.',
        input.id ? `ID: ${input.id}` : undefined,
        input.title ? `Title: ${input.title}` : undefined,
      ]
        .filter((line): line is string => line !== undefined)
        .join("\n"),
      metadata: {
        blocked: true,
        reason: "non_plan_mode_blueprint_write" as const,
        action: input.action,
        id: input.id,
        title: input.title,
      },
    }
  }
}
