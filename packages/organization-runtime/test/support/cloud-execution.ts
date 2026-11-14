import { expect, spyOn } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { createHash } from "node:crypto"
import { z } from "zod"
import { createSynergyClient } from "@ericsanchezok/synergy-sdk"
import {
  OrganizationCloudProtocol as Cloud,
  OrganizationCommandProtocol as Command,
  OrganizationResourceProtocol as Resource,
  OrganizationRuntimeProtocol as Runtime,
} from "@ericsanchezok/synergy-organization-protocol"
import { AtomicFile } from "@ericsanchezok/synergy-util/atomic-file"
import { testResources } from "@ericsanchezok/synergy-testing/resources"
import { Environment } from "@ericsanchezok/synergy-harness/environment"
import { EnvironmentExecution } from "@ericsanchezok/synergy-harness/environment/execution"
import { ExecutionProtocol } from "@ericsanchezok/synergy-harness/environment/executor"
import type { EnvironmentProvider, EnvironmentRequest } from "@ericsanchezok/synergy-harness/environment/provider"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { SessionInbox } from "@ericsanchezok/synergy-harness/session/inbox"
import { SessionManager } from "@ericsanchezok/synergy-harness/session/manager"
import { SessionExecutionSource } from "@ericsanchezok/synergy-harness/session/execution-source"
import { SessionExecutionContributions } from "@ericsanchezok/synergy-harness/session/execution-contributions"
import { SessionExecutionOwners } from "@ericsanchezok/synergy-harness/session/execution-owners"
import { SessionTransferEpochs } from "@ericsanchezok/synergy-harness/session/transfer"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { RolloutLedger } from "@ericsanchezok/synergy-harness/session/rollout/ledger"
import { RolloutLifecycle } from "@ericsanchezok/synergy-harness/session/rollout/lifecycle"
import { SessionProcessor, ToolResolver } from "@ericsanchezok/synergy-harness/test/support/internals"
import { testRuntime as physicalRuntime } from "@ericsanchezok/synergy-harness/test/support/runtime"
import { MessageV2 } from "@ericsanchezok/synergy-harness/session/message-v2"
import { Agent } from "@ericsanchezok/synergy-harness/agent/agent"
import { Provider } from "@ericsanchezok/synergy-harness/provider/provider"
import { Identifier } from "@ericsanchezok/synergy-harness/id/id"
import { PrimaryAgentIdentity } from "@ericsanchezok/synergy-harness/agent/primary-identity"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { StoragePath } from "@ericsanchezok/synergy-harness/storage/path"
import { WorkspaceCatalog } from "@ericsanchezok/synergy-harness/workspace"
import { NativeExecutor } from "@ericsanchezok/synergy-local-runtime/environment/native-executor"
import { SandboxBackend } from "@ericsanchezok/synergy-local-runtime/sandbox/backend"
import { registerLocalRuntime } from "@ericsanchezok/synergy-local-runtime/register"
import { WorkspaceAccess } from "@ericsanchezok/synergy-harness/workspace/access"
import { WorkspaceCoordinator } from "@ericsanchezok/synergy-local-runtime/workspace/coordinator"
import type { ProcessTool } from "@ericsanchezok/synergy-local-runtime/tools/process"
import { prepareHostedHome, prepareMemberHome } from "../../src/home"
import { enrollHostedRuntime, enrollMemberRuntime } from "../../src/enrollment"
import { openHostedRuntime, openMemberRuntime } from "../../src/runtime"
import { fixture } from "./organization"

type FailureMetadata = {
  name: string
  message?: string
  code?: string
  outcome?: string
  cause?: FailureMetadata
  errors?: FailureMetadata[]
}

function failureMetadata(error: unknown, depth = 0): FailureMetadata {
  if (depth > 12) return { name: "Failure depth exceeded" }
  if (!(error instanceof Error)) return { name: "Non-Error failure" }
  const details = z
    .object({ code: z.string().optional(), message: z.string().optional(), outcome: z.string().optional() })
    .safeParse("data" in error ? error.data : error)
  return {
    name: error.name,
    message: error.message,
    ...(details.success ? details.data : {}),
    ...(error.cause !== undefined ? { cause: failureMetadata(error.cause, depth + 1) } : {}),
    ...(error instanceof AggregateError
      ? { errors: error.errors.slice(0, 32).map((item) => failureMetadata(item, depth + 1)) }
      : {}),
  }
}

async function availablePort() {
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() })
  const port = probe.port!
  await probe.stop(true)
  return port
}

function bindPhysicalExecutor(
  executor: NativeExecutor,
  physical: Awaited<ReturnType<typeof physicalRuntime>>,
  observedStdin: (id: string, data: Uint8Array, end: boolean) => void,
  preparedSandbox: (input: ExecutionProtocol.SandboxInput, result: ExecutionProtocol.Sandbox) => Promise<void>,
  started: () => void,
  effect: (action: "cancel" | "release" | "preparation", id: string) => void,
  beforeCancel: (id: string, digest: string) => Promise<void>,
) {
  const files = executor.files
  return {
    files: {
      mount: physical.bind(files.mount.bind(files)),
      inspect: physical.bind(files.inspect.bind(files)),
      observe: physical.bind(files.observe.bind(files)),
      detach: physical.bind(files.detach.bind(files)),
      stat: physical.bind(files.stat.bind(files)),
      canonical: physical.bind(files.canonical.bind(files)),
      read: physical.bind(files.read.bind(files)),
      list: physical.bind(files.list.bind(files)),
      write: physical.bind(files.write.bind(files)),
      mutate: physical.bind(files.mutate.bind(files)),
      checkpoint: physical.bind(files.checkpoint.bind(files)),
      acknowledge: physical.bind(files.acknowledge.bind(files)),
      checkpointStatus: physical.bind(files.checkpointStatus.bind(files)),
      putBlob: physical.bind(files.putBlob.bind(files)),
      getBlob: physical.bind(files.getBlob.bind(files)),
    },
    describe: physical.bind(executor.describe.bind(executor)),
    inspectPreparation: physical.bind(executor.inspectPreparation.bind(executor)),
    releasePreparation: physical.bind(async (id: string) => {
      effect("preparation", id)
      return executor.releasePreparation(id)
    }),
    prepareInputs: physical.bind(executor.prepareInputs.bind(executor)),
    discardInputs: physical.bind(executor.discardInputs.bind(executor)),
    prepareSandbox: physical.bind(async (input: ExecutionProtocol.SandboxInput) => {
      const result = await executor.prepareSandbox(input)
      await preparedSandbox(input, result)
      return result
    }),
    releaseSandbox: physical.bind(executor.releaseSandbox.bind(executor)),
    start: physical.bind(async (input: ExecutionProtocol.Request) => {
      started()
      return executor.start(input)
    }),
    status: physical.bind(executor.status.bind(executor)),
    output: physical.bind(executor.output.bind(executor)),
    stdin: physical.bind(async (id: string, data: Uint8Array, end: boolean = false) => {
      await executor.stdin(id, data, end)
      observedStdin(id, data, end)
    }),
    resize: physical.bind(executor.resize.bind(executor)),
    cancel: physical.bind(async (id: string, digest: string) => {
      effect("cancel", id)
      await beforeCancel(id, digest)
      return executor.cancel(id, digest)
    }),
    release: physical.bind(async (id: string) => {
      effect("release", id)
      return executor.release(id)
    }),
    waitForChange: physical.bind(executor.waitForChange.bind(executor)),
    close: physical.bind(executor.close.bind(executor)),
  }
}

function controlledEnvironment(
  directory: string,
  coordinator: WorkspaceCoordinator,
  physical: Awaited<ReturnType<typeof physicalRuntime>>,
) {
  const Spec = z.strictObject({})
  const Allocation = z.strictObject({ version: z.literal(1), target: Environment.Target })
  const executors = new Map<string, ReturnType<typeof bindPhysicalExecutor>>()
  const stdin = new Map<string, { calls: number; finishInput: boolean; ended: boolean }>()
  const effects = new Map<string, { cancel: number; release: number; preparation: number }>()
  let allocations = 0,
    starts = 0
  type HeldSandbox = { operationID: string; target: Environment.Target; sandboxed: boolean }
  let sandboxGate: { enter(value: HeldSandbox): void; resume: Promise<void>; done(): void } | undefined
  type HeldCancel = { id: string; digest: string; target: Environment.Target }
  let cancelGate: { enter(value: HeldCancel): void; resume: Promise<void>; original?: HeldCancel } | undefined
  const location = (request: EnvironmentRequest) =>
    path.join(directory, createHash("sha256").update(request.environmentID).digest("hex"))
  const target = (request: EnvironmentRequest) =>
    Environment.Target.parse({
      environmentID: request.environmentID,
      allocationID: request.requestID,
      generation: request.generation,
    })
  async function existing(request: EnvironmentRequest) {
    const file = Bun.file(path.join(location(request), "allocation.json"))
    return (await file.exists()) ? Allocation.parse(await file.json()) : undefined
  }
  async function openExecutor(request: EnvironmentRequest, selected: Environment.Target) {
    let executor = executors.get(request.requestID)
    if (!executor) {
      const native = await physical.run(() =>
        NativeExecutor.open({
          target: selected,
          directory: path.join(location(request), request.requestID),
          coordinator,
          sandbox: SandboxBackend,
          files: { acquire: WorkspaceAccess.hostClaim },
          acquire: (command, signal) =>
            WorkspaceAccess.process([...new Set([command.cwd, ...command.useRoots])], signal, {
              retainAfterExit: true,
              durable: true,
              cooperative: command.cooperative,
              mutationRoots: [
                ...(command.mutationRoots ?? []),
                ...(command.preconditions ?? []).map((condition) => condition.canonical),
              ],
            }),
          runtime: {
            shell: process.platform === "win32" ? "cmd.exe" : "/bin/sh",
            directory: path.join(location(request), request.requestID, "work"),
            env: {},
          },
        }),
      )
      executor = bindPhysicalExecutor(
        native,
        physical,
        (id, data, end) => {
          const previous = stdin.get(id)
          stdin.set(id, {
            calls: (previous?.calls ?? 0) + 1,
            finishInput: previous?.finishInput === true || Buffer.from(data).equals(Buffer.from("finish\n")),
            ended: previous?.ended === true || end,
          })
        },
        async (input, result) => {
          const gate = sandboxGate
          if (!gate) return
          sandboxGate = undefined
          if (!input.operationID) throw new Error("Native sandbox has no original physical preparation identity")
          gate.enter({ operationID: input.operationID, target: selected, sandboxed: result.sandboxed })
          try {
            await gate.resume
          } finally {
            gate.done()
          }
        },
        () => starts++,
        (action, id) => {
          const current = effects.get(id) ?? { cancel: 0, release: 0, preparation: 0 }
          current[action]++
          effects.set(id, current)
        },
        async (id, digest) => {
          const gate = cancelGate
          if (!gate) return
          if (!gate.original) {
            gate.original = { id, digest, target: selected }
            gate.enter(gate.original)
          }
          if (
            gate.original.id !== id ||
            gate.original.digest !== digest ||
            !Environment.sameTarget(gate.original.target, selected)
          )
            return
          await gate.resume
        },
      )
      executors.set(request.requestID, executor)
    }
    return executor
  }
  async function connect(request: EnvironmentRequest, selected: Environment.Target) {
    const retained = await existing(request)
    if (
      !retained ||
      !Environment.sameTarget(retained.target, target(request)) ||
      !Environment.sameTarget(selected, retained.target)
    )
      throw new Error("Controlled Environment has another retained allocation")
    return openExecutor(request, selected)
  }
  const provider: EnvironmentProvider = {
    id: "controlled-execution-host",
    ownership: "managed",
    validateSpec: (value) => Spec.parse(value),
    async allocate(request) {
      Spec.parse(request.spec)
      const retained = await existing(request)
      if (retained && !Environment.sameTarget(retained.target, target(request)))
        throw new Error("Controlled Environment cannot replace an unknown allocation")
      await openExecutor(request, target(request))
      if (!retained) {
        await AtomicFile.writeJsonAtomic(
          path.join(location(request), "allocation.json"),
          JSON.stringify({ version: 1, target: target(request) }),
          { private: true, durable: true },
        )
        allocations++
      }
      return { id: request.requestID, capabilities: ["exec", "pty", "files"] }
    },
    async inspect(request) {
      const retained = await existing(request)
      if (!retained) return { state: "absent" }
      if (!Environment.sameTarget(retained.target, target(request))) return { state: "unknown" }
      const root = await fs.stat(path.join(location(request), request.requestID, "work")).catch(() => undefined)
      if (!root?.isDirectory()) return { state: "unknown" }
      return { state: "ready", allocation: { id: request.requestID, capabilities: ["exec", "pty", "files"] } }
    },
    connect,
    async deallocate(request) {
      const retained = await existing(request)
      if (!retained) return
      if (!Environment.sameTarget(retained.target, target(request)))
        throw new Error("Controlled Environment cannot release another allocation")
      await executors.get(request.requestID)?.close()
      executors.delete(request.requestID)
      await fs.unlink(path.join(location(request), "allocation.json"))
    },
    async close() {
      await Promise.all([...executors.values()].map((executor) => executor.close()))
      executors.clear()
    },
  }
  return {
    provider,
    allocations: () => allocations,
    nativeStarts: () => starts,
    nativeEffects: (id: string) => ({ ...(effects.get(id) ?? { cancel: 0, release: 0, preparation: 0 }) }),
    holdCancelOnce() {
      if (cancelGate) throw new Error("A native cancellation is already held")
      const entered = Promise.withResolvers<HeldCancel>(),
        released = Promise.withResolvers<void>()
      const gate = { enter: entered.resolve, resume: released.promise }
      cancelGate = gate
      return {
        entered: entered.promise,
        release() {
          if (cancelGate === gate) cancelGate = undefined
          released.resolve()
        },
      }
    },
    holdSandboxOnce() {
      if (sandboxGate) throw new Error("A native sandbox is already held")
      const entered = Promise.withResolvers<HeldSandbox>(),
        released = Promise.withResolvers<void>(),
        finished = Promise.withResolvers<void>()
      sandboxGate = { enter: entered.resolve, resume: released.promise, done: finished.resolve }
      return { entered: entered.promise, release: () => released.resolve(), finished: finished.promise }
    },
    async preparation(target: Environment.Target, id: string) {
      const executor = executors.get(target.allocationID)
      if (!executor) throw new Error("The original physical preparation executor is unavailable")
      const result = await executor.inspectPreparation(id)
      if (!Environment.sameTarget(result.target, target))
        throw new Error("The original physical preparation belongs to another native allocation")
      return result
    },
    async observation(id: string) {
      for (const executor of executors.values()) {
        const status = await executor.status(id)
        if (!status) continue
        const chunks = await executor.output(id, 0, 128)
        const output = chunks.map((chunk) => Buffer.from(chunk.data, "base64").toString()).join("")
        return {
          state: status.state,
          exitCode: status.exitCode,
          treeDrained: status.treeDrained,
          streamsDrained: status.streamsDrained,
          finishOutput: output.includes("CLOUD_SAVED") || output.includes("ACCEPTED_PROCESS_FINISHED"),
          stdin: stdin.get(id),
        }
      }
    },
    async waitForOutput(id: string, text: string) {
      const signal = AbortSignal.timeout(5000)
      for (;;) {
        signal.throwIfAborted()
        for (const executor of executors.values()) {
          const status = await executor.status(id)
          if (!status) continue
          const chunks = await executor.output(id, 0, 128)
          const output = chunks.map((chunk) => Buffer.from(chunk.data, "base64").toString()).join("")
          if (output.includes(text)) return status
          if (ExecutionProtocol.terminal(status))
            throw new Error("Controlled command ended before its live-file barrier: " + output)
          await executor.waitForChange(id, status, 250)
        }
        if (!executors.size) throw new Error("No real controlled allocation reached command dispatch")
      }
    },
  }
}

export async function cloudExecutionFixture(
  settings: {
    automatic?: true
    modelEndpoint?: string
    modelContext?: number
    controlProfile?: "guarded" | "autonomous"
  } = {},
) {
  const resources = testResources()
  try {
    const directory = await fs.mkdtemp(path.join(process.env.SYNERGY_TEST_ROOT!, "cloud-execution-"))
    resources.defer("cloud execution directory", () => fs.rm(directory, { recursive: true, force: true }))
    const coordinator = new WorkspaceCoordinator({ directory: path.join(directory, "coordination") })
    const physical = await physicalRuntime({
      home: path.join(directory, "physical-home"),
      composition: {
        register() {
          registerLocalRuntime({ environment: "native", workers: false, workspaceCoordinator: coordinator })
        },
      },
    })
    resources.defer("original physical Runtime", () => physical.close())
    const controlled = controlledEnvironment(path.join(directory, "execution-host"), coordinator, physical)
    resources.defer("controlled execution host", () => controlled.provider.close?.())
    const objects = path.join(directory, "objects")
    await fs.mkdir(objects)
    const service = await fixture({
      connections: { heartbeatMs: 25 },
      cloud: {
        blobStores: {
          shared: {
            put: (hash, bytes) => Bun.write(path.join(objects, hash), bytes).then(() => {}),
            get: (hash) => Bun.file(path.join(objects, hash)).bytes(),
          },
        },
        workspaceProfiles: { shared: { blobStore: "shared" } },
        environmentProviders: [controlled.provider],
        environmentProfiles: { controlled: { provider: controlled.provider.id, spec: {} } },
      },
    })
    resources.defer("organization TLS service", () => service[Symbol.asyncDispose]())
    const wake = settings.automatic ? undefined : spyOn(SessionManager, "scheduleWake").mockImplementation(() => {})
    resources.defer("controlled native scheduling", () => wake?.mockRestore())
    const options = { headers: service.headers, throwOnError: true as const }
    const project = (
      await service.client.orgProjects.create({ orgProjectCreate: { name: "Remote execution" } }, options)
    ).data
    async function resource(name: string, configuration: z.infer<typeof Resource.Configuration>) {
      const selected = (
        await service.client.orgResources.create(
          {
            orgResourceCreate: {
              name,
              scope: { kind: "project", projectID: project.projectID },
              configuration,
              credential: { kind: "none" },
            },
          },
          options,
        )
      ).data
      await service.client.orgResourceGrants.set(
        {
          resourceID: selected.resourceID,
          kind: "account",
          subjectID: service.identity.accountID,
          orgResourceGrantChange: { expectedRevision: 0, enabled: true },
        },
        options,
      )
      return selected
    }
    const model = await resource("Selected model", {
      protocol: "openai-compatible",
      endpoint: settings.modelEndpoint ?? "https://provider.example/v1",
      model: Resource.Model.parse({
        id: "controlled",
        name: "Controlled",
        limit: { context: settings.modelContext ?? 8192, output: 1024 },
      }),
    })
    const storage = await resource("Selected shared files", { protocol: "workspace-storage", profile: "shared" })
    const compute = await resource("Selected execution host", { protocol: "environment", profile: "controlled" })
    const workspace = (
      await service.client.orgCloudWorkspaces.create(
        {
          orgCloudWorkspaceCreate: {
            projectID: project.projectID,
            resourceID: storage.resourceID,
            requestID: "selected-workspace",
            name: "Shared execution files",
          },
        },
        options,
      )
    ).data
    const environment = (
      await service.client.orgCloudEnvironments.create(
        {
          orgCloudEnvironmentCreate: {
            projectID: project.projectID,
            resourceID: compute.resourceID,
            requestID: "selected-environment",
            name: "Controlled execution",
          },
        },
        options,
      )
    ).data
    const seeded = (
      await service.client.orgCloudWorkspaces.write(
        {
          workspaceID: workspace.workspaceID,
          orgCloudWorkspaceWrite: {
            operationID: "seed-original-bytes",
            expectedRevision: workspace.revision,
            path: "seed.bin",
            data: Buffer.from([0, 255, 37, 128, 10]).toString("base64"),
            expectedVersion: null,
          },
        },
        options,
      )
    ).data
    const nativeOperations = new Map<string, () => Promise<EnvironmentExecution.Info>>()
    async function machine(
      deviceID: string,
      configuration?: {
        handoff?: true
        nativeDirectory?: string
        hosted?: true
        inputHeaders?: Record<string, string>
      },
    ) {
      const installed = await (async () => {
        if (configuration?.hosted) {
          const home = await prepareHostedHome({
            baseDirectory: path.join(directory, "hosted"),
            identity: { orgID: service.identity.orgID, hostID: deviceID },
            origin: service.origin,
          })
          const ticket = (
            await service.client.orgRuntime.registerHosted(
              { orgHostedRuntimeRegistration: { name: deviceID, publicKey: home.publicKey } },
              options,
            )
          ).data
          const registration = await enrollHostedRuntime({
            home: home.home,
            identity: home.identity,
            ca: service.ca,
            ticket,
          })
          return {
            home,
            registration,
            open: (listen: { port: number; token: string }) =>
              openHostedRuntime({
                home: home.home,
                identity: home.identity,
                ca: service.ca,
                workspaceCoordinator: coordinator,
                listen,
                ...(configuration.handoff ? { handoff: true as const } : {}),
              }),
          }
        }
        const home = await prepareMemberHome({
          baseDirectory: path.join(directory, "members"),
          identity: { ...service.identity, deviceID },
          origin: service.origin,
        })
        const registration = await enrollMemberRuntime({
          home: home.home,
          identity: home.identity,
          ca: service.ca,
          ticket: await service.ticket(deviceID, home.publicKey),
        })
        return {
          home,
          registration,
          open: (listen: { port: number; token: string }) =>
            openMemberRuntime({
              home: home.home,
              identity: home.identity,
              ca: service.ca,
              workspaceCoordinator: coordinator,
              listen,
              ...(configuration?.handoff ? { handoff: true as const } : {}),
            }),
        }
      })()
      const { home, registration } = installed
      const port = await availablePort(),
        token = crypto.randomUUID().replaceAll("-", "").repeat(2)
      async function open() {
        const online = Promise.withResolvers<void>()
        const sockets = new Set<unknown>()
        service.interceptFrames((socket, raw) => {
          const frame = Runtime.ClientFrame.parse(JSON.parse(String(raw)))
          if (frame.type === "handshake" && frame.proof.handshake.runtimeID === registration.runtimeID)
            sockets.add(socket)
          if (frame.type === "heartbeat" && sockets.has(socket)) online.resolve()
          return false
        })
        let opened: Awaited<ReturnType<typeof openMemberRuntime>> | undefined
        let timer: ReturnType<typeof setTimeout> | undefined
        try {
          opened = await installed.open({ port, token })
          timer = setTimeout(() => online.reject(new Error("Original member did not connect")), 5000)
          await online.promise
          return opened
        } catch (error) {
          try {
            await opened?.close()
          } catch (failure) {
            throw new AggregateError([error, failure], "Original member startup and cleanup failed")
          }
          throw error
        } finally {
          clearTimeout(timer)
          service.interceptFrames(undefined)
        }
      }
      let runtime = await open()
      resources.defer("original member Runtime", () => runtime.close())
      const client = createSynergyClient({
        baseUrl: `http://127.0.0.1:${port}`,
        headers: { authorization: `Bearer ${token}` },
      })
      if (configuration?.nativeDirectory) {
        const current = (await client.orgLocalProject.get({ projectID: project.projectID }, { throwOnError: true }))
          .data
        await client.orgLocalProject.bind(
          {
            projectID: project.projectID,
            orgLocalProjectBind: {
              requestID: "native-" + deviceID,
              expectedRevision: current.revision,
              directory: configuration.nativeDirectory,
            },
          },
          { throwOnError: true },
        )
      }
      let sequence = 0
      async function newSession(input?: {
        inputHeaders?: Record<string, string>
        environment?: null
        workspace?: null
        existing?: { sessionID: string; accepted: Command.InputAccepted; queued?: true }
      }) {
        const sessionKey = ++sequence === 1 ? deviceID : `${deviceID}-${sequence}`
        const sessionID =
          input?.existing?.sessionID ??
          (
            await service.client.orgSessions.create(
              {
                orgCommandCreateRequest: {
                  schemaVersion: 1,
                  orgID: service.identity.orgID,
                  projectID: project.projectID,
                  runtimeID: registration.runtimeID,
                  requestID: "create-" + sessionKey,
                  creation: { operation: "create" },
                },
              },
              options,
            )
          ).data.effect.sessionID
        if (!input?.existing)
          await service.client.orgSessionResources.set(
            {
              sessionID,
              orgSessionResourceChange: {
                expectedRevision: 0,
                selection: {
                  modelResourceID: model.resourceID,
                  connectionResourceIDs: [],
                  infrastructure: {
                    workspace:
                      input?.workspace === null
                        ? null
                        : { resourceID: storage.resourceID, workspaceID: workspace.workspaceID },
                    environment:
                      input?.environment === null
                        ? null
                        : { resourceID: compute.resourceID, environmentID: environment.environmentID },
                  },
                },
              },
            },
            options,
          )
        if (input?.inputHeaders && !input.existing)
          await service.client.orgSessions.share({ sessionID, orgShareChange: { expectedShareGeneration: 0 } }, options)
        const profile = settings.controlProfile
        if (!input?.existing && profile)
          await runtime.run(async () => {
            const session = await Session.get(sessionID)
            await ScopeContext.provide({
              scope: session.scope,
              workspace: session.workspace,
              fn: () => Session.updateControlProfile(sessionID, profile),
            })
          })
        let accepted =
          input?.existing?.accepted ??
          (
            await service.client.orgCommands.input(
              {
                sessionID,
                orgCommandInputRequest: {
                  schemaVersion: 1,
                  orgID: service.identity.orgID,
                  sessionID,
                  projectID: project.projectID,
                  runtimeID: registration.runtimeID,
                  requestID: "input-" + sessionKey,
                  input: {
                    operation: "input",
                    mode: "task",
                    parts: [{ type: "text", text: "Read and update the explicitly selected shared files" }],
                  },
                },
              },
              { headers: input?.inputHeaders ?? service.headers, throwOnError: true },
            )
          ).data
        let rootID: string | undefined = input?.existing?.queued
          ? undefined
          : input?.existing?.accepted.effect.messageID
        let finalizedRootID: string | undefined
        async function finalizeFixtureTask(mode: "cleanup" | "terminal" = "cleanup") {
          const selectedRoot = rootID,
            selectedRuntime = runtime
          if (!selectedRoot || finalizedRootID === selectedRoot) return
          await selectedRuntime.run(async () => {
            const assert = () => {
              if (rootID !== selectedRoot || runtime !== selectedRuntime)
                throw new Error("The fixture task changed its original Runtime or Root during finalization")
            }
            assert()
            if (await SessionTransferEpochs.isFrozen(sessionID)) {
              if (mode === "terminal") throw new Error("A frozen fixture task must retain its original owner")
              return
            }
            if (configuration?.handoff) {
              const current = (await service.client.orgSessions.get({ sessionID }, options)).data
              if (current.driverRuntimeID !== registration.runtimeID) {
                if (mode === "terminal") throw new Error("A surrendered fixture task has another current owner")
                return
              }
            }
            const session = await Session.get(sessionID)
            const owner = RolloutLifecycle.owner(session)
            const run = await RolloutLedger.getRun(owner, selectedRoot)
            assert()
            if (mode === "terminal" && !["completed", "failed", "cancelled"].includes(run.status))
              throw new Error("The fixture task requires its actual terminal Run before finalization")
            if (run.status === "running")
              await RolloutLedger.finishRun(owner, selectedRoot, run.recording === "failed" ? "failed" : "completed")
            assert()
            finalizedRootID = selectedRoot
          })
        }
        resources.defer("native accepted Run", () => finalizeFixtureTask())
        async function inRun<T>(
          body: (
            session: Session.Info,
            root: NonNullable<Awaited<ReturnType<typeof SessionExecutionOwners.latestRoot>>>,
          ) => Promise<T>,
        ) {
          return runtime.run(async () => {
            const session = await Session.get(sessionID)
            return ScopeContext.provide({
              scope: session.scope,
              workspace: session.workspace,
              fn: async () => {
                await SessionExecutionSource.authorize({ sessionID, scopeID: session.scope.id })
                if (!rootID) {
                  await Session.updateControlProfile(sessionID, "autonomous")
                  const queued = await SessionInbox.peekTask(sessionID)
                  expect(queued?.messageID).toBe(accepted.effect.messageID)
                  expect((await SessionInbox.materializeNextTask(sessionID)).status).toBe("materialized")
                  rootID = accepted.effect.messageID
                  await RolloutLedger.beginRun(RolloutLifecycle.owner(session), rootID)
                }
                const root = await SessionExecutionOwners.latestRoot(sessionID)
                if (!root || root.id !== rootID) throw new Error("Tool has another actual accepted native root")
                return body(await Session.get(sessionID), root)
              },
            })
          })
        }
        async function tool(
          name: "bash" | "process" | "read",
          callID: string,
          args: Record<string, unknown>,
          signal?: AbortSignal,
        ) {
          return inRun(async (session, root) => {
            const messageID = Identifier.ascending("message")
            const assistantMessage = MessageV2.Assistant.parse({
              id: messageID,
              sessionID,
              role: "assistant",
              rootID: root.id,
              parentID: root.id,
              agent: PrimaryAgentIdentity.names.general,
              mode: "default",
              modelID: root.model.modelID,
              providerID: root.model.providerID,
              path: { cwd: null, root: null },
              cost: 0,
              tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
              time: { created: Date.now() },
            })
            await Session.updateMessage(assistantMessage)
            const executionID = createHash("sha256")
              .update(JSON.stringify([session.scope.id, sessionID, messageID, callID]))
              .digest("hex")
            const model = await Provider.getModel(root.model.providerID, root.model.modelID)
            const agent = await Agent.get(PrimaryAgentIdentity.names.general)
            if (!agent) throw new Error("The original Runtime did not register its primary Agent")
            const toolSignal = signal
              ? AbortSignal.any([signal, AbortSignal.timeout(10000)])
              : AbortSignal.timeout(10000)
            const processor = SessionProcessor.create({
              assistantMessage,
              sessionID,
              model,
              abort: toolSignal,
            })
            let failed: { error: unknown } | undefined
            try {
              await SessionExecutionContributions.prepareModel(session, {
                messageID,
                rootMessageID: root.id,
                agent: agent.name,
                signal: toolSignal,
              })
              const preparedSession = await Session.get(sessionID)
              const selected = await ToolResolver.runtimeToolFor(
                {
                  agent,
                  model,
                  sessionID,
                  session: preparedSession,
                  processor,
                  userTools: { [name]: true },
                  includeMCP: false,
                },
                name,
              )
              if (!selected) throw new Error("The original Runtime did not expose its ordinary " + name + " tool")
              const result = await processor.executeToolCall({
                callID,
                toolName: name,
                args,
                tool: selected.tool,
                executor: selected.executor,
                workBrief: "Read and update the explicitly selected remote Workspace",
              })
              if (name === "bash")
                nativeOperations.set(executionID, () =>
                  runtime.run(async () =>
                    EnvironmentExecution.Info.parse(
                      (await EnvironmentExecution.get(executionID, session.scope.id)).sourceObservation,
                    ),
                  ),
                )
              return { result, executionID }
            } catch (error) {
              failed = { error }
              throw error
            } finally {
              try {
                processor.dispose("controlled ordinary tool completed")
              } catch (error) {
                if (failed)
                  throw new AggregateError([failed.error, error], "Ordinary tool and processor cleanup failed")
                throw error
              }
            }
          })
        }
        const filesResponse = (input: Cloud.LocalFileRequest) =>
          client.orgLocalWorkspaceFiles.request({ sessionID, orgCloudLocalFileRequest: input })
        return {
          get runtime() {
            return runtime
          },
          home,
          registration,
          client,
          sessionID,
          get accepted() {
            return accepted
          },
          async nextTask() {
            await runtime.run(async () => {
              if (!rootID) throw new Error("The original task has not been materialized")
              const session = await Session.get(sessionID)
              const run = await RolloutLedger.getRun(RolloutLifecycle.owner(session), rootID)
              if (!["completed", "cancelled", "failed"].includes(run.status))
                throw new Error("The original task must settle before accepting an independent task")
            })
            const next = (
              await service.client.orgCommands.input(
                {
                  sessionID,
                  orgCommandInputRequest: {
                    schemaVersion: 1,
                    orgID: service.identity.orgID,
                    sessionID,
                    projectID: project.projectID,
                    runtimeID: registration.runtimeID,
                    requestID: "input-" + sessionKey + "-" + crypto.randomUUID(),
                    input: {
                      operation: "input",
                      mode: "task",
                      parts: [{ type: "text", text: "Read the explicitly selected shared files in a new task" }],
                    },
                  },
                },
                { headers: input?.inputHeaders ?? service.headers, throwOnError: true },
              )
            ).data
            accepted = next
            rootID = undefined
            return next
          },
          finalizeTerminalTask: () => finalizeFixtureTask("terminal"),
          close: () => runtime.close(),
          async reopen() {
            if (runtime.status !== "closed")
              throw new Error("The original Runtime must actually close before reopening")
            runtime = await open()
            return runtime
          },
          async bash(command: string, signal?: AbortSignal) {
            return tool("bash", "selected-cloud-command", { command, yieldSeconds: 0.05 }, signal)
          },
          async process(input: Parameters<Awaited<ReturnType<typeof ProcessTool.init>>["execute"]>[0]) {
            return (await tool("process", "process-" + input.action + "-" + crypto.randomUUID(), input)).result
          },
          async read(filePath: string) {
            return (await tool("read", "read-" + crypto.randomUUID(), { filePath })).result
          },
          filesResponse,
          async files(input: Cloud.LocalFileRequest) {
            await inRun(async () => {})
            const response = await filesResponse(input)
            expect(response.response.status, JSON.stringify(response.error)).toBe(200)
            return Cloud.FileResult.parse(response.data)
          },
        }
      }
      return Object.assign(
        await newSession({
          ...(configuration?.nativeDirectory ? { workspace: null, environment: null } : {}),
          ...(configuration?.inputHeaders ? { inputHeaders: configuration.inputHeaders } : {}),
        }),
        {
          sibling: newSession,
          attach: (sessionID: string, accepted: Command.InputAccepted) =>
            newSession({ existing: { sessionID, accepted } }),
          attachQueued: (sessionID: string, accepted: Command.InputAccepted) =>
            newSession({ existing: { sessionID, accepted, queued: true } }),
        },
      )
    }
    async function member(deviceID: string, configuration?: { handoff?: true; nativeDirectory?: string }) {
      const current = await machine(deviceID, configuration)
      if (!("accountID" in current.home.identity)) throw new Error("The real Member has another installed identity")
      const identity = current.home.identity
      return { ...current, home: { ...current.home, identity } }
    }
    async function hosted(hostID: string, inputHeaders?: Record<string, string>) {
      const current = await machine(hostID, { hosted: true, handoff: true, inputHeaders })
      if (!("hostID" in current.home.identity))
        throw new Error("The real Hosted Runtime has another installed identity")
      const identity = current.home.identity
      return { ...current, home: { ...current.home, identity } }
    }
    return {
      service,
      project,
      workspace: seeded,
      environment,
      resourceIDs: [model.resourceID, storage.resourceID, compute.resourceID],
      model,
      storage,
      compute,
      directory,
      member,
      hosted,
      coordinator,
      allocations: controlled.allocations,
      nativeStarts: controlled.nativeStarts,
      nativeEffects: controlled.nativeEffects,
      holdSandboxOnce: controlled.holdSandboxOnce,
      holdCancelOnce: controlled.holdCancelOnce,
      preparation: controlled.preparation,
      async observation(id: string) {
        const original = nativeOperations.get(id)
        if (!original) throw new Error("Command has no original native controller receipt")
        return controlled.observation((await original()).id)
      },
      async waitForOutput(id: string, text: string) {
        const original = nativeOperations.get(id)
        if (!original) throw new Error("Command has no original native controller receipt")
        return controlled.waitForOutput((await original()).id, text)
      },
      async physical(id: string) {
        const original = nativeOperations.get(id)
        if (!original) throw new Error("Command has no original native controller receipt")
        const observed = await original()
        return service.service.maintenance.run(async () => {
          const info = Environment.Info.parse(await Storage.read(StoragePath.environment(environment.environmentID)))
          return {
            environment: info,
            uses: await Environment.uses(info.id),
            execution: await EnvironmentExecution.get(observed.id, info.scopeID),
            workspace: await WorkspaceCatalog.get(workspace.workspaceID, info.scopeID),
          }
        })
      },
      async head() {
        return (await service.client.orgCloudWorkspaces.get({ workspaceID: workspace.workspaceID }, options)).data
      },
      async [Symbol.asyncDispose]() {
        try {
          await resources.close()
        } catch (error) {
          throw new Error("Cloud execution cleanup failed: " + JSON.stringify(failureMetadata(error)), { cause: error })
        }
      },
    }
  } catch (error) {
    try {
      await resources.close()
    } catch (cleanup) {
      throw new AggregateError([error, cleanup], "Cloud execution setup and cleanup failed")
    }
    throw error
  }
}
