import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { createSynergyClient } from "@ericsanchezok/synergy-sdk"
import {
  OrganizationHandoffProtocol as Handoff,
  OrganizationRuntimeProtocol as Runtime,
} from "@ericsanchezok/synergy-organization-protocol"
import { WorkspaceCoordinator } from "@ericsanchezok/synergy-local-runtime/workspace/coordinator"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { TransactionalStore } from "@ericsanchezok/synergy-harness/storage/transactional-store"
import { testRuntime } from "@ericsanchezok/synergy-harness/test/support/runtime"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import {
  SessionTransferSource as NativeSource,
  SessionTransferEpochs as Epochs,
  SessionTransferCore as Core,
} from "@ericsanchezok/synergy-harness/session/transfer"
import { prepareMemberHome } from "../src/home"
import { enrollMemberRuntime } from "../src/enrollment"
import { openMemberRuntime } from "../src/runtime"
import { fixture } from "./support/organization"
import { OrganizationHandoffCleanup as Cleanup } from "../src/handoff-recovery"
import { registerSessionSchema } from "../src/session-schema"
import { registerOrganizationTransferOwner } from "../src/session-transfer"
import { openHandoffCleanup } from "../src/handoff-cleanup-runtime"

async function port() {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() })
  const selected = server.port!
  await server.stop(true)
  return selected
}

type Mode =
  | "surrender"
  | "surrender-unknown"
  | "surrender-empty-ack"
  | "surrender-wrong-ack"
  | "surrender-abort-ack"
  | "cancel-before-freeze"
  | "cancel-after-freeze"
  | "missing"
  | "surrender-foreign-primary"
  | "cancel-before-freeze-wrong-scope"
async function sourceRecovery(mode: Mode) {
  const surrender = mode.startsWith("surrender")
  const step = async <T>(label: string, work: Promise<T>) =>
    work.catch((error: unknown) => {
      throw new Error("Actual Source receipt fixture failed at " + label, { cause: error })
    })
  await using f = await fixture()
  const options = { headers: f.headers, throwOnError: true as const }
  const project = (
    await step(
      "project",
      f.client.orgProjects.create({ orgProjectCreate: { name: "Source receipt recovery" } }, options),
    )
  ).data
  const coordinatorDirectory = path.join(f.root, "source-receipt-coordinator")
  await fs.mkdir(coordinatorDirectory, { mode: 0o700 })
  const workspaceCoordinator = new WorkspaceCoordinator({ directory: coordinatorDirectory })
  async function member(deviceID: string) {
    const home = await prepareMemberHome({
      baseDirectory: path.join(f.root, "members"),
      identity: { ...f.identity, deviceID },
      origin: f.origin,
    })
    const registration = await enrollMemberRuntime({
      home: home.home,
      identity: home.identity,
      ticket: await f.ticket(deviceID, home.publicKey),
      ca: f.ca,
    })
    const connected = Promise.withResolvers<void>()
    const sockets = new Set<unknown>()
    f.interceptFrames((socket, raw) => {
      const frame = Runtime.ClientFrame.parse(JSON.parse(String(raw)))
      if (frame.type === "handshake" && frame.proof.handshake.runtimeID === registration.runtimeID) sockets.add(socket)
      if (frame.type === "heartbeat" && sockets.has(socket)) connected.resolve()
      return false
    })
    const token = (deviceID === "source" ? "a" : "b").repeat(64)
    const listen = { port: await port(), token }
    const runtime = await step(
      "open " + deviceID,
      openMemberRuntime({
        home: home.home,
        identity: home.identity,
        ca: f.ca,
        listen,
        handoff: true,
        workspaceCoordinator,
      }),
    )
    const timer = setTimeout(() => connected.reject(new Error("Source receipt fixture machine did not connect")), 5000)
    try {
      await connected.promise
    } catch (error) {
      await runtime.close()
      throw error
    } finally {
      clearTimeout(timer)
    }
    const client = createSynergyClient({
      baseUrl: `http://127.0.0.1:${listen.port}`,
      headers: { authorization: `Bearer ${token}` },
    })
    return { home, registration, runtime, client, [Symbol.asyncDispose]: () => runtime.close() }
  }
  await using source = await member("source")
  await using target = await member("target")
  f.interceptFrames(undefined)
  const directory = path.join(f.root, "working-directory")
  await fs.mkdir(directory)
  await Bun.write(path.join(directory, "retained.txt"), "Original Source bytes")
  const initial = (
    await step(
      "source project",
      source.client.orgLocalProject.get({ projectID: project.projectID }, { throwOnError: true }),
    )
  ).data
  await step(
    "source directory",
    source.client.orgLocalProject.bind(
      {
        projectID: project.projectID,
        orgLocalProjectBind: { requestID: "original-directory", expectedRevision: initial.revision, directory },
      },
      { throwOnError: true },
    ),
  )
  const created = (
    await step(
      "create",
      f.client.orgSessions.create(
        {
          orgCommandCreateRequest: {
            schemaVersion: 1,
            orgID: f.identity.orgID,
            projectID: project.projectID,
            runtimeID: source.registration.runtimeID,
            requestID: "original-session",
            creation: { operation: "create" },
          },
        },
        options,
      ),
    )
  ).data
  const sessionID = created.effect.sessionID
  const handoffID = "source-receipt-" + mode
  const prepared = (
    await step(
      "handoff",
      f.client.orgHandoff.prepare(
        {
          sessionID,
          orgHandoffPrepare: {
            handoffID,
            targetRuntimeID: target.registration.runtimeID,
            expectedBindingEpoch: 1,
            expectedControlRevision: 0,
            mappingPlanRevision: 1,
          },
        },
        options,
      ),
    )
  ).data
  await step("accept", f.client.orgHandoff.accept({ handoffID, orgHandoffAccept: { mappingPlanRevision: 1 } }, options))
  const drive = (operation: Handoff.Drive["operation"], signal?: AbortSignal) =>
    step(
      operation,
      f.client.orgHandoff.drive(
        { handoffID, orgHandoffDrive: { operation, requestID: crypto.randomUUID() } },
        { ...options, signal },
      ),
    )
  if (!mode.startsWith("cancel-before-freeze")) await drive("prepare-source")
  if (surrender) {
    await drive("prepare-target")
    await f.client.orgHandoff.permit({ handoffID, orgHandoffPermitRequest: { purpose: "handoff-surrender" } }, options)
  } else await f.client.orgHandoff.cancel({ handoffID, body: {} }, options)
  const operation = surrender ? "surrender-source" : "cancel-source"
  const arrived = Promise.withResolvers<Handoff.SignedProof>()
  f.interceptFrames((_socket, raw) => {
    const frame = Runtime.ClientFrame.parse(JSON.parse(String(raw)))
    if (frame.type !== "receipt" || frame.reply.kind !== "handoff" || frame.reply.result.operation !== operation)
      return false
    const fact = frame.reply.result.facts[0]
    if (!fact) throw new Error("Original Source did not return its durable receipt")
    arrived.resolve(fact)
    return true
  })
  let original: Handoff.SignedProof | undefined
  if (mode !== "missing") {
    const observer = new AbortController()
    const unknown = drive(operation, observer.signal)
    void unknown.catch(() => {})
    original = await Promise.race([
      arrived.promise,
      unknown.then(() => {
        throw new Error("Source returned without its original durable fact")
      }),
    ])
    observer.abort(new Error("Original Source acknowledgement was not observed"))
    await expect(unknown).rejects.toThrow()
  }
  f.interceptFrames(undefined)
  const binding = {
    sessionID,
    scopeID: project.projectID,
    handoffID,
    sourceID: source.registration.runtimeID,
    targetID: target.registration.runtimeID,
    fromEpoch: prepared.fromEpoch,
    toEpoch: prepared.toEpoch,
  }
  await source.runtime.run(async () => {
    expect(await Epochs.inspect(binding)).toMatchObject({
      role: "source",
      phase: mode === "missing" ? "frozen" : surrender ? "surrendered" : "cancelled",
    })
    if (mode === "missing") expect(await NativeSource.retainedReceipt({ handoffID, sessionID })).toBeUndefined()
    else
      expect(
        surrender ? await NativeSource.surrendered(binding) : await NativeSource.cancellation(binding),
      ).toBeDefined()
    expect((await Session.get(sessionID)).paused).toBeDefined()
  })
  if (mode === "surrender-foreign-primary") {
    const foreign = await TransactionalStore.open({
      backend: "sqlite",
      filename: path.join(f.root, "foreign.sqlite"),
      namespace: "foreign-source-receipt",
    })
    await using closeForeign = { [Symbol.asyncDispose]: () => foreign.close() }
    const rows = await source.runtime.run(() =>
      Storage.snapshot(async (tx) => {
        const rows: Array<{ key: string[]; value: unknown }> = []
        for await (const entry of tx.exportEntries())
          if (entry.type === "record") rows.push({ key: entry.key, value: entry.value })
        return rows
      }),
    )
    await foreign.transaction((tx) => tx.writeMany(rows))
    const outcome = await source.runtime
      .run(() => {
        const handle = Storage.current()
        return Storage.provide({ ...handle, store: foreign }, () => Cleanup.sourceReceipt(handoffID))
      })
      .then(
        () => ({ kind: "resolved" as const }),
        (error: unknown) => ({ kind: "rejected" as const, error }),
      )
    expect(outcome.kind).toBe("rejected")
    expect((await f.client.orgHandoff.get({ handoffID }, options)).data.phase).toBe("prepared")
    return
  }
  if (mode === "cancel-before-freeze-wrong-scope") {
    await using wrongScope = await testRuntime({
      home: path.join(f.root, "other-native-scope"),
      register() {
        Core.register()
        registerSessionSchema({ orgID: f.identity.orgID })
        registerOrganizationTransferOwner()
      },
    })
    const records = await wrongScope.run(async () => {
      const scope = await Scope.registerProject({
        type: "project",
        id: "another-native-project",
        local: null,
        time: { created: 1, updated: 1 },
      })
      await ScopeContext.provide({
        scope,
        workspace: null,
        fn: async () => {
          await Session.create({
            id: sessionID,
            organization: {
              schemaVersion: 1,
              orgID: f.identity.orgID,
              projectID: scope.id,
              creatorID: f.identity.accountID,
              driverRuntimeID: binding.sourceID,
              bindingEpoch: binding.fromEpoch,
            },
            workspaceID: null,
            environmentID: null,
          })
          const values = new Map<string, Uint8Array>()
          await NativeSource.cancel({
            binding: { ...binding, scopeID: scope.id },
            signal: new AbortController().signal,
            store: {
              async put(hash, bytes) {
                values.set(hash, Uint8Array.from(bytes))
              },
              async get(hash, maximum) {
                const bytes = values.get(hash)
                if (!bytes || bytes.length > maximum) throw new Error("Missing actual foreign Scope object")
                return bytes
              },
            },
            async verify() {},
          })
        },
      })
      const records: Array<{ key: string[]; value: unknown }> = []
      for await (const row of Storage.records({ prefix: [], limit: 128 }))
        if (row.key[0]?.startsWith("session_transfer_")) records.push(row)
      return records
    })
    await source.runtime.run(() => Storage.transaction((tx) => tx.writeMany(records)))
    const outcome = await source.runtime
      .run(() => Cleanup.sourceReceipt(handoffID))
      .then(
        () => ({ kind: "resolved" as const }),
        (error: unknown) => ({ kind: "rejected" as const, error }),
      )
    expect(outcome.kind).toBe("rejected")
    expect((await f.client.orgHandoff.get({ handoffID }, options)).data.phase).toBe("preparing")
    return
  }
  const registration = (await f.client.orgRuntime.get({ runtimeID: source.registration.runtimeID }, options)).data
  await f.client.orgRuntime.revoke(
    { runtimeID: registration.runtimeID, orgRuntimeRevoke: { expectedRevision: registration.revision } },
    options,
  )
  await source.runtime.close()
  const requests: string[] = []
  let proofPosts = 0
  const receiptObserver = new AbortController()
  f.interceptHTTP(async (request) => {
    const route = new URL(request.url).pathname
    if (!request.headers.has("origin") && !request.headers.has("cookie")) requests.push(route)
    if (route !== "/runtime/v1/handoffs/proof") return undefined
    proofPosts++
    if (
      !["surrender-unknown", "surrender-empty-ack", "surrender-wrong-ack", "surrender-abort-ack"].includes(mode) ||
      proofPosts !== 1
    )
      return undefined
    const committed = await f.service.fetch(request)
    expect(committed.status).toBe(200)
    if (mode === "surrender-empty-ack") return Response.json(null)
    if (mode === "surrender-wrong-ack")
      return Response.json({
        ...Handoff.FactAcknowledgement.parse(await committed.json()),
        factHash: "f".repeat(64),
      })
    if (mode === "surrender-abort-ack") {
      receiptObserver.abort(new Error("Original Source proof observer ended after the service commit"))
      return committed
    }
    return Response.json(
      {
        code: "SERVICE_UNAVAILABLE",
        message: "Source proof acknowledgement was lost",
        outcome: "unknown",
        retryable: false,
      },
      { status: 503 },
    )
  })
  async function invoke() {
    const child = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        "--no-bunfig",
        path.join(import.meta.dir, "support/runtime-cleanup-entry.ts"),
        "cleanup",
        "source-receipt",
      ],
      {
        cwd: process.env.SYNERGY_TEST_ROOT,
        env: {
          ...process.env,
          SYNERGY_HOME: source.home.home,
          SYNERGY_RUNTIME_ROOT: undefined,
          SYNERGY_TEST_CLEANUP_COORDINATOR: coordinatorDirectory,
          NODE_OPTIONS: undefined,
        },
        stdin: Buffer.from(
          JSON.stringify({
            version: 1,
            identity: source.home.identity,
            deploymentIncarnation: source.registration.deploymentIncarnation,
            ca: f.ca,
            handoffID,
          }),
        ),
        stdout: "pipe",
        stderr: "pipe",
        timeout: 30_000,
      },
    )
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    return { code, stdout, stderr }
  }
  const badAcknowledgement = ["surrender-empty-ack", "surrender-wrong-ack", "surrender-abort-ack"].includes(mode)
  if (badAcknowledgement) {
    await using recovery = await openHandoffCleanup(
      {
        version: 1,
        home: source.home.home,
        identity: source.home.identity,
        deploymentIncarnation: source.registration.deploymentIncarnation,
        ca: f.ca,
        readonly: true,
      },
      { workspaceCoordinator },
    )
    await expect(recovery.sourceReceipt(handoffID, { signal: receiptObserver.signal })).rejects.toMatchObject({
      data: { outcome: "unknown" },
    })
    expect((await f.client.orgHandoff.get({ handoffID }, options)).data.phase).toBe("surrendered")
  }
  let result = await invoke()
  if (badAcknowledgement) expect(proofPosts).toBe(2)
  if (mode === "missing") {
    expect(result.code).not.toBe(0)
    expect(result.stderr).toContain("no complete durable")
    expect(requests).toEqual(["/runtime/v1/handoffs/recovery"])
    expect((await f.client.orgHandoff.get({ handoffID }, options)).data.phase).toBe("preparing")
    return
  }
  if (mode === "surrender-unknown") {
    expect(result.code).not.toBe(0)
    expect(result.stderr).toContain("unknown")
    expect((await f.client.orgHandoff.get({ handoffID }, options)).data.phase).toBe("surrendered")
    result = await invoke()
    expect(proofPosts).toBe(2)
  }
  expect({ code: result.code, stderr: result.stderr }).toEqual({ code: 0, stderr: "" })
  if (!original) throw new Error("Missing actual original Source fact")
  expect(Handoff.FactAcknowledgement.parse(JSON.parse(result.stdout))).toMatchObject({
    ...Handoff.Binding.strip().parse(original.proof),
    purpose: original.proof.purpose,
    factHash: await Handoff.proofHash(original.proof),
  })
  expect(new Set(requests)).toEqual(new Set(["/runtime/v1/handoffs/recovery", "/runtime/v1/handoffs/proof"]))
  expect((await f.client.orgHandoff.get({ handoffID }, options)).data.phase).toBe(
    surrender ? "surrendered" : "cancelled",
  )
  expect(await Bun.file(path.join(directory, "retained.txt")).text()).toBe("Original Source bytes")
}

test.each(["surrender", "surrender-unknown", "cancel-before-freeze", "cancel-after-freeze", "missing"] as const)(
  "the original cold Source reconciles its retained %s receipt after device revocation",
  sourceRecovery,
  30_000,
)
test(
  "Source receipt recovery rejects a real foreign namespace under the original enrolled Home",
  () => sourceRecovery("surrender-foreign-primary"),
  30_000,
)
test(
  "Source receipt recovery rejects a genuine cancellation belonging to another native Scope",
  () => sourceRecovery("cancel-before-freeze-wrong-scope"),
  30_000,
)
test.each(["surrender-empty-ack", "surrender-wrong-ack", "surrender-abort-ack"] as const)(
  "Source receipt recovery preserves unknown after a committed %s reply and retries the same native fact",
  sourceRecovery,
  30_000,
)
