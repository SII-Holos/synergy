import { z } from "zod"
import { NamedError } from "@ericsanchezok/synergy-util/error"
import { RuntimeContext } from "../lifecycle/context"
import { Storage } from "../storage/storage"
import { JsonValue } from "../util/json-value"
import { Session } from "."
import { SessionTransferEpochs } from "./transfer-epochs"
import { SessionTransferFreezeAuthority } from "./transfer-freeze-authority"
import type { SessionTransferStream } from "./transfer-stream"

export namespace SessionTransferOwners {
  export type FreezeReceipt = SessionTransferFreezeAuthority.Receipt
  export const Requirement = z.object({
    code: z.string(),
    owner: z.string().optional(),
    label: z.string(),
    recoverable: z.boolean(),
  })
  export type Requirement = z.infer<typeof Requirement>
  export const Rejected = NamedError.create(
    "SessionTransferOwnerRejected",
    z.object({ message: z.string(), requirements: z.array(Requirement).optional() }),
  )
  export interface SourceContext {
    session: Readonly<Session.Info>
    rootSessionID: string
    handoffID: string
    signal: AbortSignal
  }
  export interface Inspection {
    requirements: Requirement[]
    children: AsyncIterable<string>
  }
  export interface StagedRecord {
    key: string[]
    value: unknown
  }
  export interface StagedArtifact {
    key: string[]
    bytes: number
    sha256: string
    read(): AsyncIterable<Uint8Array>
    publish(target: string[], options?: { replace?: boolean }): Promise<void>
  }
  export interface TargetContext {
    session: Readonly<Session.Info>
    rootSessionID: string
    handoffID: string
    sourceVersion: number
    signal: AbortSignal
    mapping: Readonly<Record<string, z.infer<typeof JsonValue>>>
    staged: {
      record(key: string[]): Promise<StagedRecord | undefined>
      records(): AsyncIterable<StagedRecord>
      relatedRecords?(ownerID: string): AsyncIterable<StagedRecord>
      artifacts(): AsyncIterable<StagedArtifact>
    }
  }
  export interface ResumeContext {
    session: Readonly<Session.Info>
    rootSessionID: string
    intentID: string
    signal: AbortSignal
  }
  export type Dependency = { kind: "asset" | "tool-output"; reference: string }
  export interface Contribution {
    version: number
    reads: readonly number[]
    applies(session: Readonly<Session.Info>): boolean | Promise<boolean>
    stagedDependencies?: readonly string[]
    inspect(context: SourceContext): Promise<Inspection>
    freeze(context: SourceContext): Promise<void>
    export(context: SourceContext): AsyncIterable<SessionTransferStream.Input>
    dependencies?(context: SourceContext): AsyncIterable<Dependency>
    validate(context: TargetContext): Promise<void>
    publish(context: TargetContext): Promise<void>
    resume?(context: ResumeContext): Promise<void>
  }
  const state = RuntimeContext.state(() => new Map<string, Contribution>())
  const ID = z.string().min(1).max(256)
  const Version = z.number().int().positive().safe()

  export function register(id: string, owner: Contribution) {
    RuntimeContext.assertCompositionOpen("Session transfer owners")
    ID.parse(id)
    Version.parse(owner.version)
    for (const version of owner.reads) Version.parse(version)
    if (!owner.reads.includes(owner.version))
      throw new Rejected({ message: "A portability owner must read its own current schema" })
    if (state().has(id)) throw new Rejected({ message: `Duplicate portability owner: ${id}` })
    const dependencies = [...new Set(owner.stagedDependencies ?? [])]
    for (const dependency of dependencies) {
      ID.parse(dependency)
      if (dependency === id) throw new Rejected({ message: "A staged dependency must name another owner" })
    }
    state().set(id, {
      ...owner,
      reads: Object.freeze([...owner.reads]),
      stagedDependencies: Object.freeze(dependencies),
    })
  }

  export function stagedDependencies(id: string) {
    return require(id).stagedDependencies ?? []
  }

  export function versions(ids: readonly string[]) {
    return Object.fromEntries(ids.map((id) => [id, require(id).version]))
  }

  function require(id: string) {
    const owner = state().get(id)
    if (!owner)
      throw new Rejected({
        message: "A required portability owner is unavailable",
        requirements: [
          {
            code: "owner_missing",
            owner: id,
            label: `Install the required ${id} portability owner`,
            recoverable: true,
          },
        ],
      })
    return owner
  }

  export function compatibility(source: Readonly<Record<string, number>>): Requirement[] {
    const requirements: Requirement[] = []
    for (const [id, version] of Object.entries(source)) {
      ID.parse(id)
      Version.parse(version)
      const owner = state().get(id)
      if (!owner)
        requirements.push({
          code: "owner_missing",
          owner: id,
          label: `Install the required ${id} portability owner`,
          recoverable: true,
        })
      else if (!owner.reads.includes(version))
        requirements.push({
          code: "owner_schema",
          owner: id,
          label: `${id} cannot losslessly read portability schema ${version}`,
          recoverable: true,
        })
    }
    return requirements
  }

  export async function selected(context: SourceContext, required: readonly string[] = []) {
    const ids = new Set(required)
    const raw = z
      .object({
        cortex: z.unknown().optional(),
        blueprint: z.unknown().optional(),
        superplan: z.unknown().optional(),
        workflow: z.object({ kind: z.string(), extension: z.object({ kind: z.string() }).optional() }).optional(),
      })
      .parse(await Storage.read(["sessions", context.session.scope.id, context.session.id, "info"]))
    if (raw.cortex) ids.add("cortex")
    if (raw.blueprint || raw.superplan) ids.add("blueprint")
    const kind = raw.workflow?.kind === "extension" ? raw.workflow.extension?.kind : raw.workflow?.kind
    if (kind && kind !== "none")
      ids.add(
        ({ lightloop: "light-loop", plan: "blueprint", lattice: "lattice", boss: "boss" } as Record<string, string>)[
          kind
        ] ?? kind,
      )
    for (const [id, owner] of state()) {
      context.signal.throwIfAborted()
      if (await owner.applies(context.session)) ids.add(id)
    }
    for (const id of ids) require(id)
    return [...ids].sort()
  }

  export async function inspect(context: SourceContext, ids: readonly string[]) {
    const inspections: Inspection[] = []
    for (const id of ids) {
      context.signal.throwIfAborted()
      inspections.push(await require(id).inspect(context))
    }
    return {
      requirements: inspections.flatMap((inspection) => inspection.requirements),
      children: (async function* () {
        for (const inspection of inspections) yield* inspection.children
      })(),
    }
  }

  export async function freeze(context: SourceContext, ids: readonly string[]) {
    for (const id of ids) {
      context.signal.throwIfAborted()
      await require(id).freeze(context)
    }
    return SessionTransferFreezeAuthority.issue({
      sessionID: context.session.id,
      rootSessionID: context.rootSessionID,
      handoffID: context.handoffID,
      owners: ids,
    })
  }

  export async function* entries(
    context: SourceContext,
    ids: readonly string[],
  ): AsyncGenerator<SessionTransferStream.Input> {
    await SessionTransferEpochs.assertFrozen(context.session.id, context.handoffID)
    const source = { ...context, session: await Session.get(context.session.id) }
    for (const id of ids) {
      for await (const entry of require(id).export(source)) {
        context.signal.throwIfAborted()
        if (entry.metadata.transferOwner !== undefined && entry.metadata.transferOwner !== id)
          throw new Rejected({ message: "A portability entry cannot claim another owner" })
        if (entry.metadata.transferSessionID !== undefined && entry.metadata.transferSessionID !== context.session.id)
          throw new Rejected({ message: "A portability entry cannot claim another Session" })
        yield { ...entry, metadata: { ...entry.metadata, transferOwner: id, transferSessionID: context.session.id } }
      }
    }
  }

  export async function* dependencies(
    context: SourceContext,
    ids: readonly string[],
  ): AsyncGenerator<Dependency & { ownerID: string; sessionID: string }> {
    await SessionTransferEpochs.assertFrozen(context.session.id, context.handoffID)
    const source = { ...context, session: await Session.get(context.session.id) }
    for (const ownerID of ids) {
      const contribution = require(ownerID)
      if (!contribution.dependencies) continue
      for await (const dependency of contribution.dependencies(source)) {
        context.signal.throwIfAborted()
        const reference = z.string().min(1).max(4096).parse(dependency.reference)
        yield {
          kind: z.enum(["asset", "tool-output"]).parse(dependency.kind),
          reference,
          ownerID,
          sessionID: context.session.id,
        }
      }
    }
  }

  export async function validate(id: string, context: TargetContext) {
    const requirements = compatibility({ [id]: context.sourceVersion })
    if (requirements.length) throw new Rejected({ message: "Destination portability is incompatible", requirements })
    context.signal.throwIfAborted()
    await require(id).validate(context)
  }

  export async function publish(id: string, context: TargetContext) {
    if (!Storage.inWriteTransaction())
      throw new Rejected({ message: "Portable owner publication requires the activation transaction" })
    const requirements = compatibility({ [id]: context.sourceVersion })
    if (requirements.length) throw new Rejected({ message: "Destination portability is incompatible", requirements })
    context.signal.throwIfAborted()
    await require(id).publish(context)
  }

  export async function resume(context: ResumeContext) {
    const session = await Session.get(context.rootSessionID)
    if (session.id !== context.session.id || session.paused || (await SessionTransferEpochs.isFrozen(session.id)))
      throw new Rejected({ message: "Portable owner resume requires a separately admitted root Continue" })
    for (const owner of state().values()) {
      context.signal.throwIfAborted()
      await owner.resume?.({ ...context, session })
    }
  }
}
