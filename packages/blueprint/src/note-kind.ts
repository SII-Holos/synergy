import { z } from "zod"
import { NoteDocumentKinds, NoteStore } from "@ericsanchezok/synergy-note"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { formatLocalDateTime } from "@ericsanchezok/synergy-harness/util/time-format"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { NoteBlueprintPolicy } from "./note-policy"
import { registerNoteSessionAccess } from "./session-access"
import { registerBlueprintNoteMigrations } from "./note-migration"
import { BlueprintLoopSources } from "./blueprint/source"

const metadata = z.object({
  description: z.string().optional(),
  defaultAgent: z.string().optional(),
  auditAgent: z.string().optional(),
  activeLoopID: z.string().optional(),
  runCount: z.number().optional(),
  lastRunAt: z.number().optional(),
})
const info = metadata
  .extend({ activeLoopSource: z.string().optional(), lastRunSource: z.string().optional() })
  .optional()
const create = metadata.optional()
const patch = metadata.extend({ activeLoopID: z.string().nullable().optional() }).nullable().optional()
const description = z.string().optional().describe("Short description of the executable Blueprint document.")

declare module "@ericsanchezok/synergy-note/types" {
  interface NoteInfoExtensions {
    blueprint: typeof info
  }
  interface NoteCreateExtensions {
    blueprint: typeof create
  }
  interface NotePatchExtensions {
    blueprint: typeof patch
  }
}
declare module "@ericsanchezok/synergy-note/document-kinds" {
  interface NoteWriteExtensions {
    blueprintDescription: typeof description
  }
}

function fields(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

const contribution: NoteDocumentKinds.Contribution = {
  kind: "blueprint",
  title: "Blueprint",
  fields: { info: { blueprint: info }, create: { blueprint: create }, patch: { blueprint: patch } },
  project(document) {
    const value = fields(document.blueprint)
    if (typeof value.activeLoopSource !== "string" || !BlueprintLoopSources.available(value.activeLoopSource)) {
      delete value.activeLoopID
      delete value.activeLoopSource
    }
    if (
      (value.lastRunAt !== undefined || value.lastRunSource !== undefined) &&
      (typeof value.lastRunSource !== "string" || !BlueprintLoopSources.available(value.lastRunSource))
    ) {
      delete value.lastRunAt
      delete value.lastRunSource
      delete value.runCount
    }
  },
  normalize(document) {
    document.blueprint ??= {}
    delete fields(document.blueprint).status
  },
  create(document, input) {
    const value = fields(input.blueprint)
    document.blueprint = { ...value, runCount: value.runCount ?? 0 }
    delete fields(document.blueprint).status
  },
  update(document, input) {
    if (input.blueprint === null) {
      document.blueprint = undefined
      return
    }
    const value = { ...fields(document.blueprint), ...fields(input.blueprint) }
    delete value.status
    if (
      fields(input.blueprint).activeLoopID !== undefined &&
      fields(input.blueprint).activeLoopID !== fields(document.blueprint).activeLoopID
    )
      delete value.activeLoopSource
    if (value.activeLoopID === null) {
      delete value.activeLoopID
      delete value.activeLoopSource
    }
    document.blueprint = value
  },
  tool: {
    write: { blueprintDescription: description },
    description: [
      'Use kind:"blueprint" in Plan or another registered planning workflow that permits Blueprint changes when a document should become executable through BlueprintLoop. Outside an eligible planning workflow, use ordinary notes for deliverables.',
      "Blueprint content must be decision-complete and executable. Resolve blocking questions before creating or replacing it. Do not leave open decisions, TBDs, unresolved alternatives, or requests for the execution session to ask the user later.",
      'Use kind:"note" within an eligible planning workflow to convert a Blueprint to a plain note. blueprintDescription supplies its short description. Execution-agent and reviewer selection are host-owned.',
    ].join("\n\n"),
    input(input) {
      if (input.kind === "note") return { kind: "note" }
      if (input.kind !== "blueprint" && input.blueprintDescription === undefined) return
      return {
        kind: "blueprint",
        ...(input.blueprintDescription !== undefined ? { blueprint: { description: input.blueprintDescription } } : {}),
      }
    },
    async guard(input) {
      const session = await Session.get(input.sessionID)
      const decision = NoteBlueprintPolicy.evaluateWrite({
        workflowKind: session.workflow?.kind,
        action: input.action,
        existingKind: input.existing?.kind === "blueprint" ? "blueprint" : "note",
        requestedKind: input.requestedKind === "blueprint" ? "blueprint" : "note",
      })
      if (!decision.allowed)
        return NoteBlueprintPolicy.blockedResult({ action: input.action, id: input.existing?.id, title: input.title })
    },
    details(document) {
      const value = fields(document.blueprint)
      return [
        `blueprintDescription: ${value.description ?? "none"}`,
        `Default Agent: ${value.defaultAgent ?? "none"}`,
        "Audit Agent: supervisor",
        `Active Loop: ${value.activeLoopID ?? "none"}`,
        `Run Count: ${value.runCount ?? 0}`,
        `Last Run: ${typeof value.lastRunAt === "number" ? formatLocalDateTime(value.lastRunAt) : "never"}`,
      ]
    },
    metadata: (document) => ({ runCount: fields(document.blueprint).runCount ?? 0 }),
  },
}

export function registerBlueprintNoteKind() {
  NoteDocumentKinds.register(contribution)
  registerBlueprintNoteMigrations()
  registerNoteSessionAccess()
}

export async function recordBlueprintNoteRun(input: {
  scopeID: string
  noteID: string
  loopID: string
  source?: string
  started?: number
  ended?: boolean
  archive?: boolean
}) {
  await NoteStore.mutateMetadata(input.scopeID, input.noteID, (note) => {
    if (note.kind !== "blueprint") return false
    note.blueprint ??= {}
    if (input.started !== undefined) {
      note.blueprint.runCount = (note.blueprint.runCount ?? 0) + 1
      note.blueprint.lastRunAt = input.started
      note.blueprint.activeLoopID = input.loopID
      note.blueprint.activeLoopSource = input.source ?? "user"
      note.blueprint.lastRunSource = input.source ?? "user"
    }
    if (input.ended && note.blueprint.activeLoopID === input.loopID) {
      delete note.blueprint.activeLoopID
      delete note.blueprint.activeLoopSource
    }
    if (input.archive) note.archived = true
  }).catch((error) => {
    if (!(error instanceof Storage.NotFoundError)) throw error
  })
}
