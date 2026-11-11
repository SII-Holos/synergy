import { createHash } from "node:crypto"
import { z } from "zod"
import { AssetReference } from "@ericsanchezok/synergy-util/asset-reference"
import { Asset } from "../asset/asset"
import { Storage } from "../storage/storage"
import { RuntimeContext } from "../lifecycle/context"
import { Lock } from "../util/lock"
import { StoredToolOutput } from "../tool/stored-output"
import { Session } from "."
import { SessionTransferOwners as Owners } from "./transfer-owners"
import { SessionTransferEpochs as Epochs } from "./transfer-epochs"
import type { SessionTransferStream } from "./transfer-stream"
import { SessionTransferReferences } from "./transfer-references"

export namespace SessionTransferEvidence {
  export interface SourceAuthority {
    authorize(input: {
      source: Readonly<Owners.SourceContext>
      ownerID: string
      dependency: Readonly<Owners.Dependency>
    }): Promise<void>
  }
  const ID = "session-evidence"
  const Hash = z.string().regex(/^[a-f0-9]{64}$/)
  const OutputID = z.string().regex(/^tool_[a-zA-Z0-9_-]{1,128}$/)
  const Info = z.strictObject({ bytes: z.number().int().nonnegative().safe(), sha256: Hash })
  const OutputInfo = StoredToolOutput.Metadata
  const Resource = Info.extend({
    version: z.literal(1),
    kind: z.enum(["asset", "tool-output"]),
    id: z.string(),
    complete: z.boolean(),
  })
  const Alias = z.strictObject({ alias: z.string().min(1).max(4096), id: OutputID })
  const Origin = z.strictObject({
    sessionID: z.string(),
    ownerID: z.string(),
    kind: z.enum(["asset", "tool-output"]),
    reference: z.string().min(1).max(4096),
  })
  const Member = z.strictObject({
    version: z.literal(1),
    sessionID: z.string(),
    owners: z.record(z.string(), z.number().int().positive().safe()),
  })
  const Manifest = z.strictObject({
    version: z.literal(1),
    handoffID: z.string(),
    rootSessionID: z.string(),
    scopeID: z.string(),
    members: z.number().int().nonnegative().safe(),
    assets: z.number().int().nonnegative().safe(),
    outputs: z.number().int().nonnegative().safe(),
    aliases: z.number().int().nonnegative().safe(),
  })
  const State = Manifest.extend({ phase: z.enum(["building", "sealed"]) })
  const manifest = (state: z.infer<typeof State>) => {
    const { phase: _phase, ...value } = state
    return Manifest.parse(value)
  }
  const info = (value: { bytes: number; sha256: string }) => Info.parse({ bytes: value.bytes, sha256: value.sha256 })
  const contentInfo = (key: string[], value: unknown) =>
    key[0] === "tool_outputs" ? info(OutputInfo.parse(value)) : Info.parse(value)
  type Resource = z.infer<typeof Resource>
  const authority = RuntimeContext.state(() => ({ source: undefined as SourceAuthority | undefined }))
  const preparations = new WeakMap<Owners.TargetContext, { runtime: RuntimeContext.Instance; digest: string }>()
  const root = (handoffID: string) => ["session_transfer_evidence", handoffID]
  const stateKey = (handoffID: string) => [...root(handoffID), "state"]
  const membersKey = (handoffID: string) => [...root(handoffID), "members"]
  const memberKey = (handoffID: string, sessionID: string) => [...membersKey(handoffID), sessionID]
  const resourcesKey = (handoffID: string) => [...root(handoffID), "resources"]
  const resourceKey = (handoffID: string, kind: Resource["kind"], id: string) => [...resourcesKey(handoffID), kind, id]
  const aliasesKey = (handoffID: string) => [...root(handoffID), "aliases"]
  const originsKey = (handoffID: string) => [...root(handoffID), "origins"]
  const hash = (value: string) => createHash("sha256").update(value).digest("hex")
  const manifestKey = (sessionID: string) => ["session_evidence", sessionID, "manifest"]
  const portableMemberKey = (rootID: string, sessionID: string) => ["session_evidence", rootID, "members", sessionID]
  const assetInfoKey = (id: string) => ["asset_manifest", id]
  const outputInfoKey = (id: string) => ["tool_outputs", OutputID.parse(id), "info"]
  const aliasKey = (value: string) => ["tool_output_aliases", hash(value)]
  const dataKey = (value: Resource) =>
    value.kind === "asset" ? ["assets", value.id] : ["tool_outputs", value.id, "content"]
  const metadataKey = (value: Resource) => (value.kind === "asset" ? assetInfoKey(value.id) : outputInfoKey(value.id))
  const optional = <T>(promise: Promise<T>) =>
    promise.catch((error) => {
      if (error instanceof Storage.NotFoundError) return undefined
      throw error
    })
  const encode = (value: unknown) =>
    (async function* () {
      yield new TextEncoder().encode(JSON.stringify(value))
    })()
  function fail(message: string, code = "dependency_invalid"): never {
    throw new Owners.Rejected({ message, requirements: [{ code, owner: ID, label: message, recoverable: true }] })
  }

  async function clear(prefix: string[]) {
    for await (const row of Storage.records({ prefix, limit: 128 })) await Storage.remove(row.key)
  }

  async function authorize(context: Owners.SourceContext, ownerID: string, dependency: Owners.Dependency) {
    const raw = await Storage.read<Record<string, unknown>>([
      "sessions",
      context.session.scope.id,
      context.session.id,
      "info",
    ])
    const aggregate =
      context.session.id === context.rootSessionID
        ? raw
        : await Storage.read<Record<string, unknown>>([
            "sessions",
            context.session.scope.id,
            context.rootSessionID,
            "info",
          ])
    if (raw.organization == null && aggregate.organization == null) return
    const source = authority().source
    if (!source) fail("Organization dependencies require registered source authority", "source_authority_missing")
    await source.authorize({ source: context, ownerID, dependency })
    context.signal.throwIfAborted()
  }

  async function capture(context: Owners.SourceContext, ownerID: string, dependency: Owners.Dependency) {
    const { handoffID, signal } = context
    signal.throwIfAborted()
    await authorize(context, ownerID, dependency)
    await Storage.write(
      [...originsKey(handoffID), context.session.id, hash(JSON.stringify([ownerID, dependency]))],
      Origin.parse({ sessionID: context.session.id, ownerID, ...dependency }),
    )
    if (dependency.kind === "asset") {
      const reference = AssetReference.parse(dependency.reference)
      if (!reference) fail("Portable Asset reference is invalid")
      const key = resourceKey(handoffID, "asset", reference.id)
      if (await optional(Storage.read(key, { silentNotFound: true }))) return
      const content = await Asset.open(reference.id, signal)
      if (!content) fail("A portable Asset is missing", "asset_missing")
      await Storage.write(
        key,
        Resource.parse({
          version: 1,
          kind: "asset",
          id: reference.id,
          bytes: content.bytes,
          sha256: content.sha256,
          complete: true,
        }),
      )
      return
    }
    const opened = await StoredToolOutput.open(dependency.reference).catch((error) => {
      if (error instanceof Storage.NotFoundError)
        fail("A canonical complete tool output is missing", "tool_output_missing")
      throw error
    })
    const id = OutputID.parse(opened.reference.slice("tool-output://".length))
    const value = Resource.parse({
      version: 1,
      kind: "tool-output",
      id,
      bytes: opened.bytes,
      sha256: opened.sha256,
      complete: false,
    })
    const key = resourceKey(handoffID, "tool-output", id)
    const previous = await optional(Storage.read(key, { silentNotFound: true }))
    if (previous && JSON.stringify(info(Resource.parse(previous))) !== JSON.stringify(info(value)))
      fail("Portable tool output identity changed")
    if (dependency.reference !== opened.reference)
      await Storage.write(
        [...aliasesKey(handoffID), hash(dependency.reference)],
        Alias.parse({ alias: dependency.reference, id }),
      )
    if (previous && Resource.parse(previous).complete) return
    await Storage.write(key, value)
    const decoder = new TextDecoder("utf-8", { fatal: true })
    let body = ""
    for await (const block of opened.stream(signal)) {
      signal.throwIfAborted()
      body += decoder.decode(block, { stream: true })
    }
    body += decoder.decode()
    for (const reference of SessionTransferReferences.markdown(body)) await capture(context, ownerID, reference)
    await Storage.write(key, { ...value, complete: true })
  }

  export async function seal(input: { root: Owners.SourceContext; sessions: AsyncIterable<Owners.SourceContext> }) {
    const context = input.root
    if (context.session.id !== context.rootSessionID || context.session.parentID)
      fail("Evidence must be sealed by the aggregate root")
    using lease = await Lock.write("session-transfer-evidence:" + context.handoffID)
    await Epochs.assertFrozen(context.session.id, context.handoffID)
    const previous = await optional(Storage.read(stateKey(context.handoffID), { silentNotFound: true }))
    if (previous) {
      const state = State.parse(previous)
      if (state.rootSessionID !== context.rootSessionID || state.scopeID !== context.session.scope.id)
        fail("Portable evidence belongs to another aggregate")
      if (state.phase === "sealed") return sealed(context)
    } else
      await Storage.write(stateKey(context.handoffID), {
        version: 1,
        handoffID: context.handoffID,
        rootSessionID: context.rootSessionID,
        scopeID: context.session.scope.id,
        phase: "building",
        members: 0,
        assets: 0,
        outputs: 0,
        aliases: 0,
      })
    for await (const member of input.sessions) {
      context.signal.throwIfAborted()
      if (
        member.handoffID !== context.handoffID ||
        member.rootSessionID !== context.rootSessionID ||
        member.session.scope.id !== context.session.scope.id
      )
        fail("Portable evidence member has another aggregate")
      const binding = await Epochs.ownerPreparationBinding({
        sessionID: member.session.id,
        handoffID: context.handoffID,
      })
      if ((binding.rootSessionID ?? binding.sessionID) !== context.rootSessionID)
        fail("Portable evidence member has another frozen root")
      await Epochs.assertFrozen(member.session.id, context.handoffID)
      const owners = await Owners.selected(member)
      await Storage.write(
        memberKey(context.handoffID, member.session.id),
        Member.parse({ version: 1, sessionID: member.session.id, owners: Owners.versions(owners) }),
      )
      for await (const dependency of Owners.dependencies(member, owners))
        await capture(member, dependency.ownerID, dependency)
    }
    if (!(await optional(Storage.read(memberKey(context.handoffID, context.rootSessionID), { silentNotFound: true }))))
      fail("Portable evidence omitted its root")
    const pending = [...root(context.handoffID), "pending"]
    const visited = [...root(context.handoffID), "visited"]
    await clear(pending)
    await clear(visited)
    await Storage.write([...pending, context.rootSessionID], { sessionID: context.rootSessionID })
    let members = 0
    for (;;) {
      context.signal.throwIfAborted()
      const [next] = await Storage.query<{ sessionID: string }>({ prefix: pending, limit: 1 })
      if (!next) break
      const member = Member.parse(await Storage.read(memberKey(context.handoffID, next.value.sessionID)))
      const session = await Session.get(member.sessionID)
      if (
        session.id !== context.rootSessionID &&
        (!session.parentID ||
          !(await optional(Storage.read(memberKey(context.handoffID, session.parentID), { silentNotFound: true }))))
      )
        fail("Portable aggregate includes unrelated Session history")
      await Epochs.assertFrozen(session.id, context.handoffID)
      const current = { ...context, session }
      const inspected = await Owners.inspect(current, Object.keys(member.owners))
      if (inspected.requirements.length)
        throw new Owners.Rejected({
          message: "Portable aggregate has unresolved owner dependencies",
          requirements: inspected.requirements,
        })
      for await (const child of inspected.children) {
        if (!(await optional(Storage.read(memberKey(context.handoffID, child), { silentNotFound: true }))))
          fail("Portable aggregate omitted a required child", "aggregate_child_missing")
        if (!(await optional(Storage.read([...visited, child], { silentNotFound: true }))) && child !== session.id)
          await Storage.write([...pending, child], { sessionID: child })
      }
      await Storage.write([...visited, session.id], { version: 1 })
      await Storage.remove(next.key)
      members++
    }
    if (members !== (await Storage.count({ prefix: membersKey(context.handoffID) })))
      fail("Portable aggregate includes unreachable Session history")
    await clear(pending)
    await clear(visited)
    let assets = 0
    let outputs = 0
    for await (const row of Storage.records({ prefix: resourcesKey(context.handoffID), limit: 128 })) {
      const value = Resource.parse(row.value)
      if (!value.complete) fail("Portable resource dependencies are incomplete")
      if (value.kind === "asset") assets++
      else outputs++
    }
    const aliases = await Storage.count({ prefix: aliasesKey(context.handoffID) })
    const state = State.parse({
      version: 1,
      handoffID: context.handoffID,
      rootSessionID: context.rootSessionID,
      scopeID: context.session.scope.id,
      phase: "sealed",
      members,
      assets,
      outputs,
      aliases,
    })
    await Storage.write(stateKey(context.handoffID), state)
    return manifest(state)
  }

  async function sealed(context: Owners.SourceContext) {
    await Epochs.assertFrozen(context.session.id, context.handoffID)
    const state = State.parse(await Storage.read(stateKey(context.handoffID)))
    if (
      state.phase !== "sealed" ||
      state.rootSessionID !== context.session.id ||
      state.scopeID !== context.session.scope.id
    )
      fail("Portable aggregate dependencies must be sealed before export")
    for await (const row of Storage.records({ prefix: membersKey(context.handoffID), limit: 64 })) {
      context.signal.throwIfAborted()
      const member = Member.parse(row.value)
      await Epochs.assertFrozen(member.sessionID, context.handoffID)
      if (JSON.stringify(Owners.versions(Object.keys(member.owners))) !== JSON.stringify(member.owners))
        fail("The source owner versions changed after evidence was frozen", "source_owner_changed")
    }
    for await (const row of Storage.records({ prefix: originsKey(context.handoffID), limit: 64 })) {
      context.signal.throwIfAborted()
      const origin = Origin.parse(row.value)
      await authorize({ ...context, session: await Session.get(origin.sessionID) }, origin.ownerID, {
        kind: origin.kind,
        reference: origin.reference,
      })
    }
    return manifest(state)
  }

  export async function* members(context: Owners.SourceContext) {
    await sealed(context)
    for await (const row of Storage.records({ prefix: membersKey(context.handoffID), limit: 64 }))
      yield Member.parse(row.value)
  }

  async function* entries(context: Owners.SourceContext): AsyncGenerator<SessionTransferStream.Input> {
    const manifest = await sealed(context)
    const record = (key: string[], value: unknown): SessionTransferStream.Input => ({
      id: JSON.stringify([ID, "record", key]),
      kind: "record",
      metadata: { key },
      content: encode(value),
    })
    yield record(manifestKey(context.session.id), manifest)
    for await (const row of Storage.records({ prefix: membersKey(context.handoffID), limit: 64 })) {
      const value = Member.parse(row.value)
      yield record(portableMemberKey(context.session.id, value.sessionID), value)
    }
    for await (const row of Storage.records({ prefix: resourcesKey(context.handoffID), limit: 128 })) {
      context.signal.throwIfAborted()
      const value = Resource.parse(row.value)
      if (!value.complete) fail("Portable resource dependencies are incomplete")
      yield record(metadataKey(value), value.kind === "asset" ? info(value) : { version: 1, ...info(value) })
      const key = dataKey(value)
      if (value.kind === "asset") {
        const opened = await Asset.open(value.id, context.signal)
        if (!opened || opened.bytes !== value.bytes || opened.sha256 !== value.sha256)
          fail("A sealed Asset changed before export")
        yield {
          id: JSON.stringify([ID, "artifact", key]),
          kind: "artifact",
          metadata: { key },
          content: opened.stream(context.signal),
        }
      } else {
        const opened = await StoredToolOutput.open("tool-output://" + value.id)
        if (opened.bytes !== value.bytes || opened.sha256 !== value.sha256)
          fail("A sealed tool output changed before export")
        yield {
          id: JSON.stringify([ID, "artifact", key]),
          kind: "artifact",
          metadata: { key },
          content: opened.stream(context.signal),
        }
      }
    }
    for await (const row of Storage.records({ prefix: aliasesKey(context.handoffID), limit: 128 })) {
      const value = Alias.parse(row.value)
      yield record(aliasKey(value.alias), value)
    }
  }

  function resource(key: string[]): { kind: "asset" | "tool-output"; id: string; metadata: string[] } {
    if (key.length === 2 && key[0] === "assets" && AssetReference.isValidId(key[1]))
      return { kind: "asset", id: key[1], metadata: assetInfoKey(key[1]) }
    if (key.length === 3 && key[0] === "tool_outputs" && key[2] === "content") {
      const id = OutputID.parse(key[1])
      return { kind: "tool-output", id, metadata: outputInfoKey(id) }
    }
    fail("Portable evidence contains an unrelated binary owner")
  }

  async function validate(context: Owners.TargetContext) {
    preparations.delete(context)
    if (Storage.inTransaction()) fail("Immutable dependencies must be prepared before Session activation")
    const manifestRecord = await context.staged.record(manifestKey(context.session.id))
    if (!manifestRecord) fail("Portable evidence manifest is missing")
    const manifest = Manifest.parse(manifestRecord.value)
    if (
      manifest.rootSessionID !== context.session.id ||
      manifest.handoffID !== context.handoffID ||
      manifest.scopeID !== context.session.scope.id
    )
      fail("Portable evidence manifest has another aggregate")
    const rootMember = await context.staged.record(portableMemberKey(context.session.id, context.session.id))
    if (
      !rootMember ||
      !Member.parse(rootMember.value).owners["session-core"] ||
      !Member.parse(rootMember.value).owners[ID]
    )
      fail("Portable evidence omitted the root's canonical owners")
    let metadata = 0
    let members = 0
    let aliases = 0
    const digest = createHash("sha256")
    for await (const row of context.staged.records()) {
      context.signal.throwIfAborted()
      digest.update(JSON.stringify(row))
      if (JSON.stringify(row.key) === JSON.stringify(manifestKey(context.session.id))) continue
      if (
        row.key.length === 4 &&
        row.key[0] === "session_evidence" &&
        row.key[1] === context.session.id &&
        row.key[2] === "members"
      ) {
        const value = Member.parse(row.value)
        if (value.sessionID !== row.key[3]) fail("Portable evidence member key mismatch")
        const requirements = Owners.compatibility(value.owners)
        if (requirements.length)
          throw new Owners.Rejected({ message: "Portable member owner is unavailable", requirements })
        members++
      } else if (
        (row.key.length === 2 && row.key[0] === "asset_manifest" && AssetReference.isValidId(row.key[1])) ||
        (row.key.length === 3 &&
          row.key[0] === "tool_outputs" &&
          row.key[2] === "info" &&
          OutputID.safeParse(row.key[1]).success)
      ) {
        contentInfo(row.key, row.value)
        metadata++
      } else if (row.key.length === 2 && row.key[0] === "tool_output_aliases") {
        const value = Alias.parse(row.value)
        if (
          JSON.stringify(row.key) !== JSON.stringify(aliasKey(value.alias)) ||
          !(await context.staged.record(outputInfoKey(value.id)))
        )
          fail("Portable tool output alias has no matching content")
        const previous = await optional(Storage.read(row.key, { silentNotFound: true }))
        if (previous !== undefined && JSON.stringify(Alias.parse(previous)) !== JSON.stringify(value))
          fail("Portable tool output alias collides with target data")
        aliases++
      } else fail("Portable evidence contains unrelated metadata")
    }
    let assets = 0
    let outputs = 0
    for await (const artifact of context.staged.artifacts()) {
      context.signal.throwIfAborted()
      const owner = resource(artifact.key)
      const record = await context.staged.record(owner.metadata)
      if (!record) fail("Portable dependency metadata is missing")
      const info = contentInfo(owner.metadata, record.value)
      if (artifact.bytes !== info.bytes || artifact.sha256 !== info.sha256)
        fail("Portable dependency bytes disagree with metadata")
      digest.update(JSON.stringify([artifact.key, artifact.bytes, artifact.sha256]))
      if (owner.kind === "asset") {
        if (!info.sha256.startsWith(owner.id.split(".")[0]!))
          fail("Portable Asset ID does not match its complete checksum")
        await Asset.installStream({ id: owner.id, ...info, content: artifact.read(), signal: context.signal })
        const readable = await Asset.read(owner.id)
        if (!readable || readable.size !== info.bytes) fail("Prepared target Asset is not readable")
        assets++
      } else {
        const previous = await optional(Storage.read(owner.metadata, { silentNotFound: true }))
        if (previous !== undefined && JSON.stringify(contentInfo(owner.metadata, previous)) !== JSON.stringify(info))
          fail("Portable tool output collides with target data")
        const existing = (await Storage.artifactReferences({ prefix: artifact.key, limit: 1 }))[0]
        if (
          existing &&
          (JSON.stringify(existing.key) !== JSON.stringify(artifact.key) ||
            existing.location.size !== info.bytes ||
            existing.location.sha256 !== info.sha256)
        )
          fail("Portable tool output bytes collide with target data")
        let bytes = 0
        const checksum = createHash("sha256")
        const decoder = new TextDecoder("utf-8", { fatal: true })
        for await (const block of artifact.read()) {
          context.signal.throwIfAborted()
          bytes += block.length
          checksum.update(block)
          decoder.decode(block, { stream: true })
        }
        decoder.decode()
        if (bytes !== info.bytes || checksum.digest("hex") !== info.sha256) fail("Prepared tool output bytes changed")
        outputs++
      }
    }
    if (
      assets !== manifest.assets ||
      outputs !== manifest.outputs ||
      metadata !== assets + outputs ||
      members !== manifest.members ||
      aliases !== manifest.aliases
    )
      fail("Portable evidence count closure is incomplete")
    preparations.set(context, { runtime: RuntimeContext.current(), digest: digest.digest("hex") })
  }

  export function prepared(context: Owners.TargetContext) {
    const proof = preparations.get(context)
    if (!proof || proof.runtime !== RuntimeContext.current())
      fail("Portable evidence must have an exact prepared target context")
    return { digest: proof.digest }
  }

  async function publish(context: Owners.TargetContext) {
    Epochs.assertActivation({ sessionID: context.session.id, handoffID: context.handoffID })
    prepared(context)
    for await (const row of context.staged.records()) {
      if (row.key[0] !== "tool_outputs" && row.key[0] !== "tool_output_aliases") continue
      const previous = await optional(Storage.read(row.key, { silentNotFound: true }))
      const schema = row.key[0] === "tool_output_aliases" ? Alias : OutputInfo
      if (previous !== undefined && JSON.stringify(schema.parse(previous)) !== JSON.stringify(schema.parse(row.value)))
        fail("Portable tool output collided during activation")
      await Storage.write(row.key, row.value)
    }
    for await (const artifact of context.staged.artifacts())
      if (resource(artifact.key).kind === "tool-output") await artifact.publish(artifact.key)
  }

  export function register(options?: { sourceAuthority?: SourceAuthority }) {
    Owners.register(ID, {
      version: 1,
      reads: [1],
      applies: (session) => !session.parentID,
      async inspect() {
        return {
          requirements: [],
          children: (async function* () {
            yield* []
          })(),
        }
      },
      async freeze() {},
      export: entries,
      validate,
      publish,
    })
    authority().source = options?.sourceAuthority
  }
}
