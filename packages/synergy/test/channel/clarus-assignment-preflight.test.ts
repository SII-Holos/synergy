import fs from "node:fs/promises"
import path from "node:path"
import { describe, expect, test } from "bun:test"
import { ChannelHost } from "../../src/channel/host"
import type { RuntimeTaskAssignedEvent } from "../../src/channel/provider/clarus/agent-tunnel-port"
import {
  ClarusAssignmentPreflightError,
  preflightClarusAssignment,
} from "../../src/channel/provider/clarus/assignment-preflight"
import { ClarusAssignmentRuntime } from "../../src/channel/provider/clarus/assignment-runtime"
import { ClarusAssignmentStore } from "../../src/channel/provider/clarus/assignment-store"
import type { ClarusCliRunner } from "../../src/channel/provider/clarus/cli-runner"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { tmpdir } from "../fixture/fixture"

function assignment(overrides: Partial<RuntimeTaskAssignedEvent> = {}): RuntimeTaskAssignedEvent {
  const nonce = crypto.randomUUID()
  return {
    kind: "known",
    type: "runtimeTaskAssigned",
    agentID: "agent-1",
    requestID: null,
    projectID: `project-${nonce}`,
    runID: `run-${nonce}`,
    taskID: `task-${nonce}`,
    phase: "DESIGN",
    subtaskID: `review-${nonce}`,
    attempt: 1,
    deadlineAt: null,
    goal: "Review upstream artifacts",
    epoch: 1,
    generation: 1,
    ...overrides,
  }
}

async function managedProject(event: RuntimeTaskAssignedEvent) {
  const host = ChannelHost.create({ channelType: "clarus", accountId: event.agentID })
  const record = await host.projects.ensure({ externalProjectId: event.projectID, name: "Project", isActive: true })
  const scope = await Scope.fromID(record.scopeID)
  if (!scope || scope.type !== "project") throw new Error("Managed project scope not found")
  return { host, scope }
}

function fakeRunner(input: {
  context?: unknown
  run?: unknown
  phaseStates?: unknown
  previews?: Record<string, unknown>
  downloads?: Record<string, string>
}) {
  const calls: string[][] = []
  const runner: ClarusCliRunner = {
    async json(args) {
      calls.push(args)
      if (args[0] === "runtime" && args[1] === "context") return input.context ?? {}
      if (args[0] === "runtime" && args[1] === "info") return input.run ?? {}
      if (args[0] === "runtime" && args[1] === "phase-states") return input.phaseStates ?? {}
      if (args[0] === "file" && args[1] === "preview") return input.previews?.[args[3]!] ?? {}
      throw new Error(`Unexpected command: ${args.join(" ")}`)
    },
    async download(args, output) {
      calls.push(args)
      const content = input.downloads?.[args[3]!]
      if (content === undefined) throw new Error("download unavailable")
      await fs.writeFile(output, content)
    },
  }
  return { runner, calls }
}

describe("Clarus assignment preflight", () => {
  test("materializes name-only input refs from runtime artifact bodies", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const event = assignment({ taskInput: { input_refs: ["grounding-capsule"] } })
        const { scope } = await managedProject(event)
        const fake = fakeRunner({
          context: {
            artifacts: [
              {
                artifact_id: "grounding-capsule",
                parts: [{ type: "text", format: "markdown", content: "# Grounded evidence" }],
              },
            ],
          },
        })

        const result = await preflightClarusAssignment({ event, scope, runner: fake.runner })
        expect(result.inputs).toHaveLength(1)
        expect(result.inputs[0]!.relativePath.startsWith(".clarus/inputs/")).toBe(true)
        expect(result.inputs[0]!.relativePath).not.toContain("..")
        expect(await fs.readFile(path.join(scope.directory, result.inputs[0]!.relativePath), "utf8")).toBe(
          "# Grounded evidence",
        )
        expect(result.promptSection).not.toContain(scope.directory)
      },
    })
  })

  test("previews files and falls back to download when preview has no text", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const event = assignment({ input: { input_refs: ["story", "evidence"] } })
        const { scope } = await managedProject(event)
        const fake = fakeRunner({
          context: {
            files: [
              { file_id: "file-story", name: "story.md" },
              { file_id: "file-evidence", name: "evidence.pdf" },
            ],
          },
          previews: { "file-story": { content: "Story body" } },
          downloads: { "file-evidence": "binary evidence" },
        })

        const result = await preflightClarusAssignment({ event, scope, runner: fake.runner })
        expect(result.inputs.map((item) => item.ref)).toEqual(["story", "evidence"])
        expect(fake.calls).toContainEqual(["file", "preview", event.projectID, "file-story"])
        expect(fake.calls).toContainEqual(["file", "download", event.projectID, "file-evidence"])
      },
    })
  })

  test("reuses a complete run cache without another CLI call", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const event = assignment({ context: { input_refs: ["story"] } })
        const { scope } = await managedProject(event)
        const fake = fakeRunner({ context: { artifacts: [{ name: "story", content: "cached story" }] } })
        await preflightClarusAssignment({ event, scope, runner: fake.runner })
        const callCount = fake.calls.length
        await preflightClarusAssignment({ event, scope, runner: fake.runner })
        expect(fake.calls).toHaveLength(callCount)
      },
    })
  })

  test("rejects cached inputs that escape the managed Project scope", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const event = assignment({ context: { input_refs: ["story"] } })
        const { scope } = await managedProject(event)
        const outside = path.join(path.dirname(scope.directory), `outside-${crypto.randomUUID()}.md`)
        await fs.writeFile(outside, "outside secret")
        const runHash = new Bun.CryptoHasher("sha256").update(event.runID).digest("hex").slice(0, 24)
        const runDirectory = path.join(scope.directory, ".clarus", "inputs", runHash)
        await fs.mkdir(runDirectory, { recursive: true })
        await fs.writeFile(
          path.join(runDirectory, "manifest.json"),
          JSON.stringify({
            runID: event.runID,
            inputs: [{ ref: "story", relativePath: path.relative(scope.directory, outside) }],
          }),
        )
        const fake = fakeRunner({ context: { artifacts: [{ name: "story", content: "fresh story" }] } })
        try {
          const result = await preflightClarusAssignment({ event, scope, runner: fake.runner })
          expect(fake.calls.length).toBeGreaterThan(0)
          expect(await fs.readFile(path.join(scope.directory, result.inputs[0]!.relativePath), "utf8")).toBe(
            "fresh story",
          )
          expect(result.inputs[0]!.relativePath).not.toContain("..")
        } finally {
          await fs.rm(outside, { force: true })
        }
      },
    })
  })

  test("fails before Session creation and assignment persistence when refs are unresolved", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const event = assignment({ taskInput: { input_refs: ["missing-upstream"] } })
        const { host } = await managedProject(event)
        const fake = fakeRunner({})

        await expect(
          ClarusAssignmentRuntime.dispatch({ host, accountId: event.agentID, event, cliRunner: fake.runner }),
        ).rejects.toBeInstanceOf(ClarusAssignmentPreflightError)
        expect(
          await ClarusAssignmentStore.findByIdentity({
            accountId: event.agentID,
            projectID: event.projectID,
            taskID: event.taskID,
          }),
        ).toBeUndefined()
      },
    })
  })

  test("fails closed when refs exist but no CLI runner is available", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const event = assignment({ input: { input_refs: ["required"] } })
        const { host } = await managedProject(event)
        await expect(
          ClarusAssignmentRuntime.dispatch({ host, accountId: event.agentID, event }),
        ).rejects.toBeInstanceOf(ClarusAssignmentPreflightError)
      },
    })
  })

  test("does not invoke Holos CLI for assignments without input refs", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const event = assignment({ input: { parameters: ["safe"] } })
        const { host } = await managedProject(event)
        const fake = fakeRunner({})
        const result = await ClarusAssignmentRuntime.dispatch({
          host,
          accountId: event.agentID,
          event,
          cliRunner: fake.runner,
        })
        expect(result.created).toBe(true)
        expect(fake.calls).toEqual([])
      },
    })
  })
})
