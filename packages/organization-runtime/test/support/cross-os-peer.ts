import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import { createHash, randomBytes } from "node:crypto"
import { spyOn } from "bun:test"
import { z } from "zod"
import { createSynergyClient } from "@ericsanchezok/synergy-sdk"
import { OrganizationCommandProtocol as Command } from "@ericsanchezok/synergy-organization-protocol"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { SessionInbox } from "@ericsanchezok/synergy-harness/session/inbox"
import { SessionHistory } from "@ericsanchezok/synergy-harness/session/history"
import { SessionManager } from "@ericsanchezok/synergy-harness/session/manager"
import { SessionExecutionSource } from "@ericsanchezok/synergy-harness/session/execution-source"
import { SessionExecutionOwners } from "@ericsanchezok/synergy-harness/session/execution-owners"
import { SessionExecutionContributions } from "@ericsanchezok/synergy-harness/session/execution-contributions"
import { SessionTransferEpochs, SessionTransferEnvironments } from "@ericsanchezok/synergy-harness/session/transfer"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { RolloutLedger } from "@ericsanchezok/synergy-harness/session/rollout/ledger"
import { RolloutLifecycle } from "@ericsanchezok/synergy-harness/session/rollout/lifecycle"
import { MessageV2 } from "@ericsanchezok/synergy-harness/session/message-v2"
import { Snapshot } from "@ericsanchezok/synergy-harness/session/snapshot"
import { SnapshotStore } from "@ericsanchezok/synergy-harness/session/snapshot-store"
import { SessionProcessor, ToolResolver } from "@ericsanchezok/synergy-harness/test/support/internals"
import { EnvironmentExecution } from "@ericsanchezok/synergy-harness/environment/execution"
import { Agent } from "@ericsanchezok/synergy-harness/agent/agent"
import { PrimaryAgentIdentity } from "@ericsanchezok/synergy-harness/agent/primary-identity"
import { Provider } from "@ericsanchezok/synergy-harness/provider/provider"
import { Identifier } from "@ericsanchezok/synergy-harness/id/id"
import { WorkspaceCoordinator } from "@ericsanchezok/synergy-local-runtime/workspace/coordinator"
import { MemberIdentity, prepareMemberHome } from "../../src/home"
import { enrollMemberRuntime } from "../../src/enrollment"
import { openMemberRuntime } from "../../src/runtime"
import { readCommandControlVersion } from "../../src/command-intake"

const ID = z.string().min(1).max(256)
export const Action = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("bind"), projectID: ID }),
  z.strictObject({
    kind: z.literal("attach"),
    sessionID: ID,
    accepted: Command.InputAccepted,
    initial: z.boolean(),
  }),
  z.strictObject({
    kind: z.literal("execute"),
    phase: z.enum(["darwin-first", "linux-second", "darwin-return"]),
  }),
  z.strictObject({ kind: z.literal("observe") }),
  z.strictObject({
    kind: z.literal("historical"),
    snapshots: z.array(z.string().regex(/^[a-f0-9]{40,64}$/)).max(4),
  }),
  z.strictObject({ kind: z.literal("settle") }),
  z.strictObject({ kind: z.literal("close") }),
])
export type Action = z.infer<typeof Action>
export const Task = z.strictObject({ id: z.string().uuid(), action: Action })
export const Outcome = z.discriminatedUnion("ok", [
  z.strictObject({
    id: z.string().uuid(),
    ok: z.literal(true),
    value: z.json(),
  }),
  z.strictObject({
    id: z.string().uuid(),
    ok: z.literal(false),
    name: z.string().max(128),
    message: z.string().max(512),
  }),
])
export const InitialBytes = new Uint8Array([0, 255, 37, 128, 10, 231, 42])
export const LinuxBytes = new Uint8Array([255, 0, 128, 4, 19, 231, 10])
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex")
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'"
const Json = z.json()
export const json = (value: unknown) => Json.parse(JSON.parse(JSON.stringify(value)))

export async function createPeer(input: {
  root: string
  origin: string
  identity: MemberIdentity
  ticket(publicKey: string): Promise<Parameters<typeof enrollMemberRuntime>[0]["ticket"]>
}) {
  const directory = path.join(input.root, "original-native")
  await fs.mkdir(directory, { recursive: true })
  await Bun.write(path.join(directory, "current.txt"), "before the original native task\n")
  await Bun.write(path.join(directory, "historical.txt"), "the original historical object")
  await Bun.write(path.join(directory, "目录-中文.txt"), "跨平台真实目录\n")
  await Bun.write(path.join(directory, ".gitignore"), "ignored.bin\n")
  await Bun.write(path.join(directory, "ignored.bin"), InitialBytes)
  await Bun.write(path.join(directory, "untracked.bin"), InitialBytes)
  await Bun.write(path.join(directory, "script.sh"), "#!/bin/sh\nprintf 'portable mode\\n'\n")
  await fs.chmod(path.join(directory, "script.sh"), 0o755)
  await fs.symlink("current.txt", path.join(directory, "relative-link"))
  const home = await prepareMemberHome({
    baseDirectory: path.join(input.root, "members"),
    identity: input.identity,
    origin: input.origin,
  })
  const registration = await enrollMemberRuntime({
    home: home.home,
    identity: home.identity,
    ticket: await input.ticket(home.publicKey),
  })
  const probe = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(),
  })
  const port = probe.port!
  await probe.stop(true)
  const token = randomBytes(32).toString("hex")
  const wake = spyOn(SessionManager, "scheduleWake").mockImplementation(() => {})
  let runtime: Awaited<ReturnType<typeof openMemberRuntime>>
  try {
    runtime = await openMemberRuntime({
      home: home.home,
      identity: home.identity,
      handoff: true,
      listen: { port, token },
      workspaceCoordinator: new WorkspaceCoordinator({
        directory: path.join(input.root, "claims"),
      }),
    })
  } catch (error) {
    wake.mockRestore()
    throw error
  }
  const client = createSynergyClient({
    baseUrl: `http://127.0.0.1:${port}`,
    headers: { authorization: "Bearer " + token },
  })
  let sessionID: string | undefined
  let accepted: Command.InputAccepted | undefined
  let initial = false
  let rootID: string | undefined
  let closed = false
  const snapshots: string[] = []
  async function inSession<T>(body: (session: Session.Info) => Promise<T>) {
    if (!sessionID) throw new Error("The peer has not attached its actual Session")
    const selectedID = sessionID
    return runtime.run(async () => {
      const session = await Session.get(selectedID)
      return ScopeContext.provide({
        scope: session.scope,
        workspace: session.workspace,
        fn: () => body(session),
      })
    })
  }
  async function inRun<T>(
    body: (
      session: Session.Info,
      root: NonNullable<Awaited<ReturnType<typeof SessionExecutionOwners.latestRoot>>>,
    ) => Promise<T>,
  ) {
    return inSession(async (session) => {
      if (!accepted) throw new Error("The peer has no original accepted task")
      await SessionExecutionSource.authorize({
        sessionID: session.id,
        scopeID: session.scope.id,
      })
      if (!rootID && initial) {
        await Session.updateControlProfile(session.id, "autonomous")
        assert.equal((await SessionInbox.peekTask(session.id))?.messageID, accepted.effect.messageID)
        assert.equal((await SessionInbox.materializeNextTask(session.id)).status, "materialized")
        rootID = accepted.effect.messageID
        await RolloutLedger.beginRun(RolloutLifecycle.owner(session), rootID)
      }
      rootID ??= accepted.effect.messageID
      const root = await SessionExecutionOwners.latestRoot(session.id)
      assert.ok(root, "The native accepted task must have its actual canonical root")
      assert.equal(root.id, rootID)
      return body(await Session.get(session.id), root)
    })
  }
  async function execute(phase: Extract<Action, { kind: "execute" }>["phase"]) {
    assert.equal(process.platform, phase === "linux-second" ? "linux" : "darwin")
    return inRun(async (session, root) => {
      const agent = await Agent.get(PrimaryAgentIdentity.names.general)
      assert.ok(agent, "The actual Runtime must register its primary Agent")
      const messageID = Identifier.ascending("message")
      const assistant = MessageV2.Assistant.parse({
        id: messageID,
        sessionID: session.id,
        role: "assistant",
        rootID: root.id,
        parentID: root.id,
        agent: agent.name,
        mode: "default",
        modelID: root.model.modelID,
        providerID: root.model.providerID,
        path: { cwd: null, root: null },
        cost: 0,
        tokens: {
          input: 0,
          output: 0,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
        time: { created: Date.now() },
      })
      await Session.updateMessage(assistant)
      const snapshot = await Snapshot.track(session.id)
      assert.ok(snapshot, "The actual Snapshot owner must retain the pre-tool tree")
      snapshots.push(snapshot)
      await Session.updatePart({
        id: Identifier.ascending("part"),
        sessionID: session.id,
        messageID,
        type: "step-start",
        snapshot,
        workspace: Snapshot.workspace(),
      })
      const model = await Provider.getModel(root.model.providerID, root.model.modelID)
      const signal = AbortSignal.timeout(10000)
      const processor = SessionProcessor.create({
        assistantMessage: assistant,
        sessionID: session.id,
        model,
        abort: signal,
      })
      try {
        await SessionExecutionContributions.prepareModel(session, {
          messageID,
          rootMessageID: root.id,
          agent: agent.name,
          signal,
        })
        const selected = await ToolResolver.runtimeToolFor(
          {
            agent,
            model,
            sessionID: session.id,
            session: await Session.get(session.id),
            processor,
            userTools: { bash: true },
            includeMCP: false,
          },
          "bash",
        )
        assert.ok(selected, "The original Runtime must expose ordinary Bash for its selected native Environment")
        const program =
          phase === "darwin-first"
            ? "await Bun.write('current.txt', 'dirty Darwin bytes\\n'); await import('node:fs/promises').then(fs => fs.unlink('historical.txt'));"
            : phase === "linux-second"
              ? "await Bun.write('current.txt', 'dirty Linux bytes\\n'); await Bun.write('untracked.bin', new Uint8Array([255,0,128,4,19,231,10])); await Bun.write('linux-only.txt', 'returned from Linux\\n');"
              : "if (await Bun.file('current.txt').text() !== 'dirty Linux bytes\\n') throw new Error('The returned directory lost current Linux bytes');"
        const command = [
          process.execPath,
          "-e",
          program + "process.stdout.write('ACTUAL_NATIVE_' + process.platform + '\\n');",
        ]
          .map(quote)
          .join(" ")
        const callID = "cross-os-" + phase
        const executionID = createHash("sha256")
          .update(JSON.stringify([session.scope.id, session.id, messageID, callID]))
          .digest("hex")
        const result = await processor.executeToolCall({
          callID,
          toolName: "bash",
          args: { command },
          tool: selected.tool,
          executor: selected.executor,
          workBrief: "Verify the received native directory on this actual operating system",
        })
        assert.notEqual(
          result.metadata.background,
          true,
          "The finite native command must naturally finish before transfer",
        )
        assert.ok(result.output.includes("ACTUAL_NATIVE_" + process.platform))
        const execution = await EnvironmentExecution.get(executionID, session.scope.id)
        assert.equal(execution.state, "completed")
        assert.equal(execution.id, executionID)
        return json({
          platform: process.platform,
          architecture: process.arch,
          executionID,
          state: execution.state,
          target: execution.target,
          snapshot,
          outputHash: digest(result.output),
        })
      } finally {
        processor.dispose("cross-OS ordinary native tool completed")
      }
    })
  }
  async function observe() {
    return inSession(async (session) => {
      const messages = await Session.messages({ sessionID: session.id })
      const page = await Session.messagePage({
        sessionID: session.id,
        limit: 100,
      })
      const timeline = await SessionHistory.timelinePage({
        sessionID: session.id,
        limit: 100,
      })
      assert.deepEqual(
        page.items.map((item) => item.info.id),
        messages.map((item) => item.info.id),
      )
      assert.deepEqual(
        timeline.items.map((item) => item.info.id),
        messages.map((item) => item.info.id),
      )
      assert.equal(page.total, messages.length)
      assert.equal(timeline.total, messages.length)
      const workspace = session.workspace
      assert.ok(workspace, "The target must retain an actual native Workspace projection")
      const bytes = async (name: string) =>
        createHash("sha256")
          .update(await Bun.file(path.join(workspace.path, name)).bytes())
          .digest("hex")
      const environmentID = session.environmentID
      assert.ok(environmentID, "The peer must retain an explicitly selected native Environment")
      const native = await SessionTransferEnvironments.nativeSelection({
        scopeID: session.scope.id,
        environmentID,
      })
      assert.ok(native, "The peer must retain its actual native Environment metadata")
      assert.equal(native.descriptor.platform, process.platform)
      const uname = Bun.spawn(["uname", "-s"], {
        stdout: "pipe",
        stderr: "pipe",
      })
      const os = (await new Response(uname.stdout).text()).trim()
      assert.equal(await uname.exited, 0)
      return json({
        platform: process.platform,
        architecture: process.arch,
        uname: os,
        native,
        sessionID: session.id,
        organization: session.organization,
        paused: session.paused ?? null,
        controlVersion: await readCommandControlVersion(input.identity.orgID, session.id),
        workspaceID: session.workspaceID,
        directoryIsOriginal: workspace.path === directory,
        files: {
          current: await Bun.file(path.join(workspace.path, "current.txt")).text(),
          binary: await bytes("untracked.bin"),
          ignored: await bytes("ignored.bin"),
          unicode: await Bun.file(path.join(workspace.path, "目录-中文.txt")).text(),
          mode: (await fs.stat(path.join(workspace.path, "script.sh"))).mode & 0o777,
          link: await fs.readlink(path.join(workspace.path, "relative-link")),
          historicalPresent: await Bun.file(path.join(workspace.path, "historical.txt")).exists(),
        },
        original: {
          current: await Bun.file(path.join(directory, "current.txt")).text(),
          binary: await bytesFromOriginal("untracked.bin"),
        },
        messages: messages.map(({ info, parts }) => ({
          info: {
            id: info.id,
            sessionID: info.sessionID,
            role: info.role,
            ...(info.role === "user" ? { actor: info.actor } : {}),
          },
          parts,
        })),
      })
    })
  }
  async function bytesFromOriginal(name: string) {
    return createHash("sha256")
      .update(await Bun.file(path.join(directory, name)).bytes())
      .digest("hex")
  }
  async function dispatch(action: Action) {
    switch (action.kind) {
      case "bind": {
        const current = (await client.orgLocalProject.get({ projectID: action.projectID }, { throwOnError: true })).data
        const bound = (
          await client.orgLocalProject.bind(
            {
              projectID: action.projectID,
              orgLocalProjectBind: {
                requestID: "cross-os-original-native",
                expectedRevision: current.revision,
                directory,
              },
            },
            { throwOnError: true },
          )
        ).data
        return json(bound)
      }
      case "attach":
        sessionID = action.sessionID
        accepted = action.accepted
        initial = action.initial
        rootID = undefined
        return null
      case "execute":
        return execute(action.phase)
      case "observe":
        return observe()
      case "historical":
        return inSession(async (session) => {
          const results = []
          for (const snapshot of action.snapshots) {
            assert.equal(await SnapshotStore.owns(session.scope.id, session.id, snapshot), true)
            const current = await SnapshotStore.command(SnapshotStore.repository(session.scope.id), [
              "show",
              `${snapshot}:current.txt`,
            ])
            results.push({ snapshot, current })
          }
          const first = action.snapshots[0]
          if (first)
            assert.equal(
              await SnapshotStore.command(SnapshotStore.repository(session.scope.id), [
                "show",
                `${first}:historical.txt`,
              ]),
              "the original historical object",
            )
          return json(results)
        })
      case "settle":
        return inSession(async (session) => {
          if (!accepted) throw new Error("No accepted root to settle")
          assert.equal(await SessionTransferEpochs.isFrozen(session.id), false)
          const root = RolloutLifecycle.owner(session)
          const record = await RolloutLedger.getRun(root, accepted.effect.messageID)
          if (record.status === "running") await RolloutLedger.finishRun(root, accepted.effect.messageID, "completed")
          assert.equal((await RolloutLedger.getRun(root, accepted.effect.messageID)).status, "completed")
          return null
        })
      case "close":
        await close()
        return null
    }
  }
  async function close() {
    if (closed) return
    await runtime.close()
    wake.mockRestore()
    closed = true
  }
  return { registration, dispatch, close }
}
