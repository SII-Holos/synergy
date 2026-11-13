import { expect, test } from "bun:test"
import { cloudExecutionFixture } from "./support/cloud-execution"

function failureMetadata(error: unknown, seen = new Set<object>(), depth = 0): unknown {
  if (typeof error !== "object" || error === null) return { message: String(error) }
  const fields = Object.getOwnPropertyDescriptors(error)
  const value = (name: string): unknown => fields[name]?.value
  const data = value("data")
  const details: Record<string, PropertyDescriptor> =
    typeof data === "object" && data !== null ? Object.getOwnPropertyDescriptors(data) : {}
  const text = (value: unknown) => (typeof value === "string" ? value : undefined)
  const summary = {
    name: error instanceof Error ? error.name : text(value("name")),
    message: error instanceof Error ? error.message : text(value("message")),
    detailMessage: text(details.message?.value),
    code: text(value("code")) ?? text(details.code?.value),
    outcome: text(value("outcome")) ?? text(details.outcome?.value),
  }
  if (seen.has(error) || depth >= 16) return { ...summary, truncated: true }
  seen.add(error)
  const errors = value("errors")
  return {
    ...summary,
    ...Object.fromEntries(
      ["error", "cause", "suppressed"]
        .filter((key) => value(key) !== undefined)
        .map((key) => [key, failureMetadata(value(key), seen, depth + 1)]),
    ),
    ...(Array.isArray(errors) && {
      errors: errors.slice(0, 16).map((error) => failureMetadata(error, seen, depth + 1)),
    }),
  }
}

async function withFailureMetadata(body: () => Promise<void>) {
  try {
    await body()
  } catch (error) {
    console.error("Selected Environment tool failure", JSON.stringify(failureMetadata(error), null, 2))
    throw error
  }
}

async function withCloudExecution(body: (fixture: Awaited<ReturnType<typeof cloudExecutionFixture>>) => Promise<void>) {
  const fixture = await cloudExecutionFixture()
  const failures: unknown[] = []
  try {
    await body(fixture)
  } catch (error) {
    failures.push(error)
  }
  try {
    await fixture[Symbol.asyncDispose]()
  } catch (error) {
    failures.push(error)
  }
  if (failures.length === 1) throw failures[0]
  if (failures.length) throw new AggregateError(failures, "Selected Environment tool and fixture cleanup failed")
}

test.skipIf(process.platform === "win32")(
  "ordinary accepted tools execute in the selected service Environment and share live Workspace bytes",
  () =>
    withFailureMetadata(() =>
      withCloudExecution(async (f) => {
        const alice = await f.member("execution-a")
        expect(f.allocations()).toBe(0)
        expect(await f.head()).toEqual(f.workspace)
        const program = [
          "const bytes = new Uint8Array(await Bun.file('seed.bin').arrayBuffer());",
          "if (bytes.join(',') !== '0,255,37,128,10') throw new Error('Wrong selected Workspace');",
          "await Bun.write('live.bin', new Uint8Array([0,255,37,128,10,42]));",
          "process.stdout.write('CLOUD_READY\\n');",
          "const input = await new Promise(resolve => process.stdin.once('data', resolve));",
          "if (Buffer.from(input).toString() !== 'finish\\n') throw new Error('Unexpected original process input');",
          "process.stdin.destroy();",
          "await Bun.write('finished.txt', 'saved after native drainage\\n');",
          "process.stdout.write('CLOUD_SAVED\\n');",
        ].join("\n")
        const command = [process.execPath, "-e", program]
          .map((value) => "'" + value.replaceAll("'", "'\\''") + "'")
          .join(" ")
        const started = await alice.bash(command)
        expect(started.result.metadata.background).toBe(true)
        const processId = started.result.metadata.processId
        if (!processId) throw new Error("Ordinary Bash did not retain its real background process")
        await f.waitForOutput(started.executionID, "CLOUD_READY")
        const running = await f.physical(started.executionID)
        expect(running.execution).toMatchObject({ state: "running" })
        expect(running.uses.some((use) => use.kind === "operation" && use.ownership.kind === "execution")).toBe(true)
        expect(running.workspace.activeMount?.state).toBe("active")
        expect(
          (await f.coordinator.inspect()).some((claim) => claim.kind === "process" && claim.state === "active"),
        ).toBe(true)
        const bob = await f.member("execution-b")
        const described = await bob.files({ operation: { action: "describe" } })
        const visible = await bob.files({
          reference: described.reference,
          operation: { action: "read", path: "live.bin", offset: 0, maximumBytes: 64 },
        })
        expect(visible.result).toMatchObject({
          action: "read",
          data: Buffer.from([0, 255, 37, 128, 10, 42]).toString("base64"),
        })
        expect((await f.head()).contentRevision).toBe(f.workspace.contentRevision)
        await alice.process({ action: "write", processId, data: "finish\n" })
        const completed = await alice.process({ action: "poll", processId, block: true, timeoutSeconds: 5 })
        const physical = await f.observation(started.executionID)
        expect(physical?.stdin?.finishInput).toBe(true)
        expect(completed.metadata, JSON.stringify(physical)).toMatchObject({ status: "completed", exitCode: 0 })
        const saved = await f.physical(started.executionID)
        expect(saved.execution).toMatchObject({ state: "completed", status: { exitCode: 0 } })
        expect(saved.uses.some((use) => use.kind === "operation" && use.ownership.kind === "execution")).toBe(false)
        expect((await f.head()).contentRevision).toBeGreaterThan(f.workspace.contentRevision)
        const finalView = await bob.files({ operation: { action: "describe" } })
        expect(
          (
            await bob.files({
              reference: finalView.reference,
              operation: { action: "read", path: "finished.txt", offset: 0, maximumBytes: 128 },
            })
          ).result,
        ).toMatchObject({ action: "read", data: Buffer.from("saved after native drainage\n").toString("base64") })
        expect(f.allocations()).toBe(1)
      }),
    ),
  30000,
)
