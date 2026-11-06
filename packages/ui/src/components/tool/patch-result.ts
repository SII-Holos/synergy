import type { MessageDescriptor } from "@lingui/core"

export const PATCH_OUTCOMES = {
  applied: { id: "tool.patch.applied", message: "Applied" },
  "no-change": { id: "tool.patch.noChange", message: "No changes" },
  rejected: { id: "tool.patch.rejected", message: "Rejected" },
  partial: { id: "tool.patch.partial", message: "Partially applied" },
  unresolved: { id: "tool.patch.unresolved", message: "Outcome unconfirmed" },
} satisfies Record<string, MessageDescriptor>

export const PATCH_STATES = {
  not_started: { id: "tool.patch.notStarted", message: "Not attempted" },
  committed: { id: "tool.patch.committed", message: "Applied" },
  failed: { id: "tool.patch.failed", message: "Failed" },
  unknown: { id: "tool.patch.unknown", message: "Unknown effect" },
  unsaved: { id: "tool.patch.unsaved", message: "Durability unconfirmed" },
} satisfies Record<string, MessageDescriptor>

export const PATCH_PHASES = {
  write: { id: "tool.patch.write", message: "Write" },
  move: { id: "tool.patch.move", message: "Move" },
  delete: { id: "tool.patch.delete", message: "Delete" },
} satisfies Record<string, MessageDescriptor>

export function patchOutcome(value: unknown): keyof typeof PATCH_OUTCOMES | undefined {
  return typeof value === "string" && Object.hasOwn(PATCH_OUTCOMES, value)
    ? (value as keyof typeof PATCH_OUTCOMES)
    : undefined
}

export function patchSections(value: unknown) {
  if (!Array.isArray(value)) return []
  return value.flatMap((row: unknown) => {
    if (
      !row ||
      typeof row !== "object" ||
      !("source" in row) ||
      typeof row.source !== "string" ||
      !("state" in row) ||
      typeof row.state !== "string" ||
      !Object.hasOwn(PATCH_STATES, row.state)
    )
      return []
    const diff = "diff" in row && typeof row.diff === "string" ? row.diff : undefined
    const observedPath =
      "observedPath" in row && typeof row.observedPath === "string"
        ? row.observedPath
        : "filediff" in row &&
            row.filediff &&
            typeof row.filediff === "object" &&
            "file" in row.filediff &&
            typeof row.filediff.file === "string"
          ? row.filediff.file
          : undefined
    return [
      {
        source: row.source,
        operation:
          "operation" in row && (row.operation === "add" || row.operation === "update" || row.operation === "delete")
            ? row.operation
            : undefined,
        destination: "destination" in row && typeof row.destination === "string" ? row.destination : undefined,
        state: row.state as keyof typeof PATCH_STATES,
        ...("error" in row && typeof row.error === "string" ? { error: row.error } : {}),
        phase: "phase" in row && typeof row.phase === "string" ? row.phase : undefined,
        diff,
        observedPath,
        files:
          "files" in row && Array.isArray(row.files)
            ? row.files.flatMap((file: unknown) => {
                if (
                  !file ||
                  typeof file !== "object" ||
                  !("file" in file) ||
                  typeof file.file !== "string" ||
                  !file.file
                )
                  return []
                const patch = [
                  "patch" in file ? file.patch : undefined,
                  "preview" in file ? file.preview : undefined,
                ].find((value): value is string => typeof value === "string" && value.length > 0)
                return [{ file: file.file, patch }]
              })
            : diff && observedPath
              ? [{ file: observedPath, patch: diff }]
              : [],
        operations:
          "operations" in row && Array.isArray(row.operations)
            ? row.operations.flatMap((operation: unknown) => {
                if (
                  !operation ||
                  typeof operation !== "object" ||
                  !("phase" in operation) ||
                  typeof operation.phase !== "string" ||
                  !Object.hasOwn(PATCH_PHASES, operation.phase) ||
                  !("state" in operation) ||
                  typeof operation.state !== "string" ||
                  !Object.hasOwn(PATCH_STATES, operation.state)
                )
                  return []
                return [
                  {
                    phase: operation.phase as keyof typeof PATCH_PHASES,
                    state: operation.state as keyof typeof PATCH_STATES,
                  },
                ]
              })
            : [],
      },
    ]
  })
}
