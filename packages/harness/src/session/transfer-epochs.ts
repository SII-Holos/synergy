import { z } from "zod"
import { RuntimeContext } from "../lifecycle/context"
import { Storage } from "../storage/storage"
import { StorageMutationGuard } from "../storage/mutation-guard"
import { Lock } from "../util/lock"
import { Session } from "."
import { SessionManager } from "./manager"
import { LoopJob } from "./loop-job"
import { MigrationRegistry } from "../migration/registry"
import type { Migration } from "../migration/types"
import { NamedError } from "@ericsanchezok/synergy-util/error"
import { SessionTransferFreezeAuthority } from "./transfer-freeze-authority"
import { SessionInteraction } from "./interaction"

export namespace SessionTransferEpochs {
  export const Rejected = NamedError.create("SessionTransferEpochRejected", z.object({ message: z.string() }))
  const ID = z.string().min(1).max(4096)
  const Hash = z.string().regex(/^[a-f0-9]{64}$/)
  const Epoch = z.number().int().positive().safe()
  export const Binding = z
    .strictObject({
      sessionID: ID,
      scopeID: ID,
      handoffID: ID,
      sourceID: ID,
      targetID: ID,
      fromEpoch: Epoch,
      toEpoch: Epoch,
      rootSessionID: ID.optional(),
    })
    .refine((value) => value.toEpoch > value.fromEpoch && value.sourceID !== value.targetID)
  export type Binding = z.infer<typeof Binding>
  const Supersedes = z.strictObject({ handoffID: ID, fromEpoch: Epoch, manifestHash: Hash })
  const State = z.strictObject({
    version: z.literal(1),
    binding: Binding,
    role: z.enum(["source", "target"]),
    phase: z.enum(["draining", "frozen", "surrendered", "cancelled", "prepared", "activated", "never_activate"]),
    manifestHash: Hash.optional(),
    preparedHash: Hash.optional(),
    supersedes: Supersedes.optional(),
  })
  type State = z.infer<typeof State>
  const Pointer = z.strictObject({
    version: z.literal(1),
    scopeID: ID,
    epoch: Epoch,
    handoffID: ID.optional(),
    fromEpoch: Epoch.optional(),
    uncertain: z.boolean().optional(),
    rootSessionID: ID.optional(),
    lastHandoffID: ID.optional(),
    lastFromEpoch: Epoch.optional(),
  })
  const currentKey = (sessionID: string) => ["session_transfer_epoch_current", sessionID]
  const reservationKey = (sessionID: string) => ["session_transfer_epoch_reservation", sessionID]
  const sourceIntentKey = (sessionID: string) => ["session_transfer_epoch_source_intent", sessionID]
  const SourceIntent = z.strictObject({ version: z.literal(1), binding: Binding })
  const watermarkKey = (sessionID: string) => ["session_transfer_epoch_watermark", sessionID]
  const handoffKey = (sessionID: string, handoffID: string) => ["session_transfer_epoch_handoff", sessionID, handoffID]
  const HandoffIndex = z.strictObject({ version: z.literal(1), fromEpoch: Epoch })
  const legacyKey = (sessionID: string) => ["session_transfer_epoch_legacy", sessionID]
  const Watermark = z.strictObject({ version: z.literal(1), scopeID: ID, epoch: Epoch })
  const stateKey = (binding: Pick<Binding, "sessionID" | "fromEpoch" | "handoffID">) => [
    "session_transfer_epochs",
    binding.sessionID,
    String(binding.fromEpoch),
    binding.handoffID,
  ]
  const activation = RuntimeContext.createAsyncContext<{
    runtime: RuntimeContext.Instance
    bindings: ReadonlyMap<string, Binding>
  }>()

  async function optional<T>(schema: z.ZodType<T>, key: string[]) {
    const [value] = await Storage.readMany([key])
    return value === undefined ? undefined : schema.parse(value)
  }
  function matches(first: Binding, second: Binding) {
    return Object.keys(Binding.shape).every((key) => first[key as keyof Binding] === second[key as keyof Binding])
  }
  function fail(message: string): never {
    throw new Rejected({ message: "Session transfer " + message })
  }
  async function existing(binding: Binding) {
    const record = await optional(State, stateKey(binding))
    if (!record || !matches(record.binding, binding)) fail("binding is unavailable or changed")
    return record
  }
  async function save(record: State) {
    const indexed = await optional(HandoffIndex, handoffKey(record.binding.sessionID, record.binding.handoffID))
    if (indexed && indexed.fromEpoch !== record.binding.fromEpoch)
      fail("handoff identity cannot be reused at another epoch")
    await Storage.write(stateKey(record.binding), State.parse(record))
    await Storage.write(handoffKey(record.binding.sessionID, record.binding.handoffID), {
      version: 1,
      fromEpoch: record.binding.fromEpoch,
    })
  }
  async function pointer(sessionID: string) {
    return optional(Pointer, currentKey(sessionID))
  }
  async function allocate(binding: Binding) {
    const watermark = await optional(Watermark, watermarkKey(binding.sessionID))
    if (watermark && (watermark.scopeID !== binding.scopeID || watermark.epoch >= binding.toEpoch))
      fail("reserved epoch has already been used")
    await Storage.write(
      watermarkKey(binding.sessionID),
      Watermark.parse({ version: 1, scopeID: binding.scopeID, epoch: binding.toEpoch }),
    )
  }
  async function frozen(
    sessionID: string,
    visited = new Set<string>(),
    ignoreAdmissionHolds = false,
  ): Promise<boolean> {
    if (visited.has(sessionID)) return true
    visited.add(sessionID)
    try {
      return await inspectFrozen(sessionID, visited, ignoreAdmissionHolds)
    } finally {
      visited.delete(sessionID)
    }
  }
  async function inspectFrozen(
    sessionID: string,
    visited: Set<string>,
    ignoreAdmissionHolds: boolean,
  ): Promise<boolean> {
    const reserved = await optional(State, reservationKey(sessionID))
    if (reserved && reserved.phase !== "activated") return true
    const current = await pointer(sessionID)
    if (current?.uncertain) return true
    if (!ignoreAdmissionHolds) {
      const intent = await optional(SourceIntent, sourceIntentKey(sessionID))
      if (intent && (await existing(intent.binding)).phase === "draining") return true
    }
    const index = await optional(z.object({ scopeID: ID }), ["session_index", sessionID])
    if (index) {
      const info = await optional(z.object({ id: ID, parentID: ID.optional() }), [
        "sessions",
        index.scopeID,
        sessionID,
        "info",
      ])
      if (info?.id === sessionID && info.parentID && (await frozen(info.parentID, visited, ignoreAdmissionHolds)))
        return true
    }
    if (current?.rootSessionID && !ignoreAdmissionHolds) {
      const [root] = await Storage.readMany<unknown>([["sessions", current.scopeID, current.rootSessionID, "info"]])
      const info = z
        .object({ id: ID, paused: z.unknown().optional(), time: z.object({ archived: z.number().optional() }) })
        .safeParse(root)
      if (
        !info.success ||
        info.data.id !== current.rootSessionID ||
        info.data.paused ||
        info.data.time.archived ||
        (await frozen(current.rootSessionID, visited))
      )
        return true
    }
    if (!current?.handoffID || !current.fromEpoch) return false
    const record = await optional(
      State,
      stateKey({ sessionID, fromEpoch: current.fromEpoch, handoffID: current.handoffID }),
    )
    return (
      !record ||
      record.role !== "source" ||
      record.binding.fromEpoch !== current.epoch ||
      ["frozen", "surrendered"].includes(record.phase)
    )
  }
  export const isFrozen = (sessionID: string) => frozen(sessionID)

  export async function assertFrozen(sessionID: string, handoffID: string) {
    const current = await pointer(sessionID)
    if (!current?.handoffID || current.handoffID !== handoffID || !current.fromEpoch)
      fail("requires the exact frozen handoff binding")
    const record = await optional(State, stateKey({ sessionID, fromEpoch: current.fromEpoch, handoffID }))
    if (
      !record ||
      record.binding.sessionID !== sessionID ||
      record.binding.handoffID !== handoffID ||
      record.binding.fromEpoch !== current.epoch ||
      record.role !== "source" ||
      !["frozen", "surrendered"].includes(record.phase)
    )
      fail("requires the exact frozen handoff binding")
  }

  export async function assertOwnerMutation(sessionID: string) {
    if (!Storage.inWriteTransaction()) fail("owner mutation requires its native write transaction")
    const active = activation.getStore()
    const binding = active?.runtime === RuntimeContext.current() ? active.bindings.get(sessionID) : undefined
    if (binding) {
      const reserved = await optional(State, reservationKey(sessionID))
      if (reserved?.role === "target" && reserved.phase === "prepared" && matches(reserved.binding, binding)) return
    }
    if (await frozen(sessionID, new Set(), true)) fail("owns this Session; the current epoch is frozen")
  }

  export function register() {
    MigrationRegistry.register("session-transfer-epochs", migrations)
    StorageMutationGuard.register("session-transfer-epochs", async (transaction, keys, tree) => {
      const ids = [
        ...new Set(
          keys.flatMap((key) =>
            key[0] === "sessions" && key.length >= 3
              ? [key[2]]
              : key[0] === "session_index" && key.length >= 2
                ? [key[1]]
                : key[0] === "snapshot-v2" && key.length >= 4 && ["owners", "deletions", "migrations"].includes(key[2])
                  ? [key[3]]
                  : [],
          ),
        ),
      ]
      const check = assertOwnerMutation
      for (const id of ids) await check(id)
      if (
        !tree ||
        !keys.some(
          (key) =>
            !key.length ||
            (["sessions", "session_index", "snapshot-v2"].includes(key[0]) &&
              key.length < (key[0] === "sessions" ? 3 : key[0] === "snapshot-v2" ? 4 : 2)),
        )
      )
        return
      for (const kind of ["session_transfer_epoch_current", "session_transfer_epoch_reservation"]) {
        let after: string[] | undefined
        for (;;) {
          const rows = await transaction.query({ prefix: [kind], after, limit: 128 })
          for (const row of rows) {
            const sessionID = row.key[1]
            const scopeID =
              kind === "session_transfer_epoch_current"
                ? Pointer.parse(row.value).scopeID
                : State.parse(row.value).binding.scopeID
            if (
              keys.some(
                (key) =>
                  !key.length ||
                  key[0] === "session_index" ||
                  ((key[0] === "sessions" || key[0] === "snapshot-v2") && (!key[1] || key[1] === scopeID)),
              )
            )
              await check(sessionID)
          }
          if (rows.length < 128) break
          after = rows.at(-1)!.key
        }
      }
    })
  }

  export async function upgrade() {
    let count = 0
    for await (const row of Storage.records({ prefix: ["session_transfer_gate"], limit: 128 })) {
      const legacy = z
        .object({ version: z.literal(1), scopeID: ID, migrationID: ID })
        .passthrough()
        .parse(row.value)
      await Storage.write(legacyKey(ID.parse(row.key[1])), { version: 1, gate: legacy })
      count++
    }
    for await (const row of Storage.records({ prefix: ["session_transfer_epochs"], limit: 128 })) {
      const record = State.parse(row.value)
      const binding = record.binding
      await Storage.write(handoffKey(binding.sessionID, binding.handoffID), {
        version: 1,
        fromEpoch: binding.fromEpoch,
      })
      const watermark = await optional(Watermark, watermarkKey(binding.sessionID))
      if (!watermark || watermark.epoch < binding.toEpoch)
        await Storage.write(watermarkKey(binding.sessionID), {
          version: 1,
          scopeID: binding.scopeID,
          epoch: binding.toEpoch,
        })
      if (!(await pointer(binding.sessionID)))
        await Storage.write(
          currentKey(binding.sessionID),
          Pointer.parse({ version: 1, scopeID: binding.scopeID, epoch: binding.fromEpoch, uncertain: true }),
        )
      count++
    }
    return count
  }

  const migrations: Migration[] = [
    {
      id: "20261111-session-transfer-epoch-ledgers",
      description:
        "Retain legacy transfer fences and index permanent binding epoch ledgers without inferring execution authority",
      scope: "global",
      execution: "startup",
      emptyInput: [["session_transfer_gate"], ["session_transfer_epochs"]],
      async up(progress) {
        const count = await upgrade()
        progress(count + 1, count + 1)
      },
    },
  ]

  export async function inspect(value: Binding) {
    return existing(Binding.parse(value))
  }

  export async function targetPreparation(input: { sessionID: string; handoffID: string }) {
    const record = await optional(State, reservationKey(input.sessionID))
    if (
      !record ||
      record.role !== "target" ||
      record.phase !== "prepared" ||
      record.binding.handoffID !== input.handoffID
    )
      fail("owner preparation requires this destination's exact reserved handoff")
    return structuredClone(record)
  }

  export async function ownerPreparationBinding(input: { sessionID: string; handoffID: string }): Promise<Binding> {
    const intent = await optional(SourceIntent, sourceIntentKey(input.sessionID))
    if (!intent || intent.binding.handoffID !== input.handoffID)
      fail("owner preparation requires the current source intent")
    const record = await existing(intent.binding)
    if (record.role !== "source" || (record.phase !== "draining" && record.phase !== "frozen"))
      fail("owner preparation requires a draining or frozen source")
    return structuredClone(record.binding)
  }

  async function aggregateRoot(binding: Binding, info: Session.Info) {
    if (!binding.rootSessionID || binding.rootSessionID === info.id || !info.parentID)
      fail("machine publication requires an aggregate root hold")
    const visited = new Set<string>([info.id])
    let parentID: string | undefined = info.parentID
    while (parentID) {
      if (visited.has(parentID)) fail("has a cyclic internal owner lineage")
      visited.add(parentID)
      const parent = await Session.get(parentID)
      if (parent.scope.id !== binding.scopeID) fail("internal child belongs to another Scope")
      if (parent.id === binding.rootSessionID) return parent
      parentID = parent.parentID
    }
    fail("internal child does not belong to the aggregate root")
  }

  async function ownedChild(binding: Binding, info: Session.Info, owner?: SessionTransferFreezeAuthority.Receipt) {
    if (!owner || !binding.rootSessionID) fail("requires a paused Session or a drained internal owner freeze")
    SessionTransferFreezeAuthority.assert(owner, {
      sessionID: info.id,
      rootSessionID: binding.rootSessionID,
      handoffID: binding.handoffID,
      owners: info.cortex ? ["cortex"] : info.time.archived ? ["session-core"] : undefined,
      domainOwner: !info.time.archived && !info.cortex,
    })
    const root = await aggregateRoot(binding, info)
    if (!root.paused && !(await frozen(root.id))) fail("requires a paused or frozen aggregate root")
  }

  function internal(info: Session.Info) {
    return (
      SessionInteraction.isUnattended(info.interaction) ||
      !!(info.cortex && info.parentID && info.cortex.parentSessionID === info.parentID)
    )
  }

  export async function beginSource(value: Binding) {
    const binding = Binding.parse(value)
    using control = await Lock.write(`session-control:${binding.sessionID}`)
    using transfer = await Lock.write(`session-transfer-epoch:${binding.sessionID}`)
    const info = await Session.get(binding.sessionID)
    if (info.scope.id !== binding.scopeID) fail("source Session is unavailable")
    if (internal(info) || info.time.archived) {
      const root = await aggregateRoot(binding, info)
      if (!root.paused && !(await frozen(root.id))) fail("requires a paused or frozen aggregate root")
    } else if (!info.paused) fail("requires a paused source Session")
    return Storage.transaction(async () => {
      const prior = await optional(State, stateKey(binding))
      if (prior) {
        if (!matches(prior.binding, binding) || prior.role !== "source" || prior.phase === "cancelled")
          fail("source intent identity cannot be reused")
        return prior
      }
      const intent = await optional(SourceIntent, sourceIntentKey(binding.sessionID))
      if (
        intent &&
        intent.binding.fromEpoch >= binding.fromEpoch &&
        (await existing(intent.binding)).phase !== "cancelled"
      )
        fail("another source intent is unresolved")
      if (await frozen(binding.sessionID, new Set(), true)) fail("already owns this Session")
      const current = await pointer(binding.sessionID)
      if (current && current.epoch !== binding.fromEpoch) fail("source epoch is stale")
      await allocate(binding)
      const record = State.parse({ version: 1, binding, role: "source", phase: "draining" })
      await save(record)
      await Storage.write(sourceIntentKey(binding.sessionID), SourceIntent.parse({ version: 1, binding }))
      return record
    })
  }

  export async function freeze(
    value: Binding,
    options: { owner?: SessionTransferFreezeAuthority.Receipt; verify?: () => Promise<void> } = {},
  ) {
    const binding = Binding.parse(value)
    using control = await Lock.write(`session-control:${binding.sessionID}`)
    using transfer = await Lock.write(`session-transfer-epoch:${binding.sessionID}`)
    const info = await Session.get(binding.sessionID)
    if (internal(info) || info.time.archived) await ownedChild(binding, info, options.owner)
    else if (!info.paused) fail("requires a paused Session with drained execution")
    if (
      info.scope.id !== binding.scopeID ||
      SessionManager.isRunning(binding.sessionID) ||
      LoopJob.activeBackgroundCount(binding.sessionID)
    )
      fail("requires a paused Session with drained execution")
    await Session.flushPartWrites(binding.sessionID)
    return Storage.transaction(
      async () => {
        await options.verify?.()
        const previous = await optional(State, stateKey(binding))
        if (previous) {
          if (!matches(previous.binding, binding) || previous.role !== "source" || previous.phase === "cancelled")
            fail("identity cannot be reused")
          if (previous.phase !== "draining") return previous
        }
        if (await frozen(binding.sessionID, new Set(), true)) fail("already owns this Session")
        const current = await pointer(binding.sessionID)
        if (current && current.epoch !== binding.fromEpoch) fail("source epoch is stale")
        const intent = await optional(SourceIntent, sourceIntentKey(binding.sessionID))
        if (
          intent &&
          intent.binding.fromEpoch >= binding.fromEpoch &&
          !matches(intent.binding, binding) &&
          (await existing(intent.binding)).phase !== "cancelled"
        )
          fail("another source intent is unresolved")
        if (!previous) await allocate(binding)
        const record = State.parse({ version: 1, binding, role: "source", phase: "frozen" })
        await save(record)
        await Storage.write(sourceIntentKey(binding.sessionID), SourceIntent.parse({ version: 1, binding }))
        await Storage.write(
          currentKey(binding.sessionID),
          Pointer.parse({
            version: 1,
            scopeID: binding.scopeID,
            epoch: binding.fromEpoch,
            handoffID: binding.handoffID,
            fromEpoch: binding.fromEpoch,
          }),
        )
        return record
      },
      {
        commitGuard: () => {
          if (SessionManager.isRunning(binding.sessionID) || LoopJob.activeBackgroundCount(binding.sessionID))
            fail("requires drained execution before freeze publication")
        },
      },
    )
  }

  export async function seal(value: Binding, hash: string) {
    const binding = Binding.parse(value)
    Hash.parse(hash)
    return Storage.transaction(async () => {
      const record = await existing(binding)
      if (
        record.role !== "source" ||
        record.phase !== "frozen" ||
        (record.manifestHash && record.manifestHash !== hash)
      )
        fail("frozen manifest is immutable")
      record.manifestHash = hash
      await save(record)
      return record
    })
  }

  export async function surrender(value: Binding, preparedHash: string) {
    const binding = Binding.parse(value)
    Hash.parse(preparedHash)
    return Storage.transaction(async () => {
      const record = await existing(binding)
      if (
        record.role !== "source" ||
        !record.manifestHash ||
        !["frozen", "surrendered"].includes(record.phase) ||
        (record.preparedHash && record.preparedHash !== preparedHash)
      )
        fail("cannot surrender this binding")
      record.phase = "surrendered"
      record.preparedHash = preparedHash
      await save(record)
      return record
    })
  }

  export async function cancel(value: Binding) {
    const binding = Binding.parse(value)
    return Storage.transaction(async () => {
      const record = await existing(binding)
      if (record.role !== "source" || !["draining", "frozen", "cancelled"].includes(record.phase))
        fail("cannot cancel after source surrender")
      if (record.phase === "cancelled") return record
      const current = await pointer(binding.sessionID)
      const intent = await optional(SourceIntent, sourceIntentKey(binding.sessionID))
      if (
        (intent && !matches(intent.binding, binding)) ||
        (current &&
          (current.epoch !== binding.fromEpoch || (current.handoffID && current.handoffID !== binding.handoffID)))
      )
        fail("cancellation belongs to a retired source epoch")
      record.phase = "cancelled"
      await save(record)
      await Storage.write(
        currentKey(binding.sessionID),
        Pointer.parse({
          version: 1,
          scopeID: binding.scopeID,
          epoch: binding.fromEpoch,
          rootSessionID: binding.rootSessionID,
          lastHandoffID: binding.handoffID,
          lastFromEpoch: binding.fromEpoch,
        }),
      )
      return record
    })
  }

  export async function reserve(value: Binding, manifestHash: string, previous?: z.infer<typeof Supersedes>) {
    const binding = Binding.parse(value)
    Hash.parse(manifestHash)
    const supersedes = Supersedes.optional().parse(previous)
    return Storage.transaction(async () => {
      const retained = await optional(State, stateKey(binding))
      if (retained) {
        if (retained.role !== "target" || !matches(retained.binding, binding) || retained.manifestHash !== manifestHash)
          fail("destination identity belongs to another transfer")
        return retained
      }
      const [canonical] = await Storage.readMany([["session_index", binding.sessionID]])
      const records = await Storage.query({ prefix: ["sessions", binding.scopeID, binding.sessionID], limit: 1 })
      const usage = await Storage.query({
        prefix: ["usage", binding.scopeID, `session_${binding.sessionID}`],
        limit: 1,
      })
      const artifacts = await Storage.artifactReferences({
        prefix: ["sessions", binding.scopeID, binding.sessionID],
        limit: 1,
      })
      const current = await pointer(binding.sessionID)
      if (canonical || current || records.length || usage.length || artifacts.length) {
        if (
          !supersedes ||
          !current?.handoffID ||
          !current.fromEpoch ||
          current.handoffID !== supersedes.handoffID ||
          current.epoch !== supersedes.fromEpoch
        )
          fail("destination has unrelated Session data")
        const old = await optional(State, stateKey({ sessionID: binding.sessionID, ...supersedes }))
        if (
          !old ||
          old.phase !== "surrendered" ||
          old.role !== "source" ||
          old.manifestHash !== supersedes.manifestHash ||
          old.binding.sourceID !== binding.targetID ||
          old.binding.toEpoch > binding.fromEpoch
        )
          fail("destination has unrelated Session data")
      }
      const reserved = await optional(State, reservationKey(binding.sessionID))
      if (reserved && !["activated", "never_activate"].includes(reserved.phase))
        fail("destination is reserved by another handoff")
      await allocate(binding)
      const record = State.parse({ version: 1, binding, role: "target", phase: "prepared", manifestHash, supersedes })
      await save(record)
      await Storage.write(reservationKey(binding.sessionID), record)
      return record
    })
  }

  export async function activate(value: Binding, manifestHash: string, publish: () => Promise<void>) {
    return (await activateMany({ bindings: [value], manifestHash, publish }))[0]
  }

  export function assertActivation(input: { sessionID: string; handoffID: string }) {
    const active = activation.getStore()
    const binding = active?.runtime === RuntimeContext.current() ? active.bindings.get(input.sessionID) : undefined
    if (!Storage.inWriteTransaction() || !binding || binding.handoffID !== input.handoffID)
      fail("publication requires this Session's exact destination activation authority")
    return structuredClone(binding)
  }

  export async function activateMany(input: {
    bindings: readonly Binding[]
    manifestHash: string
    publish: () => Promise<void>
  }) {
    const bindings = input.bindings.map((binding) => Binding.parse(binding))
    const first = bindings[0]
    if (!first || new Set(bindings.map((binding) => binding.sessionID)).size !== bindings.length)
      fail("aggregate activation requires distinct Sessions")
    const rootID = first.rootSessionID ?? first.sessionID
    if (
      bindings.some(
        (binding) =>
          (binding.rootSessionID ?? binding.sessionID) !== rootID ||
          binding.handoffID !== first.handoffID ||
          binding.sourceID !== first.sourceID ||
          binding.targetID !== first.targetID ||
          binding.scopeID !== first.scopeID ||
          binding.fromEpoch !== first.fromEpoch ||
          binding.toEpoch !== first.toEpoch,
      )
    )
      fail("aggregate activation bindings disagree")
    Hash.parse(input.manifestHash)
    const locks: Disposable[] = []
    try {
      for (const id of bindings.map((binding) => binding.sessionID).sort())
        locks.push(await Lock.write(`session-transfer-epoch:${id}`))
      return await Storage.transaction(async () => {
        const records: State[] = []
        for (const binding of bindings) {
          const record = await existing(binding)
          if (
            record.role !== "target" ||
            record.manifestHash !== input.manifestHash ||
            !["prepared", "activated"].includes(record.phase)
          )
            fail("destination is retired or has different content")
          records.push(record)
        }
        if (records.every((record) => record.phase === "activated")) return records
        if (records.some((record) => record.phase !== "prepared"))
          fail("aggregate destination has inconsistent activation proofs")
        for (const binding of bindings) {
          const reserved = await optional(State, reservationKey(binding.sessionID))
          if (!reserved || !matches(reserved.binding, binding) || reserved.phase !== "prepared")
            fail("destination reservation changed")
        }
        await activation.run(
          {
            runtime: RuntimeContext.current(),
            bindings: new Map(bindings.map((binding) => [binding.sessionID, binding])),
          },
          async () => {
            await input.publish()
            for (const binding of bindings) {
              const restored = await Session.get(binding.sessionID)
              if (internal(restored) || restored.time.archived) {
                const root = await aggregateRoot(binding, restored)
                if (!root.paused) fail("machine publication requires a paused aggregate root")
              } else if (!restored.paused) fail("destination publication must remain paused")
            }
          },
        )
        for (const record of records) {
          const binding = record.binding
          record.phase = "activated"
          await save(record)
          await Storage.write(reservationKey(binding.sessionID), record)
          await Storage.write(
            currentKey(binding.sessionID),
            Pointer.parse({
              version: 1,
              scopeID: binding.scopeID,
              epoch: binding.toEpoch,
              rootSessionID: binding.rootSessionID,
              lastHandoffID: binding.handoffID,
              lastFromEpoch: binding.fromEpoch,
            }),
          )
        }
        return records
      })
    } finally {
      for (const lock of locks.reverse()) lock[Symbol.dispose]()
    }
  }

  export async function neverActivate(value: Binding, manifestHash: string) {
    const binding = Binding.parse(value)
    Hash.parse(manifestHash)
    return Storage.transaction(async () => {
      const record = await existing(binding)
      if (
        record.role !== "target" ||
        record.manifestHash !== manifestHash ||
        !["prepared", "never_activate"].includes(record.phase)
      )
        fail("cannot retire an activated destination")
      if (record.phase === "never_activate") return record
      record.phase = "never_activate"
      await save(record)
      await Storage.write(reservationKey(binding.sessionID), record)
      return record
    })
  }

  export async function assertOwnerResume(input: { sessionID: string; rootSessionID: string; handoffID: string }) {
    const current = await pointer(input.sessionID)
    const intent = await optional(SourceIntent, sourceIntentKey(input.sessionID))
    const indexed = await optional(HandoffIndex, handoffKey(input.sessionID, input.handoffID))
    if (
      !current ||
      !indexed ||
      (intent && intent.binding.fromEpoch >= current.epoch && intent.binding.handoffID !== input.handoffID) ||
      current.lastHandoffID !== input.handoffID ||
      current.lastFromEpoch !== indexed.fromEpoch ||
      (await frozen(input.sessionID))
    )
      fail("owner resume is not authorized by the current transfer epoch")
    const record = await optional(
      State,
      stateKey({ sessionID: input.sessionID, handoffID: input.handoffID, fromEpoch: indexed.fromEpoch }),
    )
    if (
      !record ||
      (record.binding.rootSessionID ?? record.binding.sessionID) !== input.rootSessionID ||
      !(
        (record.role === "source" && record.phase === "cancelled" && current.epoch === record.binding.fromEpoch) ||
        (record.role === "target" && record.phase === "activated" && current.epoch === record.binding.toEpoch)
      )
    )
      fail("owner resume requires a cancelled source or activated destination proof")
    const root = await Session.get(input.rootSessionID)
    const session = input.sessionID === root.id ? root : await Session.get(input.sessionID)
    if (session.time.archived) fail("owner resume cannot continue archived history")
    if (root.paused || root.time.archived || root.scope.id !== record.binding.scopeID || (await frozen(root.id)))
      fail("owner resume requires the aggregate root's independent Continue")
  }

  export async function ownerResumeBinding(input: {
    sessionID: string
    rootSessionID: string
  }): Promise<Binding | undefined> {
    const current = await pointer(input.sessionID)
    if (await frozen(input.sessionID)) fail("owner resume is not authorized while this Session is frozen")
    if (!current?.lastHandoffID || !current.lastFromEpoch) return
    await assertOwnerResume({ ...input, handoffID: current.lastHandoffID })
    const record = await optional(
      State,
      stateKey({ sessionID: input.sessionID, handoffID: current.lastHandoffID, fromEpoch: current.lastFromEpoch }),
    )
    if (!record) fail("owner resume evidence is unavailable")
    return structuredClone(record.binding)
  }
}
