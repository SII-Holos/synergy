#!/usr/bin/env bun

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"

type PresetName = keyof typeof presets
type Phase = "idle" | "trajectory-root" | "parallel-subagents" | "terminal" | "release"

interface TrajectoryFixture {
  schemaVersion: number
  name: string
  provenance: Record<string, unknown>
  aggregate: {
    sessions: number
    childSessions: number
    messages: number
    parts: number
    totalStoredBytes: number
    roles: Record<string, number>
    partTypes: Record<string, number>
    tools: Record<string, number>
    toolStatuses: Record<string, number>
    textPayloadBytes: number
    toolInputBytes: number
    toolOutputBytes: number
  }
  sessions: TrajectorySession[]
}

interface TrajectorySession {
  session: string
  relation: "root" | "child"
  parent: string | null
  parentMessage: string | null
  terminalStatus: string
  durationMs: number | null
  messages: TrajectoryMessage[]
}

interface TrajectoryMessage {
  message: string
  role: "user" | "assistant"
  startOffsetMs: number
  durationMs: number | null
  finish: string | null
  infoBytes: number
  tokenCounts: {
    input: number
    output: number
    reasoning: number
    cacheRead: number
    cacheWrite: number
  } | null
  originType: string | null
  originKeys: string[]
  partTypeCounts: Record<string, number>
  partStoredBytes: number
  textPayloadBytes: number
  tools: TrajectoryTool[]
}

interface TrajectoryTool {
  tool: string
  status: string
  storedBytes: number
  inputBytes: number
  outputBytes: number
  metadataBytes: number
  child?: string
}

interface TrajectoryTurn {
  user: TrajectoryMessage
  responses: TrajectoryMessage[]
}

interface ServiceMemory {
  rssBytes: number
  source: string
  completeness: string
}

interface MemorySample {
  label: string
  phase: Phase
  elapsedMs: number
  elapsedFromReleaseMs: number | null
  rssBytes: number
  heapUsedBytes: number
  heapTotalBytes: number
  externalBytes: number
  arrayBuffersBytes: number
  childProcessCount: number
  childProcessRssBytes: number
  serviceMemory: ServiceMemory | null
  runtime: {
    sessionRuntimeCount: number
    activeTurnCount: number
    activeStreamCount: number
    messageCacheBytes: number
  }
}

interface PerformanceSummary {
  resources: {
    rssBytes?: number
    heapUsedBytes?: number
    heapTotalBytes?: number
    externalBytes?: number
    arrayBuffersBytes?: number
    childProcessCount?: number
    childProcessRssBytes?: number
    serviceMemory?: ServiceMemory
  }
  runtime: {
    sessionRuntimes: { totalCount: number }
    llmTurns: { activeTurnCount: number; activeStreamCount: number }
    messageCache: { totalBytes: number }
  }
}

interface SessionInfo {
  id: string
  pendingReply?: boolean
  cortex?: {
    status?: string
    description?: string
  }
}

interface ChildrenPage {
  items: SessionInfo[]
  total: number
}

interface HistoryMessage {
  info: { role: string; finish?: string; origin?: { type?: string } }
  parts: Array<{
    type: string
    text?: string
    tool?: string
    state?: { status?: string; input?: unknown; output?: unknown }
  }>
}

interface SessionStatus {
  type: string
}

interface ProviderRequestStat {
  kind: "trajectory" | "support"
  fixtureSession: string | null
  fixtureMessage: string | null
  userMessageCount: number
  requestBytes: number
  toolDefinitionCount: number
}

const presets = {
  smoke: {
    fullTrajectory: false,
    durationScale: 0,
    idleSettleMs: 1_500,
    sampleIntervalMs: 500,
    releaseOffsetsMs: [1_000, 3_000, 5_000],
  },
  standard: {
    fullTrajectory: true,
    durationScale: 0.01,
    idleSettleMs: 5_000,
    sampleIntervalMs: 1_000,
    releaseOffsetsMs: [5_000, 30_000, 120_000],
  },
} as const

const MODEL = { providerID: "benchmark", modelID: "benchmark-model" } as const
const PAYLOAD_TOOL = "mcp__trajectory__payload"
const TRAJECTORY_MARKER = "SYNERGY_TRAJECTORY:"
const TERMINAL_CORTEX_STATUSES = new Set(["completed", "error", "cancelled", "interrupted"])

const presetName = argument("--preset") ?? "standard"
if (!(presetName in presets)) throw new Error(`Unknown preset: ${presetName}`)
const preset = presets[presetName as PresetName]

const repositoryRoot = path.join(import.meta.dir, "..")
const packagesSynergyDirectory = path.join(repositoryRoot, "packages", "synergy")
const fixturePath = path.join(import.meta.dir, "fixtures", "session-memory-trajectory.json")
const fixture = (await Bun.file(fixturePath).json()) as TrajectoryFixture
validateFixture(fixture)
const fixtureSessions = new Map(fixture.sessions.map((session) => [session.session, session]))
const fixtureTurns = new Map(fixture.sessions.map((session) => [session.session, partitionTurns(session.messages)]))

const startedAt = Date.now()
const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "synergy-runtime-memory-"))
const workspace = path.join(temporaryRoot, "workspace")
const mcpServerPath = path.join(temporaryRoot, "trajectory-mcp.mjs")
const mock = createMockProvider()
const serverPort = reservePort()
let server: ReturnType<typeof Bun.spawn> | undefined
let serverOutput: ReturnType<typeof captureTail> | undefined
let primarySessionID: string | undefined
let result: Record<string, unknown> | undefined
let cleanupComplete = false

try {
  await mkdir(path.join(temporaryRoot, ".synergy"), { recursive: true })
  await mkdir(workspace, { recursive: true })
  await writeTrajectoryMcp(mcpServerPath)

  const env = isolatedEnvironment(benchmarkConfig(mock.url, mcpServerPath))
  server = Bun.spawn({
    cmd: [
      process.execPath,
      "run",
      "--conditions=browser",
      "./src/index.ts",
      "server",
      "--port",
      String(serverPort),
      "--hostname",
      "127.0.0.1",
      "--non-interactive",
      "--no-banner",
    ],
    cwd: packagesSynergyDirectory,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  serverOutput = captureTail(server.stdout, server.stderr)

  const baseUrl = `http://127.0.0.1:${serverPort}`
  await waitForHealth(baseUrl, server)
  await waitForTool(baseUrl, workspace, PAYLOAD_TOOL)
  await waitForResourceSample(baseUrl, workspace)
  await Bun.sleep(preset.idleSettleMs)

  let phase: Phase = "idle"
  let releaseAt: number | undefined
  const samples: MemorySample[] = []
  let samplerError: unknown
  let samplerRunning = true
  const sampler = (async () => {
    while (samplerRunning) {
      try {
        samples.push(await sampleMemory(baseUrl, "periodic", phase, startedAt, releaseAt))
      } catch (error) {
        samplerError = error
        break
      }
      await Bun.sleep(preset.sampleIntervalMs)
    }
  })()

  const setPhase = async (next: Phase) => {
    phase = next
    samples.push(await sampleMemory(baseUrl, "boundary", phase, startedAt, releaseAt))
  }

  await setPhase("idle")
  const toolIDs = await scopedJson<string[]>(baseUrl, workspace, "/experimental/tool/ids")
  const tools = Object.fromEntries(toolIDs.map((id) => [id, false]))
  tools[PAYLOAD_TOOL] = true
  tools.read = true
  tools.task = true
  tools.task_output = true

  primarySessionID = (await createSession(baseUrl, workspace, "Trajectory memory benchmark", "full_access")).id
  const rootFixture = fixture.sessions.find((session) => session.relation === "root")!
  const rootTurns = fixtureTurns.get(rootFixture.session)!
  const manualTurns = rootTurns.filter((turn) => turn.user.originType === "user")
  const replayStartedAt = Date.now()

  await setPhase("trajectory-root")
  await promptAsync(
    baseUrl,
    workspace,
    primarySessionID,
    tools,
    trajectoryText(rootTurns[0].user.textPayloadBytes, `${TRAJECTORY_MARKER}${rootFixture.session}`),
  )

  if (preset.fullTrajectory) {
    if (manualTurns.length !== 2) throw new Error(`Expected two manual root turns, received ${manualTurns.length}`)
    const followUp = manualTurns[1]
    await sleepUntil(replayStartedAt + scaleTime(followUp.user.startOffsetMs))
    await promptAsync(
      baseUrl,
      workspace,
      primarySessionID,
      tools,
      trajectoryText(followUp.user.textPayloadBytes, `${TRAJECTORY_MARKER}${rootFixture.session}`),
    )
    await withTimeout(mock.firstChildRequest, 60_000, "first trajectory child request")
    await setPhase("parallel-subagents")
  }

  const expectedResponses = preset.fullTrajectory ? fixture.aggregate.roles.assistant : rootTurns[0].responses.length
  await waitForReplayTerminal({
    baseUrl,
    directory: workspace,
    rootSessionID: primarySessionID,
    expectedChildren: preset.fullTrajectory ? fixture.aggregate.childSessions : 0,
    expectedResponses,
    mock,
  })
  await setPhase("terminal")

  const verification = await verifyReplay({
    baseUrl,
    directory: workspace,
    rootSessionID: primarySessionID,
    fullTrajectory: preset.fullTrajectory,
  })

  await deleteSession(baseUrl, workspace, primarySessionID)
  primarySessionID = undefined

  releaseAt = Date.now()
  await setPhase("release")
  for (const offset of preset.releaseOffsetsMs) {
    await sleepUntil(releaseAt + offset)
    samples.push(await sampleMemory(baseUrl, `release-plus-${formatOffset(offset)}`, phase, startedAt, releaseAt))
  }

  samplerRunning = false
  await sampler
  if (samplerError) throw samplerError

  const idle = samples.find((sample) => sample.phase === "idle")
  if (!idle) throw new Error("Idle memory sample is missing")
  result = {
    schemaVersion: 2,
    harness: "synergy-session-runtime-memory",
    generatedAt: new Date().toISOString(),
    platform: process.platform,
    arch: process.arch,
    bunVersion: Bun.version,
    preset: presetName,
    fixture: {
      name: fixture.name,
      schemaVersion: fixture.schemaVersion,
      replay: preset.fullTrajectory ? "complete" : "first-completed-exchange",
      provenance: fixture.provenance,
      aggregate: preset.fullTrajectory ? fixture.aggregate : summarizeSmoke(rootTurns[0]),
      durationScale: preset.durationScale,
    },
    adapter: {
      isolatedTemporaryRuntime: true,
      loopbackOnly: true,
      provider: "deterministic-local-openai-compatible",
      nativePaths: ["session.prompt_async", "task", "task_output", "cortex completion notification"],
      sideEffectingTools: `mapped to ${PAYLOAD_TOOL}`,
      preserves: ["call count", "input bytes", "output bytes", "error status", "message order"],
    },
    checks: {
      health: true,
      fixtureValidated: true,
      fullHttpSessionFlow: true,
      providerStreaming: true,
      backgroundSubagents: preset.fullTrajectory,
      cortexNotifications: preset.fullTrajectory,
      taskOutputRetrieval: preset.fullTrajectory,
      terminalState: true,
      pendingReplyCleared: true,
      noRunningTools: true,
      ...verification,
    },
    provider: summarizeProvider(mock.requests),
    phasePeaks: summarizePhasePeaks(samples),
    samples: samples.map((sample) => ({ ...sample, deltaFromIdle: subtractMemory(sample, idle) })),
  }
} catch (error) {
  const detail = serverOutput?.value ? `\nServer output:\n${sanitize(serverOutput.value, temporaryRoot)}` : ""
  throw new Error(`${error instanceof Error ? error.message : String(error)}${detail}`, { cause: error })
} finally {
  if (server && server.exitCode === null) await stopProcess(server)
  await serverOutput?.done.catch(() => {})
  mock.stop()
  await rm(temporaryRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  cleanupComplete = true
}

if (!result) throw new Error("Runtime benchmark completed without a result")
console.log(JSON.stringify({ ...result, cleanup: { temporaryRuntimeRemoved: cleanupComplete } }, null, 2))

function benchmarkConfig(mockUrl: string, mcpPath: string) {
  const model = "benchmark/benchmark-model"
  const payloadPermission = { [PAYLOAD_TOOL]: "allow" }
  return {
    enabled_providers: ["benchmark"],
    providerCatalog: { enabled: false },
    model,
    nano_model: model,
    mini_model: model,
    mid_model: model,
    thinking_model: model,
    default_agent: "synergy",
    agent: {
      synergy: {
        model,
        steps: 10,
        permission: { "*": "deny", read: "allow", task: "allow", task_output: "allow", ...payloadPermission },
      },
      "benchmark-subagent": {
        mode: "subagent",
        model,
        steps: 32,
        description: "Replay one anonymized trajectory branch.",
        visibleTo: ["synergy"],
        permission: { "*": "deny", read: "allow", ...payloadPermission },
      },
    },
    provider: {
      benchmark: {
        name: "Deterministic Local Benchmark",
        npm: "@ai-sdk/openai-compatible",
        api: `${mockUrl}/v1`,
        env: ["SYNERGY_BENCHMARK_API_KEY"],
        options: { baseURL: `${mockUrl}/v1`, noProxy: true },
        models: {
          "benchmark-model": {
            id: "benchmark-model",
            name: "Benchmark Model",
            family: "benchmark",
            tool_call: true,
            modalities: { input: ["text"], output: ["text"] },
            limit: { context: 1_048_576, output: 262_144 },
          },
        },
      },
    },
    mcp: {
      trajectory: {
        type: "local",
        command: [process.execPath, mcpPath],
        cwd: workspace,
        startup: "eager",
        required: true,
        connectTimeout: 30_000,
        listTimeout: 30_000,
        callTimeout: 30_000,
        tools: { approval: "auto", maxOutputBytes: 64 * 1024 },
      },
    },
    snapshot: false,
    lsp: false,
    formatter: false,
    project_doc_max_bytes: 0,
    instructions: [],
    sandbox: { enabled: false },
    holos: { enabled: false },
    library: {
      memory: { enabled: false },
      experience: { encode: false, retrieve: false },
      autonomy: false,
    },
    observability: {
      enabled: true,
      performance: {
        enabled: true,
        samplingRate: 1,
        resourceSampleIntervalMs: Math.min(1_000, preset.sampleIntervalMs),
        storage: { sqliteEnabled: true, jsonlMirrorEnabled: false },
      },
    },
  }
}

function isolatedEnvironment(config: ReturnType<typeof benchmarkConfig>) {
  const env = { ...process.env }
  for (const key of [
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
    "SYNERGY_CONFIG",
    "SYNERGY_CONFIG_DIR",
  ]) {
    delete env[key]
  }
  return {
    ...env,
    SYNERGY_HOME: temporaryRoot,
    SYNERGY_CWD: workspace,
    SYNERGY_CONFIG_CONTENT: JSON.stringify(config),
    SYNERGY_BENCHMARK_API_KEY: "local-benchmark-key",
    SYNERGY_DISABLE_LSP_DOWNLOAD: "1",
    NO_PROXY: "localhost,127.0.0.1,::1",
  }
}

function createMockProvider() {
  const requests: ProviderRequestStat[] = []
  const cursors = new Map<string, number>()
  const terminalChild = new Map(
    fixture.sessions
      .filter((session) => session.relation === "child")
      .map((session) => [session.session, deferred<void>()]),
  )
  const responseObserved = new Map(
    fixture.sessions
      .flatMap((session) => session.messages)
      .filter((message) => message.role === "assistant")
      .map((message) => [message.message, deferred<void>()]),
  )
  const firstChild = deferred<void>()
  let trajectoryResponseCount = 0

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      if (request.method !== "POST" || url.pathname !== "/v1/chat/completions") {
        return new Response("Not found", { status: 404 })
      }
      const raw = await request.text()
      const body = JSON.parse(raw) as {
        messages?: Array<{ role?: string; content?: unknown }>
        tools?: unknown[]
      }
      const messages = body.messages ?? []
      if (isSupportRequest(messages)) {
        requests.push({
          kind: "support",
          fixtureSession: null,
          fixtureMessage: null,
          userMessageCount: messages.filter((message) => message.role === "user").length,
          requestBytes: Buffer.byteLength(raw),
          toolDefinitionCount: body.tools?.length ?? 0,
        })
        return textStream("Trajectory benchmark")
      }

      const fixtureSessionID = findFixtureSession(messages)
      const session = fixtureSessions.get(fixtureSessionID)
      const turns = fixtureTurns.get(fixtureSessionID)
      if (!session || !turns) return new Response("Unknown trajectory session", { status: 400 })
      if (session.relation === "child") firstChild.resolve()

      const userMessageCount = messages.filter((message) => message.role === "user").length
      const turn = turns[userMessageCount - 1]
      if (!turn) return new Response("Unexpected trajectory user turn", { status: 400 })
      const cursorKey = `${fixtureSessionID}:${userMessageCount}`
      const cursor = cursors.get(cursorKey) ?? 0
      const responseFixture = turn.responses[cursor]
      if (!responseFixture) return new Response("Trajectory response exhausted", { status: 400 })
      cursors.set(cursorKey, cursor + 1)
      trajectoryResponseCount++
      responseObserved.get(responseFixture.message)?.resolve()

      requests.push({
        kind: "trajectory",
        fixtureSession: fixtureSessionID,
        fixtureMessage: responseFixture.message,
        userMessageCount,
        requestBytes: Buffer.byteLength(raw),
        toolDefinitionCount: body.tools?.length ?? 0,
      })

      const lastResponse = cursor + 1 === turn.responses.length
      const taskID = responseFixture.tools.some((tool) => tool.tool === "task_output")
        ? taskIDFromLatestNotification(messages)
        : undefined
      const response = completionFor(responseFixture, taskID)
      const childTerminal =
        session.relation === "child" && lastResponse && responseFixture.finish === "stop"
          ? terminalChild.get(session.session)
          : undefined
      const childCompletionGuard = childTerminal ? rootMessageObservedBeforeChildCompletion(session) : undefined
      const nextNotificationChild =
        session.relation === "root" && lastResponse && responseFixture.tools.length > 0
          ? childForNextCortexTurn(turns, userMessageCount)
          : undefined

      return eventStream(response.events, {
        delayMs: scaleTime(responseFixture.durationMs ?? 0),
        beforeDone:
          childCompletionGuard || nextNotificationChild
            ? async () => {
                if (childCompletionGuard) {
                  await withTimeout(
                    responseObserved.get(childCompletionGuard)!.promise,
                    60_000,
                    `${session.session} completion ordering`,
                  )
                }
                if (!nextNotificationChild) return
                await withTimeout(terminalChild.get(nextNotificationChild)!.promise, 60_000, nextNotificationChild)
                await Bun.sleep(50)
              }
            : undefined,
        onDone: () => childTerminal?.resolve(),
      })
    },
  })

  return {
    url: `http://127.0.0.1:${server.port}`,
    requests,
    firstChildRequest: firstChild.promise,
    get trajectoryResponseCount() {
      return trajectoryResponseCount
    },
    get missingResponseMessages() {
      const seen = new Set(
        requests
          .filter((request) => request.kind === "trajectory")
          .map((request) => request.fixtureMessage)
          .filter((message): message is string => Boolean(message)),
      )
      return fixture.sessions
        .flatMap((session) => session.messages)
        .filter((message) => message.role === "assistant" && !seen.has(message.message))
        .map((message) => message.message)
    },
    stop: () => server.stop(true),
  }
}

function completionFor(message: TrajectoryMessage, taskID: string | undefined) {
  const content = deterministicText(message.textPayloadBytes, message.message)
  const toolCalls = message.tools.map((tool, index) => ({
    index,
    id: `call_${message.message.replaceAll("-", "_")}_${index}`,
    type: "function",
    function: {
      name: replayToolName(tool),
      arguments: replayToolArguments(tool, message, index, taskID),
    },
  }))
  const delta: Record<string, unknown> = { role: "assistant" }
  if (content) delta.content = content
  if (toolCalls.length > 0) delta.tool_calls = toolCalls
  const finishReason = toolCalls.length > 0 ? "tool_calls" : "stop"
  const tokens = message.tokenCounts
  const usage = tokens
    ? {
        prompt_tokens: tokens.input + tokens.cacheRead + tokens.cacheWrite,
        completion_tokens: tokens.output + tokens.reasoning,
        total_tokens: tokens.input + tokens.output + tokens.reasoning + tokens.cacheRead + tokens.cacheWrite,
      }
    : { prompt_tokens: 1, completion_tokens: Math.max(1, Math.ceil(message.textPayloadBytes / 4)), total_tokens: 1 }
  return {
    events: [completionChunk(delta, null), completionChunk({}, finishReason, usage)],
  }
}

function replayToolName(tool: TrajectoryTool) {
  if (tool.tool === "task" || tool.tool === "task_output") return tool.tool
  if (tool.tool === "read" && tool.status === "error") return "read"
  return PAYLOAD_TOOL
}

function replayToolArguments(
  tool: TrajectoryTool,
  message: TrajectoryMessage,
  index: number,
  taskID: string | undefined,
) {
  if (tool.tool === "task") {
    if (!tool.child) throw new Error(`Task fixture ${message.message}:${index} is missing its child link`)
    return exactJson(
      {
        description: `Trajectory child ${tool.child}`,
        prompt: `${TRAJECTORY_MARKER}${tool.child}`,
        subagent_type: "benchmark-subagent",
        background: true,
      },
      "prompt",
      tool.inputBytes,
      `${message.message}-task-${index}`,
    )
  }
  if (tool.tool === "task_output") {
    if (!taskID) throw new Error(`Task output fixture ${message.message}:${index} has no completion notification ID`)
    return JSON.stringify({ task_id: taskID, mode: "full" })
  }
  if (tool.tool === "read" && tool.status === "error") {
    return exactJson(
      { filePath: "trajectory_missing_" },
      "filePath",
      tool.inputBytes,
      `${message.message}-missing-read-${index}`,
      true,
    )
  }
  return exactJson(
    {
      n: tool.outputBytes,
      t: tool.tool,
      e: tool.status === "error" ? 1 : 0,
      p: "",
    },
    "p",
    tool.inputBytes,
    `${message.message}-tool-${index}`,
  )
}

function completionChunk(delta: Record<string, unknown>, finishReason: string | null, usage?: Record<string, number>) {
  return {
    id: "chatcmpl-trajectory-benchmark",
    object: "chat.completion.chunk",
    created: 0,
    model: "benchmark-model",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
    ...(usage ? { usage } : {}),
  }
}

function textStream(value: string) {
  return eventStream([
    completionChunk({ role: "assistant", content: value }, null),
    completionChunk({}, "stop", { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }),
  ])
}

function eventStream(
  events: Array<Record<string, unknown>>,
  options: { delayMs?: number; beforeDone?: () => Promise<void>; onDone?: () => void } = {},
) {
  const encoder = new TextEncoder()
  let index = 0
  let delayed = false
  let finishing = false
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!delayed) {
        delayed = true
        if (options.delayMs) await Bun.sleep(options.delayMs)
      }
      if (index < events.length) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(events[index++])}\n\n`))
        return
      }
      if (finishing) return
      finishing = true
      await options.beforeDone?.()
      controller.enqueue(encoder.encode("data: [DONE]\n\n"))
      controller.close()
      options.onDone?.()
    },
  })
  return new Response(stream, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
  })
}

async function writeTrajectoryMcp(filepath: string) {
  const sdkRoot = path.join(packagesSynergyDirectory, "node_modules", "@modelcontextprotocol", "sdk", "dist", "esm")
  const mcpModule = pathToFileURL(path.join(sdkRoot, "server", "mcp.js")).href
  const stdioModule = pathToFileURL(path.join(sdkRoot, "server", "stdio.js")).href
  const zodModule = pathToFileURL(path.join(packagesSynergyDirectory, "node_modules", "zod", "index.js")).href
  await writeFile(
    filepath,
    `import { McpServer } from ${JSON.stringify(mcpModule)}
import { StdioServerTransport } from ${JSON.stringify(stdioModule)}
import { z } from ${JSON.stringify(zodModule)}

const server = new McpServer({ name: "trajectory", version: "1.0.0" })
server.tool(
  "payload",
  "Return a deterministic payload for the Synergy memory trajectory benchmark.",
  { n: z.number().int().nonnegative(), t: z.string(), e: z.number().int(), p: z.string() },
  async ({ n, t, e }) => {
    if (e) throw new Error("deterministic trajectory tool error")
    const bytes = Math.max(0, n - 2)
    const pattern = t + "|0123456789abcdef|"
    const text = pattern.repeat(Math.ceil(bytes / pattern.length)).slice(0, bytes)
    return { content: [{ type: "text", text }] }
  },
)
await server.connect(new StdioServerTransport())
`,
  )
}

function partitionTurns(messages: TrajectoryMessage[]) {
  const turns: TrajectoryTurn[] = []
  for (const message of messages) {
    if (message.role === "user") {
      turns.push({ user: message, responses: [] })
      continue
    }
    const turn = turns.at(-1)
    if (!turn) throw new Error(`Assistant message ${message.message} has no preceding user message`)
    turn.responses.push(message)
  }
  return turns
}

function childForNextCortexTurn(turns: TrajectoryTurn[], currentUserCount: number) {
  const next = turns[currentUserCount]
  if (!next || next.user.originType !== "cortex") return undefined
  const notificationIndex =
    turns.slice(0, currentUserCount + 1).filter((turn) => turn.user.originType === "cortex").length - 1
  return fixture.sessions
    .filter((session) => session.relation === "child")
    .sort((left, right) => sessionEndOffset(left) - sessionEndOffset(right))[notificationIndex]?.session
}

function sessionEndOffset(session: TrajectorySession) {
  const last = session.messages.at(-1)
  return last ? last.startOffsetMs + (last.durationMs ?? 0) : 0
}

function rootMessageObservedBeforeChildCompletion(child: TrajectorySession) {
  const root = fixture.sessions.find((session) => session.relation === "root")
  if (!root) return undefined
  const childEnd = sessionEndOffset(child)
  return root.messages
    .filter((message) => message.role === "assistant" && message.startOffsetMs <= childEnd)
    .sort((left, right) => right.startOffsetMs - left.startOffsetMs)[0]?.message
}

function findFixtureSession(messages: Array<{ role?: string; content?: unknown }>) {
  const serialized = JSON.stringify(messages)
  const match = serialized.match(new RegExp(`${TRAJECTORY_MARKER}(s\\d+)`))
  if (!match) throw new Error("Provider request did not contain a trajectory marker")
  return match[1]
}

function taskIDFromLatestNotification(messages: Array<{ role?: string; content?: unknown }>) {
  const user = [...messages].reverse().find((message) => message.role === "user")
  const match = JSON.stringify(user?.content ?? "").match(/task_output\(task_id=\\?"([^"\\]+)\\?"/)
  if (!match) throw new Error("Cortex completion notification did not contain a task ID")
  return match[1]
}

function isSupportRequest(messages: Array<{ role?: string; content?: unknown }>) {
  const serialized = JSON.stringify(messages)
  return (
    serialized.includes("Generate a title for this conversation") ||
    serialized.includes("Generate a concise title") ||
    serialized.includes("Summarize this conversation")
  )
}

function exactJson(
  base: Record<string, unknown>,
  paddingKey: string,
  targetBytes: number,
  seed: string,
  filenameSafe = false,
) {
  const current = Buffer.byteLength(JSON.stringify(base))
  if (current > targetBytes) {
    throw new Error(`Fixture input ${seed} cannot fit ${targetBytes} bytes (minimum ${current})`)
  }
  const prefix = typeof base[paddingKey] === "string" ? base[paddingKey] : ""
  base[paddingKey] =
    prefix + (filenameSafe ? "x".repeat(targetBytes - current) : deterministicText(targetBytes - current, seed))
  const result = JSON.stringify(base)
  const actual = Buffer.byteLength(result)
  if (actual !== targetBytes)
    throw new Error(`Fixture input ${seed}: expected ${targetBytes} bytes, produced ${actual}`)
  return result
}

function trajectoryText(bytes: number, marker: string) {
  if (Buffer.byteLength(marker) > bytes) throw new Error(`Trajectory marker does not fit ${bytes} bytes`)
  return marker + deterministicText(bytes - Buffer.byteLength(marker), `${marker}|`)
}

function deterministicText(bytes: number, seed: string) {
  if (bytes <= 0) return ""
  const pattern = `${seed}|0123456789abcdef|`
  return pattern.repeat(Math.ceil(bytes / pattern.length)).slice(0, bytes)
}

function scaleTime(milliseconds: number) {
  return Math.max(0, Math.round(milliseconds * preset.durationScale))
}

function validateFixture(input: TrajectoryFixture) {
  if (input.schemaVersion !== 1) throw new Error(`Unsupported trajectory fixture schema: ${input.schemaVersion}`)
  const sessions = new Set(input.sessions.map((session) => session.session))
  const messages = input.sessions.flatMap((session) => session.messages)
  const tools = messages.flatMap((message) => message.tools)
  if (sessions.size !== input.aggregate.sessions) throw new Error("Trajectory Session count does not match aggregate")
  if (messages.length !== input.aggregate.messages) throw new Error("Trajectory message count does not match aggregate")
  if (tools.length !== input.aggregate.partTypes.tool) throw new Error("Trajectory tool count does not match aggregate")
  for (const session of input.sessions) {
    if (session.parent && !sessions.has(session.parent)) throw new Error(`Unknown trajectory parent: ${session.parent}`)
    for (const tool of session.messages.flatMap((message) => message.tools)) {
      if (tool.child && !sessions.has(tool.child)) throw new Error(`Unknown trajectory child: ${tool.child}`)
    }
  }
  const sensitive = JSON.stringify(input)
  for (const pattern of ["/home/", "ses_", "msg_", "call_", "providerID", "modelID", "apiKey", "sk-"]) {
    if (sensitive.includes(pattern)) throw new Error(`Trajectory fixture contains forbidden source data: ${pattern}`)
  }
}

async function createSession(baseUrl: string, directory: string, title: string, controlProfile: string) {
  return scopedJson<SessionInfo>(baseUrl, directory, "/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title, controlProfile }),
  })
}

async function promptAsync(
  baseUrl: string,
  directory: string,
  sessionID: string,
  tools: Record<string, boolean>,
  text: string,
) {
  const response = await scopedRequest(baseUrl, directory, `/session/${encodeURIComponent(sessionID)}/prompt_async`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      agent: "synergy",
      tools,
      parts: [{ type: "text", text }],
    }),
  })
  if (!response.ok)
    throw new Error(`Async prompt failed with HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`)
}

async function deleteSession(baseUrl: string, directory: string, sessionID: string) {
  const removed = await scopedJson<boolean>(baseUrl, directory, `/session/${encodeURIComponent(sessionID)}`, {
    method: "DELETE",
  })
  if (!removed) throw new Error("Session deletion returned false")
}

async function waitForReplayTerminal(input: {
  baseUrl: string
  directory: string
  rootSessionID: string
  expectedChildren: number
  expectedResponses: number
  mock: ReturnType<typeof createMockProvider>
}) {
  const deadline = Date.now() + 180_000
  let detail = ""
  let terminalSince: number | undefined
  while (Date.now() < deadline) {
    const root = await scopedJson<SessionInfo>(
      input.baseUrl,
      input.directory,
      `/session/${encodeURIComponent(input.rootSessionID)}`,
    )
    const statuses = await scopedJson<Record<string, SessionStatus>>(input.baseUrl, input.directory, "/session/status")
    const children = await scopedJson<ChildrenPage>(
      input.baseUrl,
      input.directory,
      `/session/${encodeURIComponent(input.rootSessionID)}/children?limit=50&includeArchived=true`,
    )
    const childrenTerminal =
      children.total === input.expectedChildren &&
      children.items.every((child) => child.cortex?.status && TERMINAL_CORTEX_STATUSES.has(child.cortex.status))
    const rootIdle =
      !root.pendingReply && (!statuses[input.rootSessionID] || statuses[input.rootSessionID].type === "idle")
    const responsesComplete = input.mock.trajectoryResponseCount === input.expectedResponses
    detail = JSON.stringify({
      rootIdle,
      childCount: children.total,
      childrenTerminal,
      responses: input.mock.trajectoryResponseCount,
      expectedResponses: input.expectedResponses,
      missingResponses: input.mock.missingResponseMessages,
    })
    if (rootIdle && childrenTerminal && responsesComplete) return
    if (rootIdle && childrenTerminal) {
      terminalSince ??= Date.now()
      if (Date.now() - terminalSince >= 5_000)
        throw new Error(`Trajectory reached an incomplete terminal state: ${detail}`)
    } else {
      terminalSince = undefined
    }
    await Bun.sleep(100)
  }
  throw new Error(`Trajectory did not settle: ${detail}`)
}

async function verifyReplay(input: {
  baseUrl: string
  directory: string
  rootSessionID: string
  fullTrajectory: boolean
}) {
  const rootFixture = fixture.sessions.find((session) => session.relation === "root")!
  const rootHistory = await scopedJson<HistoryMessage[]>(
    input.baseUrl,
    input.directory,
    `/session/${encodeURIComponent(input.rootSessionID)}/message?limit=100`,
  )
  const expectedRootMessages = input.fullTrajectory ? rootFixture.messages.length : 2
  const runtimeBoundaryMessages = rootHistory.filter(isRuntimeBoundaryMessage).length
  const expectedRuntimeBoundaries = input.fullTrajectory ? expectedRuntimeBoundaryMessages(rootFixture, 10) : 0
  assertNumber(runtimeBoundaryMessages, expectedRuntimeBoundaries, "runtime boundary message count")
  assertNumber(rootHistory.length - runtimeBoundaryMessages, expectedRootMessages, "root trajectory message count")
  assertNumber(countRunningTools(rootHistory), 0, "root running tools")

  let childMessages = 0
  let childCount = 0
  const histories = [rootHistory]
  if (input.fullTrajectory) {
    const children = await scopedJson<ChildrenPage>(
      input.baseUrl,
      input.directory,
      `/session/${encodeURIComponent(input.rootSessionID)}/children?limit=50&includeArchived=true`,
    )
    assertNumber(children.total, fixture.aggregate.childSessions, "child Session count")
    childCount = children.total
    for (const child of children.items) {
      const alias = child.cortex?.description?.match(/Trajectory child (s\d+)/)?.[1]
      const expected = alias ? fixtureSessions.get(alias) : undefined
      if (!expected) throw new Error("Unable to match a replay child to its fixture alias")
      const history = await scopedJson<HistoryMessage[]>(
        input.baseUrl,
        input.directory,
        `/session/${encodeURIComponent(child.id)}/message?limit=100`,
      )
      assertNumber(history.length, expected.messages.length, `${alias} message count`)
      assertNumber(countRunningTools(history), 0, `${alias} running tools`)
      histories.push(history)
      childMessages += history.length
    }
    assertNumber(
      rootHistory.length + childMessages - runtimeBoundaryMessages,
      fixture.aggregate.messages,
      "trajectory message count",
    )
    assertNumber(countTools(rootHistory, "task"), fixture.aggregate.tools.task, "task tool count")
    assertNumber(countTools(rootHistory, "task_output"), fixture.aggregate.tools.task_output, "task_output tool count")
  }

  const toolParts = histories.flatMap((history) => history.flatMap((message) => message.parts)).filter(isToolPart)
  const completedTools = toolParts.filter((part) => part.state?.status === "completed").length
  const errorTools = toolParts.filter((part) => part.state?.status === "error").length
  const expectedTools = input.fullTrajectory ? fixture.aggregate.partTypes.tool : 0
  const expectedCompleted = input.fullTrajectory ? fixture.aggregate.toolStatuses.completed : 0
  const expectedErrors = input.fullTrajectory ? fixture.aggregate.toolStatuses.error : 0
  assertNumber(toolParts.length, expectedTools, "persisted tool call count")
  assertNumber(completedTools, expectedCompleted, "completed tool call count")
  assertNumber(errorTools, expectedErrors, "error tool call count")

  return {
    verifiedRootMessages: rootHistory.length,
    verifiedChildSessions: childCount,
    verifiedChildMessages: childMessages,
    verifiedRuntimeBoundaryMessages: runtimeBoundaryMessages,
    verifiedTrajectoryMessages: rootHistory.length + childMessages - runtimeBoundaryMessages,
    verifiedToolCalls: toolParts.length,
    verifiedCompletedTools: completedTools,
    verifiedErrorTools: errorTools,
  }
}

function isRuntimeBoundaryMessage(message: HistoryMessage) {
  return (
    message.info.role === "assistant" &&
    !message.info.finish &&
    message.parts.every(
      (part) => part.type !== "tool" && (part.type !== "text" || !part.text || Buffer.byteLength(part.text) === 0),
    )
  )
}

function expectedRuntimeBoundaryMessages(session: TrajectorySession, stepLimit: number) {
  return partitionTurns(session.messages).filter(
    (turn) => turn.responses.length >= stepLimit && turn.responses.at(-1)?.finish !== "stop",
  ).length
}

async function waitForTool(baseUrl: string, directory: string, tool: string) {
  const deadline = Date.now() + 30_000
  let lastInspection: unknown
  while (Date.now() < deadline) {
    const inspection = await scopedJson<{ status?: { status?: string }; toolNames?: string[] }>(
      baseUrl,
      directory,
      "/mcp/trajectory/inspect",
    ).catch(() => undefined)
    lastInspection = inspection
    if (inspection?.status?.status === "connected" && inspection.toolNames?.includes("payload")) return
    await Bun.sleep(250)
  }
  throw new Error(`Temporary benchmark tool was not discovered: ${tool}; inspection=${JSON.stringify(lastInspection)}`)
}

async function waitForResourceSample(baseUrl: string, directory: string) {
  const deadline = Date.now() + 15_000
  let lastSummary: PerformanceSummary | undefined
  while (Date.now() < deadline) {
    lastSummary = await requestJson<PerformanceSummary>(`${baseUrl}/global/performance/summary`)
    if (
      Number.isFinite(lastSummary.resources.rssBytes) &&
      Number.isFinite(lastSummary.resources.externalBytes) &&
      Number.isFinite(lastSummary.resources.arrayBuffersBytes)
    ) {
      return
    }
    await Bun.sleep(250)
  }
  const config = await scopedJson<unknown>(baseUrl, directory, "/global/performance/config").catch(() => undefined)
  throw new Error(
    `Temporary server did not publish a process resource sample; resources=${JSON.stringify(lastSummary?.resources)}; config=${JSON.stringify(config)}`,
  )
}

async function scopedJson<T>(baseUrl: string, directory: string, pathname: string, init: RequestInit = {}): Promise<T> {
  const response = await scopedRequest(baseUrl, directory, pathname, init)
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 1_000)
    throw new Error(`HTTP ${response.status}: ${detail}`)
  }
  return (await response.json()) as T
}

function scopedRequest(baseUrl: string, directory: string, pathname: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers)
  headers.set("x-synergy-directory", directory)
  return fetch(`${baseUrl}${pathname}`, {
    ...init,
    headers,
    signal: init.signal ?? AbortSignal.timeout(60_000),
  })
}

async function sampleMemory(
  baseUrl: string,
  label: string,
  phase: Phase,
  benchmarkStartedAt: number,
  releaseAt: number | undefined,
): Promise<MemorySample> {
  const summary = await requestJson<PerformanceSummary>(`${baseUrl}/global/performance/summary`)
  return {
    label,
    phase,
    elapsedMs: Date.now() - benchmarkStartedAt,
    elapsedFromReleaseMs: releaseAt === undefined ? null : Date.now() - releaseAt,
    rssBytes: requiredNumber(summary.resources.rssBytes, "resources.rssBytes"),
    heapUsedBytes: requiredNumber(summary.resources.heapUsedBytes, "resources.heapUsedBytes"),
    heapTotalBytes: requiredNumber(summary.resources.heapTotalBytes, "resources.heapTotalBytes"),
    externalBytes: requiredNumber(summary.resources.externalBytes, "resources.externalBytes"),
    arrayBuffersBytes: requiredNumber(summary.resources.arrayBuffersBytes, "resources.arrayBuffersBytes"),
    childProcessCount: summary.resources.childProcessCount ?? 0,
    childProcessRssBytes: summary.resources.childProcessRssBytes ?? 0,
    serviceMemory: summary.resources.serviceMemory ?? null,
    runtime: {
      sessionRuntimeCount: summary.runtime.sessionRuntimes.totalCount,
      activeTurnCount: summary.runtime.llmTurns.activeTurnCount,
      activeStreamCount: summary.runtime.llmTurns.activeStreamCount,
      messageCacheBytes: summary.runtime.messageCache.totalBytes,
    },
  }
}

async function requestJson<T>(url: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(url, { ...init, signal: init.signal ?? AbortSignal.timeout(60_000) })
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 1_000)}`)
  return (await response.json()) as T
}

function summarizeProvider(requests: ProviderRequestStat[]) {
  const trajectory = requests.filter((request) => request.kind === "trajectory")
  const support = requests.filter((request) => request.kind === "support")
  return {
    trajectoryRequestCount: trajectory.length,
    supportRequestCount: support.length,
    requestBytes: summarizeValues(trajectory.map((request) => request.requestBytes)),
    toolDefinitionCount: summarizeValues(trajectory.map((request) => request.toolDefinitionCount)),
    byFixtureSession: Object.fromEntries(
      fixture.sessions.map((session) => [
        session.session,
        trajectory.filter((request) => request.fixtureSession === session.session).length,
      ]),
    ),
  }
}

function summarizeValues(values: number[]) {
  if (values.length === 0) return { count: 0, min: 0, max: 0, total: 0 }
  return {
    count: values.length,
    min: Math.min(...values),
    max: Math.max(...values),
    total: values.reduce((sum, value) => sum + value, 0),
  }
}

function summarizeSmoke(turn: TrajectoryTurn) {
  return {
    sessions: 1,
    childSessions: 0,
    messages: 1 + turn.responses.length,
    tools: turn.responses.reduce((sum, response) => sum + response.tools.length, 0),
    textPayloadBytes:
      turn.user.textPayloadBytes + turn.responses.reduce((sum, response) => sum + response.textPayloadBytes, 0),
  }
}

function summarizePhasePeaks(samples: MemorySample[]) {
  return [...new Set(samples.map((sample) => sample.phase))].map((phase) => {
    const phaseSamples = samples.filter((sample) => sample.phase === phase)
    const peak = (
      key: keyof Pick<MemorySample, "rssBytes" | "heapUsedBytes" | "externalBytes" | "arrayBuffersBytes">,
    ) => Math.max(...phaseSamples.map((sample) => sample[key]))
    return {
      phase,
      sampleCount: phaseSamples.length,
      peakRssBytes: peak("rssBytes"),
      peakHeapUsedBytes: peak("heapUsedBytes"),
      peakExternalBytes: peak("externalBytes"),
      peakArrayBuffersBytes: peak("arrayBuffersBytes"),
    }
  })
}

function subtractMemory(sample: MemorySample, baseline: MemorySample) {
  return {
    rssBytes: sample.rssBytes - baseline.rssBytes,
    heapUsedBytes: sample.heapUsedBytes - baseline.heapUsedBytes,
    heapTotalBytes: sample.heapTotalBytes - baseline.heapTotalBytes,
    externalBytes: sample.externalBytes - baseline.externalBytes,
    arrayBuffersBytes: sample.arrayBuffersBytes - baseline.arrayBuffersBytes,
    childProcessRssBytes: sample.childProcessRssBytes - baseline.childProcessRssBytes,
    serviceMemoryRssBytes:
      sample.serviceMemory && baseline.serviceMemory
        ? sample.serviceMemory.rssBytes - baseline.serviceMemory.rssBytes
        : null,
  }
}

function countTools(messages: HistoryMessage[], tool: string) {
  return messages.flatMap((message) => message.parts).filter((part) => part.type === "tool" && part.tool === tool)
    .length
}

function countRunningTools(messages: HistoryMessage[]) {
  return messages
    .flatMap((message) => message.parts)
    .filter((part) => part.type === "tool" && (part.state?.status === "running" || part.state?.status === "pending"))
    .length
}

function isToolPart(part: HistoryMessage["parts"][number]) {
  return part.type === "tool"
}

function assertNumber(actual: number, expected: number, label: string) {
  if (actual !== expected) throw new Error(`${label}: expected ${expected}, received ${actual}`)
}

function requiredNumber(value: number | undefined, label: string) {
  if (!Number.isFinite(value)) throw new Error(`Performance summary omitted ${label}`)
  return value!
}

function reservePort() {
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null, { status: 503 }) })
  const port = probe.port
  probe.stop(true)
  return port
}

async function waitForHealth(baseUrl: string, child: ReturnType<typeof Bun.spawn>) {
  const deadline = Date.now() + 60_000
  let lastError = ""
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Synergy server exited during startup with code ${child.exitCode}`)
    try {
      const response = await fetch(`${baseUrl}/global/health`, { signal: AbortSignal.timeout(1_000) })
      if (response.ok) return
      lastError = `HTTP ${response.status}`
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }
    await Bun.sleep(250)
  }
  throw new Error(`Timed out waiting for temporary Synergy health${lastError ? `: ${lastError}` : ""}`)
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string) {
  return Promise.race([
    promise,
    Bun.sleep(timeoutMs).then(() => {
      throw new Error(`Timed out waiting for ${label}`)
    }),
  ])
}

async function sleepUntil(timestamp: number) {
  const remaining = timestamp - Date.now()
  if (remaining > 0) await Bun.sleep(remaining)
}

function formatOffset(offset: number) {
  return offset % 1_000 === 0 ? `${offset / 1_000}s` : `${offset}ms`
}

function captureTail(...streams: ReadableStream<Uint8Array>[]) {
  let value = ""
  const done = Promise.all(
    streams.map(async (stream) => {
      const decoder = new TextDecoder()
      const reader = stream.getReader()
      while (true) {
        const item = await reader.read()
        if (item.done) break
        value = (value + decoder.decode(item.value, { stream: true })).slice(-16_384)
      }
      reader.releaseLock()
    }),
  ).then(() => undefined)
  return {
    get value() {
      return value
    },
    done,
  }
}

async function stopProcess(child: ReturnType<typeof Bun.spawn>) {
  if (child.exitCode !== null) return
  child.kill()
  const exited = await Promise.race([child.exited.then(() => true), Bun.sleep(5_000).then(() => false)])
  if (exited) return
  child.kill("SIGKILL")
  await child.exited
}

function sanitize(value: string, root: string) {
  return value.replaceAll(root, "<temporary-home>").slice(-8_192)
}

function deferred<T>() {
  let settled = false
  let resolveValue!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((resolve) => {
    resolveValue = resolve
  })
  return {
    promise,
    resolve(value?: T) {
      if (settled) return
      settled = true
      resolveValue(value as T)
    },
  }
}

function argument(name: string) {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}
