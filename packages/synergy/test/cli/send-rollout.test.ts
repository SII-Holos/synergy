import { expect, test } from "bun:test"
import { tmpdir } from "../fixture/fixture"
import { RolloutAccounting } from "../../src/session/rollout/accounting"

async function run(
  interaction?: "permission" | "question",
  command = false,
  delayedCommand = false,
  inputFailure?: string,
) {
  await using tmp = await tmpdir()
  let polls = 0
  let cancelled = false
  let rejected = false
  let commandStarted = !delayedCommand
  let experiment: unknown
  const sessionID = "ses_test"
  let runID = "msg_test"
  const state = () => ({
    version: 1,
    id: runID,
    owner: { kind: "session", scopeID: "test", sessionID },
    started: 1,
    ended: polls >= 3 || cancelled ? 5 : undefined,
    status: cancelled ? "cancelled" : polls >= 3 ? "completed" : "running",
    recording: "complete",
  })
  using server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      if (url.pathname === "/event")
        return new Response(
          new ReadableStream({
            start(controller) {
              const event =
                interaction === "permission"
                  ? {
                      type: "permission.asked",
                      properties: { id: "per_test", sessionID, permission: "bash", patterns: ["echo"], metadata: {} },
                    }
                  : interaction === "question"
                    ? {
                        type: "question.asked",
                        properties: {
                          id: "que_test",
                          sessionID,
                          questions: [{ header: "Choice", question: "Choose", options: [] }],
                        },
                      }
                    : { type: "session.idle", properties: { sessionID } }
              controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`))
              request.signal.addEventListener(
                "abort",
                () => {
                  try {
                    controller.close()
                  } catch {}
                },
                { once: true },
              )
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        )
      if (url.pathname.endsWith("/command")) {
        runID = (await request.json()).messageID
        if (delayedCommand) await Bun.sleep(200)
        commandStarted = true
        const deadline = Date.now() + 5000
        while (!cancelled && Date.now() < deadline) await Bun.sleep(10)
        return Response.json({})
      }
      if (url.pathname.endsWith("/input")) {
        if (inputFailure)
          return Response.json({ name: inputFailure, data: { message: "input failed" } }, { status: 500 })
        experiment = (await request.json()).experiment
        return Response.json({ status: "queued", item: { messageID: runID } })
      }
      if (url.pathname.endsWith("/cancel")) {
        if (!commandStarted) return Response.json({ name: "NotFoundError" }, { status: 404 })
        cancelled = true
        return Response.json(state())
      }
      if (
        url.pathname.includes("/permissions/") ||
        url.pathname.includes("/permission/") ||
        url.pathname.endsWith("/reject")
      ) {
        rejected = true
        return Response.json(true)
      }
      if (url.pathname.endsWith(`/run/${runID}`)) {
        polls++
        return Response.json(state())
      }
      if (url.pathname.endsWith("/result"))
        return Response.json({
          version: 1,
          run: state(),
          snapshots: [],
          accounting: RolloutAccounting.empty(),
          elapsedMs: 4,
        })
      return Response.json({ name: "UnexpectedEndpoint", data: { message: url.pathname } }, { status: 404 })
    },
  })
  const config = `${tmp.path}/experiment.json`
  await Bun.write(config, JSON.stringify({ version: 1, label: "test", overrides: { compaction: { prune: false } } }))
  const child = Bun.spawn(
    [
      process.execPath,
      "--conditions=browser",
      "src/index.ts",
      "send",
      "hello",
      ...(command ? ["--command", "test"] : []),
      "--session",
      sessionID,
      "--attach",
      server.url.toString(),
      "--format",
      "json",
      "--non-interactive",
      "--timeout",
      "10",
      "--experiment",
      config,
    ],
    {
      cwd: import.meta.dir + "/../..",
      env: { ...process.env, SYNERGY_HOME: `${tmp.path}/home`, SYNERGY_CWD: tmp.path },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  const events = stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
  return { events, stderr, exitCode, polls, cancelled, rejected, experiment }
}

test("send ignores session idle and returns the persisted run result with sequenced JSON", async () => {
  const result = await run()
  expect(result.exitCode).toBe(0)
  expect(result.polls).toBeGreaterThanOrEqual(3)
  expect(result.events.at(-1)).toMatchObject({
    version: 1,
    seq: result.events.length,
    type: "result",
    runID: "msg_test",
    exitCode: 0,
  })
  expect(result.experiment).toMatchObject({ version: 1, label: "test", overrides: { compaction: { prune: false } } })
}, 20_000)

for (const interaction of ["permission", "question"] as const)
  test(`non-interactive ${interaction} cancels the run and exits without granting permission`, async () => {
    const result = await run(interaction)
    expect(result.cancelled).toBe(true)
    expect(result.rejected).toBe(true)
    expect(result.exitCode).toBe(4)
    expect(result.events.at(-1)).toMatchObject({ type: "result", outcome: "interaction_required", exitCode: 4 })
  }, 20_000)

test("command processes non-interactive approvals before the command response completes", async () => {
  const result = await run("permission", true)
  expect(result.cancelled).toBe(true)
  expect(result.rejected).toBe(true)
  expect(result.exitCode).toBe(4)
}, 20_000)

test("command cancellation waits for its durable run to be created", async () => {
  const result = await run("permission", true, true)
  expect(result.cancelled).toBe(true)
  expect(result.exitCode).toBe(4)
}, 20_000)

for (const [name, exitCode] of [
  ["RolloutRecordingError", 5],
  ["UnknownError", 2],
] as const)
  test(`send preserves exit code ${exitCode} when input fails with ${name}`, async () => {
    const result = await run(undefined, false, false, name)
    expect(result.exitCode).toBe(exitCode)
    expect(result.events.at(-1)).toMatchObject({ type: "failed", exitCode })
  }, 20_000)
