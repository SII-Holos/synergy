import { z } from "zod"
import { createTwoFilesPatch } from "diff"
import { FilePatch } from "@ericsanchezok/synergy-util/file-patch"
import { Truncate } from "@ericsanchezok/synergy-harness/tool/truncation"
import { Tool } from "@ericsanchezok/synergy-harness/tool/tool"
import { FileTime } from "@ericsanchezok/synergy-harness/file/time"
import { EnvironmentResources } from "@ericsanchezok/synergy-harness/environment/resources"
import { WorkspaceOperations } from "@ericsanchezok/synergy-harness/workspace/operations"
import { WorkspaceProtocol } from "@ericsanchezok/synergy-harness/workspace/protocol"
import { WorkspaceEvents } from "@ericsanchezok/synergy-harness/workspace/events"
import { RuntimeReloadPath } from "@ericsanchezok/synergy-harness/config/reload-path"
import { RuntimeReloadExecutor } from "@ericsanchezok/synergy-harness/config/reload-executor"
import { SnapshotSchema } from "@ericsanchezok/synergy-harness/session/snapshot-schema"
import { FileView } from "../file/view"
import { FileMutation } from "../file/mutation"
import { FileEntry } from "../file/entry"
import { File } from "../file"
import { FileWatcherEvent } from "../file/watcher-event"
import { WorkspaceFileIndexer } from "../workspace-file/indexer"
import { WorkspaceFileStatus } from "../workspace-file/status"
import { diffStats } from "./anchored-file"
import { trimDiff } from "./edit"
import DESCRIPTION from "./apply-patch.txt"

type State = "not_started" | "committed" | "failed" | "unknown" | "unsaved"
interface SectionResult {
  source: string
  destination?: string
  operation: FilePatch.Section["type"]
  phase: "prepared" | "write" | "move" | "delete" | "post_write" | "complete" | "noop"
  state: State
  beforeVersion?: string | null
  afterVersion?: string | null
  operationID?: string
  operations: {
    id?: string
    phase: string
    path: string
    state: State
    beforeVersion: string | null
    afterVersion?: string | null
  }[]
  error?: string
  diff?: string
  observedPath?: string
  filediff?: SnapshotSchema.FileDiff
  files: SnapshotSchema.FileDiff[]
}
interface Prepared {
  section: FilePatch.Section
  source: string
  destination?: string
  before: FileView.Observation
  destinationBefore?: FileView.Observation
  destinationOld?: string
  old: string
  content: string
  result: SectionResult
}

function decode(bytes: Uint8Array | undefined): string {
  if (!bytes) return ""
  const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes)
  if (text.includes("\0")) throw new Error("Patch editing requires regular UTF-8 text files, not binary data.")
  return text
}

async function parent(filename: string, create: boolean) {
  let candidate = FileView.dirname(filename)
  for (;;) {
    const info = await FileView.stat(candidate, true)
    if (info) {
      if (info.kind !== "directory") throw new Error(`Patch parent is not a directory: ${candidate}`)
      return
    }
    if (!create) throw new Error(`Move destination parent must exist: ${candidate}`)
    const next = FileView.dirname(candidate)
    if (next === candidate) throw new Error(`Patch parent is unavailable: ${candidate}`)
    candidate = next
  }
}

async function prepare(
  sections: FilePatch.Section[],
  results: SectionResult[],
  ctx: Tool.Context,
): Promise<Prepared[]> {
  const prepared: Prepared[] = []
  const targets = new Set<string>()
  const identities = new Set<string>()
  const claim = (target: string) => {
    const key = process.platform === "win32" && FileView.native() ? target.toLowerCase() : target
    for (const existing of targets) {
      if (key === existing || key.startsWith(`${existing}/`) || existing.startsWith(`${key}/`))
        throw new Error(`Patch has duplicate, aliased or dependent paths: ${target}`)
    }
    targets.add(key)
  }
  for (const [index, section] of sections.entries()) {
    ctx.abort.throwIfAborted()
    const source = FileView.resolve(section.path)
    const before = await FileView.observe(source, ctx.abort)
    claim(before.canonical)
    if (before.entry ? before.entry.kind !== "file" : section.type !== "add")
      throw new Error(`Patch target must be a regular UTF-8 text file: ${section.path}`)
    if (before.entry?.identity) {
      if (identities.has(before.entry.identity)) throw new Error(`Patch has aliased source entries: ${section.path}`)
      identities.add(before.entry.identity)
    }
    const old = decode(before.bytes)
    if (before.entry) FileTime.assert(ctx.sessionID, source, before.bytes!)
    const content =
      section.type === "add" ? section.content : section.type === "update" ? FilePatch.update(old, section) : ""
    if (!FileView.native() && Buffer.byteLength(content) > WorkspaceProtocol.writeBytes)
      throw new Error(`Patch output exceeds the selected Workspace write limit: ${section.path}`)
    const destination = section.type === "update" && section.move ? FileView.resolve(section.move) : undefined
    const destinationBefore = destination ? await FileView.observe(destination, ctx.abort) : undefined
    const destinationOld = destinationBefore ? decode(destinationBefore.bytes) : undefined
    if (destinationBefore) {
      claim(destinationBefore.canonical)
      if (destinationBefore.entry && destinationBefore.entry.kind !== "file")
        throw new Error(`Move destination must be a regular UTF-8 text file: ${FileView.display(destination!)}`)
      if (destinationBefore.entry?.identity) {
        if (identities.has(destinationBefore.entry.identity))
          throw new Error(`Patch has aliased destination entries: ${FileView.display(destination!)}`)
        identities.add(destinationBefore.entry.identity)
      }
      if (destinationBefore.entry) FileTime.assert(ctx.sessionID, destination!, destinationBefore.bytes!)
      await parent(destination!, true)
    }
    await parent(source, section.type === "add")
    const result = results[index]!
    result.beforeVersion = before.version
    const target = destination ? FileView.display(destination) : section.path
    result.diff = trimDiff(createTwoFilesPatch(target, target, destinationOld ?? old, content))
    prepared.push({ section, source, destination, before, destinationBefore, destinationOld, old, content, result })
  }
  return prepared
}

async function validate(item: Prepared, signal: AbortSignal) {
  const source = await FileView.revalidate(item.source, item.before, signal)
  if (item.destination && item.destinationBefore)
    await FileView.revalidate(item.destination, item.destinationBefore, signal)
  await parent(item.source, item.section.type === "add")
  if (item.destination) await parent(item.destination, true)
  return source
}

function record(item: Prepared, target: string, content: string, ctx: Tool.Context, deleted = false) {
  const old = target === item.destination ? item.destinationOld! : item.old
  item.result.observedPath = FileView.display(target)
  item.result.afterVersion = deleted ? null : FileTime.version(content)
  const operation = item.result.operations.findLast((operation) => operation.path === item.result.observedPath)
  if (operation) operation.afterVersion = item.result.afterVersion
  item.result.diff = trimDiff(createTwoFilesPatch(item.result.observedPath, item.result.observedPath, old, content))
  item.result.filediff = SnapshotSchema.fromPatch({
    file: item.result.observedPath,
    beforeBytes: Buffer.byteLength(old),
    afterBytes: Buffer.byteLength(content),
    ...diffStats(item.result.diff),
    patch: item.result.diff,
  })
  const index = item.result.files.findIndex((file) => file.file === item.result.observedPath)
  if (index === -1) item.result.files.push(item.result.filediff)
  else item.result.files[index] = item.result.filediff
  FileTime.read(ctx.sessionID, target, deleted ? undefined : content)
}

async function effect(
  item: Prepared,
  phase: "write" | "move" | "delete",
  target: string,
  ctx: Tool.Context,
  save: () => Promise<void>,
  run: (id?: string) => Promise<unknown>,
) {
  ctx.abort.throwIfAborted()
  const id = FileView.native() ? undefined : EnvironmentResources.nextOperationID()
  const before = target === item.destination ? item.destinationBefore! : item.before
  const operation: SectionResult["operations"][number] = {
    id,
    phase,
    path: FileView.display(target),
    state: "unknown",
    beforeVersion: before.version,
  }
  item.result.operations.push(operation)
  item.result.operationID = id
  item.result.phase = phase
  item.result.state = "unknown"
  await save()
  try {
    await run(id)
    operation.state = "committed"
    item.result.state = "committed"
  } catch (error) {
    operation.state = id ? "unknown" : error instanceof FileEntry.PartialError ? "unsaved" : "failed"
    const workspace = EnvironmentResources.current()?.workspace
    if (id && workspace) {
      const receipt = await WorkspaceOperations.get(id, workspace.scopeID).catch(() => undefined)
      if (receipt) {
        const reconciled = await WorkspaceOperations.reconcile(id, workspace.scopeID).catch(() => undefined)
        const state = (reconciled ?? (await WorkspaceOperations.get(id, workspace.scopeID).catch(() => receipt))).state
        operation.state = state === "completed" ? "committed" : state === "submitted" ? "unknown" : state
      }
    }
    item.result.state = operation.state
    item.result.error = error instanceof Error ? error.message : String(error)
    throw error
  } finally {
    await save()
  }
}

export const ApplyPatchTool = Tool.define(
  "apply_patch",
  {
    description: DESCRIPTION,
    parameters: z.object({
      patch: z
        .string()
        .describe(
          "One complete *** Begin Patch / *** End Patch document with Add, Update, Delete and optional Move to sections.",
        ),
    }),
    async execute({ patch }, ctx) {
      const sections = FilePatch.parse(patch)
      const results: SectionResult[] = sections.map((section) => ({
        source: section.path,
        destination: section.type === "update" ? section.move : undefined,
        operation: section.type,
        phase: "prepared",
        state: "not_started",
        operations: [],
        files: [],
      }))
      const metadata = {
        error: undefined as string | undefined,
        outcome: undefined as undefined | "applied" | "no-change" | "rejected" | "partial" | "unresolved",
        sections: results,
        files: [] as SnapshotSchema.FileDiff[],
        truncated: false,
        runtimeReload: undefined as Awaited<ReturnType<typeof RuntimeReloadExecutor.reload>> | undefined,
      }
      const save = async () => {
        metadata.files = results.flatMap((result) => result.files)
        await ctx.metadata({ title: `${sections.length} file section(s)`, metadata: structuredClone(metadata) })
      }
      const changed = new Set<string>()
      const committed = new Set<string>()
      let plan: Prepared[] = []
      let failure: unknown
      try {
        plan = await prepare(sections, results, ctx)
        await ctx.ask({
          permission: "apply_patch",
          patterns: plan.flatMap((item) => [
            FileView.display(item.source),
            ...(item.destination ? [FileView.display(item.destination)] : []),
          ]),
          metadata: {
            sections: results,
            diff: plan
              .flatMap((item) => [
                ...(item.destination ? [createTwoFilesPatch(item.section.path, item.section.path, item.old, "")] : []),
                item.result.diff,
              ])
              .join("\n"),
          },
        })
        for (const item of plan) await validate(item, ctx.abort)
        for (const item of plan) {
          ctx.abort.throwIfAborted()
          const observed = await validate(item, ctx.abort)
          if (item.section.type === "update" && item.old === item.content && !item.destination) {
            item.result.phase = "noop"
            await save()
            continue
          }
          const target = item.destination ?? item.source
          const before = item.destination
            ? await FileView.revalidate(item.destination, item.destinationBefore!, ctx.abort)
            : observed
          if (
            item.section.type !== "delete" &&
            (item.destination || item.section.type === "add" || item.old !== item.content)
          ) {
            await effect(item, "write", target, ctx, save, (operationID) =>
              FileMutation.write({
                path: target,
                content: item.content,
                expectedVersion: before.version,
                expectedEntryVersion: before.entry?.entryVersion ?? null,
                ...(item.destination && !before.entry ? { mode: observed.entry!.mode & 0o777 } : {}),
                createParents: !!item.destination || item.section.type === "add",
                signal: ctx.abort,
                operationID,
                validate: async () => {
                  await validate(item, ctx.abort)
                },
              }),
            )
            changed.add(target)
            committed.add(target)
            record(item, target, item.content, ctx)
            item.result.phase = "post_write"
            await save()
            const published = await FileView.observe(target)
            if (published.entry?.kind !== "file" || published.version !== FileTime.version(item.content))
              throw new FileMutation.ConflictError()
            const written = await FileView.afterWrite(target, published, () =>
              WorkspaceEvents.publish(File.Event.Edited, {
                file: target,
                contentVersion: FileTime.version(item.content),
              }),
            )
            if (item.destination) item.destinationBefore = written
            else item.before = written
            record(item, target, decode(written.bytes), ctx)
            await save()
          }
          if (item.section.type === "delete" || item.destination) {
            await effect(item, "delete", item.source, ctx, save, async (id) => {
              const removing = await validate(item, ctx.abort)
              return FileView.native()
                ? FileEntry.remove({
                    path: item.source,
                    expectedVersion: removing.entry!.entryVersion,
                    signal: ctx.abort,
                    validate: async () => {
                      await validate(item, ctx.abort)
                    },
                  })
                : FileView.mutate(
                    {
                      kind: "remove",
                      path: FileView.relative(item.source),
                      expectedVersion: removing.entry!.entryVersion,
                    },
                    ctx.abort,
                    undefined,
                    id,
                  )
            })
            changed.add(item.source)
            committed.add(item.source)
            record(item, item.source, "", ctx, true)
            await WorkspaceEvents.publish(FileWatcherEvent.Updated, {
              file: FileView.relative(item.source),
              event: "deleted",
              parent: FileView.relative(FileView.dirname(item.source)),
            })
          }
          item.result.phase = "complete"
          await save()
        }
        metadata.outcome = changed.size ? "applied" : "no-change"
      } catch (error) {
        failure = error
        const unresolved = results.some((result) => result.state === "unknown" || result.state === "unsaved")
        const hasCommitted = results.some((result) =>
          result.operations.some((operation) => operation.state === "committed"),
        )
        metadata.outcome = unresolved ? "unresolved" : hasCommitted ? "partial" : "rejected"
        const active = results.find(
          (result) => result.phase !== "complete" && result.phase !== "noop" && result.operations.length,
        )
        if (active) active.error ??= error instanceof Error ? error.message : String(error)
        for (const item of plan) {
          if (item.result.phase === "complete") continue
          for (const operation of item.result.operations) {
            if (
              operation.state !== "committed" &&
              !(
                FileView.native() &&
                operation.state === "unsaved" &&
                error instanceof FileEntry.PartialError &&
                error.completed.length
              )
            )
              continue
            const target = FileView.resolve(operation.path)
            const publish = !changed.has(target)
            changed.add(target)
            if (operation.state === "committed") committed.add(target)
            try {
              if (!item.result.files.some((file) => file.file === operation.path))
                record(
                  item,
                  target,
                  operation.phase === "delete" ? "" : item.content,
                  ctx,
                  operation.phase === "delete",
                )
              if (publish)
                await WorkspaceEvents.publish(FileWatcherEvent.Updated, {
                  file: FileView.relative(target),
                  event: operation.phase === "delete" ? "deleted" : "changed",
                  parent: FileView.relative(FileView.dirname(target)),
                })
            } catch {
              // Keep the settled receipt when observation is unavailable; never replay an effect for evidence.
            }
          }
        }
        await save()
      }
      if (changed.size) {
        WorkspaceFileIndexer.invalidate()
        WorkspaceFileStatus.invalidate()
        const targets = [...new Set([...committed].flatMap((file) => RuntimeReloadPath.detectTargetsForFile(file)))]
        if (targets.length) {
          try {
            metadata.runtimeReload = await RuntimeReloadExecutor.reload({
              targets,
              scope: "auto",
              reason: "apply_patch",
            })
          } catch (error) {
            failure ??= error
            metadata.outcome = "partial"
          }
        }
      }
      metadata.error = failure ? (failure instanceof Error ? failure.message : String(failure)) : undefined
      const output = [
        `Patch ${metadata.outcome}.`,
        ...[...results]
          .sort((a, b) => Number(b.operations.length > 0) - Number(a.operations.length > 0))
          .map(
            (result) =>
              `${result.state}: ${result.source}${result.destination ? ` → ${result.destination}` : ""} (${result.phase}; ${result.operations.map((operation) => `${operation.phase}: ${operation.state}`).join(", ") || "not attempted"})${result.error ? ` — ${result.error}` : ""}`,
          ),
        failure
          ? `Stopped: ${failure instanceof Error ? failure.message : String(failure)}. Inspect committed/unresolved paths before making another patch; attempted Add parent directories may remain.`
          : "",
      ]
        .filter(Boolean)
        .join("\n")
      const result = { title: `Patch ${metadata.outcome}`, metadata, output }
      await ctx.captureResult?.(result)
      const bounded = await Truncate.output(output)
      metadata.truncated = bounded.truncated
      await ctx.metadata({
        title: result.title,
        metadata: { ...structuredClone(metadata), ...(bounded.truncated ? { outputPath: bounded.outputPath } : {}) },
      })
      const displayed = failure
        ? bounded.content.replace(
            "The tool call succeeded but the output was truncated.",
            "The patch stopped and its result was truncated.",
          )
        : bounded.content
      if (ctx.abort.aborted) throw new DOMException(displayed, "AbortError")
      if (failure) throw new Error(displayed, { cause: failure })
      return {
        ...result,
        output: displayed,
        metadata: { ...metadata, ...(bounded.truncated ? { outputPath: bounded.outputPath } : {}) },
      }
    },
  },
  {
    requiresWorkspace: true,
    activityKind: "file-change",
    fileToolGroups: ["patch"],
    exposure: { mode: "resident", companions: ["read"] },
  },
)
