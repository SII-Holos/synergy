#!/usr/bin/env bun

import { MessageV2 } from "../packages/synergy/src/session/message-v2"
import { SessionToolInput } from "../packages/synergy/src/session/tool-input"

type Memory = Pick<
  ReturnType<typeof process.memoryUsage>,
  "rss" | "heapUsed" | "heapTotal" | "external" | "arrayBuffers"
> & { footprint: number | null }
type Scenario = "history-projection" | "tool-stream"

const presets = {
  smoke: {
    turns: 8,
    toolOutputBytes: 16 * 1024,
    projectionCycles: 3,
    streamBytes: 4 * 1024 * 1024,
    streamChunkBytes: 64 * 1024,
  },
  standard: {
    turns: 32,
    toolOutputBytes: 64 * 1024,
    projectionCycles: 10,
    streamBytes: 32 * 1024 * 1024,
    streamChunkBytes: 256 * 1024,
  },
} as const

const presetName = argument("--preset") ?? "standard"
if (!(presetName in presets)) throw new Error(`Unknown preset: ${presetName}`)
const preset = presets[presetName as keyof typeof presets]
const worker = argument("--worker") as Scenario | undefined

if (worker) {
  const result = await runWorker(worker)
  console.log(JSON.stringify(result))
} else {
  const requested = argument("--scenario")
  const scenarios: Scenario[] = requested ? [validateScenario(requested)] : ["history-projection", "tool-stream"]
  const results = []
  for (const scenario of scenarios) results.push(await runIsolated(scenario))
  console.log(
    JSON.stringify(
      {
        schemaVersion: 1,
        harness: "synergy-session-memory",
        generatedAt: new Date().toISOString(),
        platform: process.platform,
        arch: process.arch,
        bunVersion: Bun.version,
        preset: presetName,
        results,
      },
      null,
      2,
    ),
  )
}

async function runIsolated(scenario: Scenario) {
  const child = Bun.spawn({
    cmd: [process.execPath, import.meta.path, "--worker", scenario, "--preset", presetName],
    env: process.env,
    stdout: "pipe",
    stderr: "inherit",
  })
  const output = await new Response(child.stdout).text()
  const exitCode = await child.exited
  if (exitCode !== 0) throw new Error(`${scenario} worker exited with ${exitCode}`)
  return JSON.parse(output.trim())
}

async function runWorker(scenario: Scenario) {
  await collect()
  const baseline = memory()
  const measured = scenario === "history-projection" ? await historyProjection() : await toolStream()
  await collect()
  const afterGC = memory()
  return {
    scenario,
    fixture: measured.fixture,
    checksum: measured.checksum,
    baseline,
    peak: measured.peak,
    afterGC,
    peakDelta: subtract(measured.peak, baseline),
    retainedDelta: subtract(afterGC, baseline),
    reclaimedAfterPeak: subtract(measured.peak, afterGC),
  }
}

async function historyProjection() {
  const messages = fixtureMessages(preset.turns, preset.toolOutputBytes)
  let peak = memory()
  let checksum = 0
  for (let cycle = 0; cycle < preset.projectionCycles; cycle++) {
    const projection = MessageV2.projectModelMessages(messages, { maxHistoryImages: 0 })
    const modelMessages = MessageV2.toModelMessage(messages)
    checksum += projection.messages.length + modelMessages.length
    peak = maximum(peak, memory())
    projection.messages.length = 0
    modelMessages.length = 0
  }
  messages.length = 0
  await Bun.sleep(0)
  return {
    peak,
    checksum,
    fixture: {
      turns: preset.turns,
      toolOutputBytes: preset.toolOutputBytes,
      projectionCycles: preset.projectionCycles,
    },
  }
}

async function toolStream() {
  const body = deterministicText(preset.streamBytes)
  let raw: string | undefined = `{"payload":"${body}"}`
  const encoded = new TextEncoder().encode(raw)
  const chunks: Uint8Array[] = []
  for (let offset = 0; offset < encoded.byteLength; offset += preset.streamChunkBytes) {
    chunks.push(encoded.slice(offset, Math.min(encoded.byteLength, offset + preset.streamChunkBytes)))
  }
  const decoder = new TextDecoder()
  let decoded = ""
  for (const chunk of chunks) decoded += decoder.decode(chunk, { stream: true })
  decoded += decoder.decode()
  const parsed = SessionToolInput.normalize(decoded)
  const checksum = typeof parsed?.payload === "string" ? parsed.payload.length : 0
  const peak = memory()
  chunks.length = 0
  raw = undefined
  decoded = ""
  await Bun.sleep(0)
  return {
    peak,
    checksum,
    fixture: { streamBytes: preset.streamBytes, streamChunkBytes: preset.streamChunkBytes },
  }
}

function fixtureMessages(turns: number, outputBytes: number): MessageV2.WithParts[] {
  const messages: MessageV2.WithParts[] = []
  for (let index = 0; index < turns; index++) {
    const userID = `msg_user_${index}`
    const assistantID = `msg_assistant_${index}`
    const sessionID = "ses_memory_benchmark"
    messages.push({
      info: {
        id: userID,
        sessionID,
        role: "user",
        time: { created: index * 2 },
        agent: "synergy",
        model: { providerID: "benchmark", modelID: "benchmark" },
      },
      parts: [
        {
          id: `part_user_${index}`,
          messageID: userID,
          sessionID,
          type: "text",
          text: `Inspect fixture turn ${index}`,
        },
      ],
    })
    messages.push({
      info: {
        id: assistantID,
        sessionID,
        role: "assistant",
        parentID: userID,
        rootID: userID,
        time: { created: index * 2 + 1, completed: index * 2 + 1 },
        agent: "synergy",
        mode: "synergy",
        modelID: "benchmark",
        providerID: "benchmark",
        path: { cwd: "/benchmark", root: "/benchmark" },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        finish: "tool-calls",
      },
      parts: [
        {
          id: `part_tool_${index}`,
          messageID: assistantID,
          sessionID,
          type: "tool",
          tool: "read",
          callID: `call_${index}`,
          state: {
            status: "completed",
            input: { filePath: `/benchmark/${index}.txt` },
            output: deterministicText(outputBytes),
            title: `fixture ${index}`,
            metadata: {},
            time: { start: index * 2 + 1, end: index * 2 + 1 },
          },
        },
      ],
    })
  }
  return messages
}

async function collect() {
  Bun.gc(true)
  await Bun.sleep(20)
  Bun.gc(true)
  await Bun.sleep(20)
}

function memory(): Memory {
  const value = process.memoryUsage()
  return {
    rss: value.rss,
    heapUsed: value.heapUsed,
    heapTotal: value.heapTotal,
    external: value.external,
    arrayBuffers: value.arrayBuffers,
    footprint: runtimeFootprint(),
  }
}

function maximum(a: Memory, b: Memory): Memory {
  return {
    rss: Math.max(a.rss, b.rss),
    heapUsed: Math.max(a.heapUsed, b.heapUsed),
    heapTotal: Math.max(a.heapTotal, b.heapTotal),
    external: Math.max(a.external, b.external),
    arrayBuffers: Math.max(a.arrayBuffers, b.arrayBuffers),
    footprint: a.footprint === null || b.footprint === null ? null : Math.max(a.footprint, b.footprint),
  }
}

function subtract(a: Memory, b: Memory): Memory {
  return {
    rss: a.rss - b.rss,
    heapUsed: a.heapUsed - b.heapUsed,
    heapTotal: a.heapTotal - b.heapTotal,
    external: a.external - b.external,
    arrayBuffers: a.arrayBuffers - b.arrayBuffers,
    footprint: a.footprint === null || b.footprint === null ? null : a.footprint - b.footprint,
  }
}

function runtimeFootprint() {
  const unsafe = (Bun as unknown as { unsafe?: { memoryFootprint?: () => number } }).unsafe
  if (typeof unsafe?.memoryFootprint !== "function") return null
  const value = unsafe.memoryFootprint()
  return Number.isFinite(value) && value >= 0 ? value : null
}

function deterministicText(bytes: number) {
  const pattern = "0123456789abcdef"
  return pattern.repeat(Math.ceil(bytes / pattern.length)).slice(0, bytes)
}

function argument(name: string) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function validateScenario(value: string): Scenario {
  if (value === "history-projection" || value === "tool-stream") return value
  throw new Error(`Unknown scenario: ${value}`)
}
