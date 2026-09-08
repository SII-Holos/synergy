import { expect, spyOn, test } from "bun:test"
import { RolloutTool } from "@ericsanchezok/synergy-harness/session/rollout/tool"
import { RolloutArtifact } from "@ericsanchezok/synergy-harness/session/rollout/artifact"
import { RolloutLedger } from "@ericsanchezok/synergy-harness/session/rollout/ledger"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"

function input() {
  const id = crypto.randomUUID()
  return {
    owner: { kind: "operation" as const, scopeID: "test", operationID: id },
    runID: id,
    messageID: "message",
    toolCallID: "provider-tool-call",
    tool: "read",
    args: {},
  }
}

async function read(owner: Parameters<typeof RolloutArtifact.read>[0], id: string) {
  const chunks: Uint8Array[] = []
  for await (const chunk of RolloutArtifact.read(owner, id)) chunks.push(chunk)
  return JSON.parse(Buffer.concat(chunks).toString())
}

test("tool evidence separates original result from the model observation", async () => {
  const args = input()
  const output = "x".repeat(100_000)
  const result = await RolloutTool.execute(args, async () => {
    expect((await RolloutLedger.tools(args.owner, args.runID))[0].status).toBe("running")
    await RolloutTool.authorize({ profile: "autonomous", decision: "allow" })
    await RolloutTool.capture({ output, metadata: { source: "original" } })
    return { output: "truncated", metadata: { truncated: true } }
  })
  expect(result.output).toBe("truncated")
  const [tool] = await RolloutLedger.tools(args.owner, args.runID)
  expect(tool.status).toBe("completed")
  expect(await read(args.owner, tool.authorization!.id)).toEqual({ profile: "autonomous", decision: "allow" })
  expect((await read(args.owner, tool.rawResult!.id)).output).toBe(output)
  expect((await read(args.owner, tool.observation!.id)).output).toBe("truncated")
})

test("failed tool intent prevents the side effect", async () => {
  const args = input()
  let executed = false
  using write = spyOn(Storage, "writeBinary").mockRejectedValue(new Error("disk full"))
  await expect(
    RolloutTool.execute(args, async () => {
      executed = true
      return {}
    }),
  ).rejects.toMatchObject({ name: "RolloutRecordingError" })
  expect(executed).toBe(false)
  expect((await RolloutLedger.getRun(args.owner, args.runID)).recording).toBe("failed")
})

test("bash records stdout and stderr before its bounded display buffer", async () => {
  const { tmpdir } = await import("@ericsanchezok/synergy-harness/test/support/fixture")
  const { ScopeContext } = await import("@ericsanchezok/synergy-harness/scope/context")
  const { LocalBashBackend } = await import("@ericsanchezok/synergy-runtime-local/tools/bash/local")
  await using tmp = await tmpdir({ git: true })
  await ScopeContext.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const args = input()
      const script = 'process.stdout.write("x".repeat(260000)); process.stderr.write("e".repeat(180000))'
      const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'"
      const result = await RolloutTool.execute({ ...args, tool: "bash" }, () =>
        LocalBashBackend.execute(
          {
            command: `${quote(process.execPath)} -e ${quote(script)}`,
            description: "Output capture fixture",
            backgroundAfterSeconds: 0,
          },
          {
            sessionID: "fixture",
            messageID: "fixture",
            agent: "test",
            abort: new AbortController().signal,
            metadata() {},
            async ask() {},
            openProcessEvidence: RolloutTool.openProcess,
          },
        ),
      )
      expect(result.output.length).toBeLessThan(440000)
      const [recordedProcess] = await RolloutLedger.processes(args.owner, args.runID)
      expect(recordedProcess.status).toBe("completed")
      const chunks: Uint8Array[] = []
      for await (const chunk of RolloutArtifact.read(args.owner, recordedProcess.stream.id)) chunks.push(chunk)
      const bytes = Buffer.concat(chunks)
      const output = { stdout: "", stderr: "" }
      let offset = 0
      while (offset < bytes.length) {
        const channel = bytes[offset] === 1 ? "stdout" : "stderr"
        const length = bytes.readUInt32BE(offset + 1)
        output[channel] += bytes.subarray(offset + 5, offset + 5 + length).toString()
        offset += 5 + length
      }
      expect(output.stdout).toBe("x".repeat(260000))
      expect(output.stderr).toBe("e".repeat(180000))
    },
  })
})

test("tool completion is published only after its observation commits", async () => {
  const args = input()
  let published = false
  await RolloutTool.execute(args, async () => {
    RolloutTool.afterCommit(() => {
      published = true
    })
    expect(published).toBe(false)
    expect((await RolloutLedger.tools(args.owner, args.runID))[0].observation).toBeUndefined()
    return { output: "done" }
  })
  expect(published).toBe(true)
  expect((await RolloutLedger.tools(args.owner, args.runID))[0].observation?.status).toBe("complete")
})

test("run cancellation terminates and commits only its owned background processes", async () => {
  const { RolloutProcess } = await import("@ericsanchezok/synergy-harness/session/rollout/process")
  const { ProcessRegistry } = await import("@ericsanchezok/synergy-harness/process/registry")
  const args = input()
  const first = ProcessRegistry.create({ command: "first" })
  const other = ProcessRegistry.create({ command: "other" })
  const fail = async (error: unknown): Promise<never> => {
    throw error
  }
  const one = await RolloutProcess.open(
    { owner: args.owner, runID: args.runID, toolExecutionID: crypto.randomUUID(), processID: first.id },
    fail,
  )
  const two = await RolloutProcess.open(
    { owner: args.owner, runID: "another", toolExecutionID: crypto.randomUUID(), processID: other.id },
    fail,
  )
  let stoppedOther = false
  ProcessRegistry.setTerminator(first, () => one.finish({ interrupted: true, exitCode: null, signal: "SIGTERM" }))
  ProcessRegistry.setTerminator(other, async () => {
    stoppedOther = true
  })
  try {
    await one.append("stdout", new TextEncoder().encode("before cancellation"))
    await RolloutProcess.cancel(args.owner, args.runID)
    expect(stoppedOther).toBe(false)
    expect((await RolloutLedger.processes(args.owner, args.runID))[0].status).toBe("interrupted")
  } finally {
    await two.finish({ interrupted: false, exitCode: 0, signal: null })
    ProcessRegistry.remove(first.id)
    ProcessRegistry.remove(other.id)
  }
})
