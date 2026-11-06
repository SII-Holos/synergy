const scenario = process.env.SYNERGY_TEST_STARTUP_SCENARIO
const pin = JSON.parse(process.env.SYNERGY_INSTALLATION_PIN!)
const frame = { synergyLauncher: "worker-ready", version: 1, runner: "__plugin-runtime-runner", pin }
let activations = 0
let activation: { generation: string; protocolVersion: number } | undefined
let pings = 0

function ready() {
  process.send?.({
    type: "ready",
    generation: scenario === "wrong-generation" ? "other" : activation?.generation,
    protocolVersion: scenario === "wrong-protocol" ? -1 : activation?.protocolVersion,
    handlerIds: scenario === "wrong-handlers" ? ["operation:undeclared"] : [],
  })
}

process.on("message", (message: { type: string; input?: typeof activation }) => {
  if (message.type === "activate") {
    activation = message.input
    activations++
    process.send?.({ type: "log", level: "info", message: `activations:${activations}` })
    if (scenario === "duplicate") {
      process.send?.(frame)
      process.send?.(frame)
    }
    if (scenario !== "controlled" && scenario !== "duplicate-timeout" && scenario !== "late-ready") ready()
  }
  if (message.type === "ping") {
    pings++
    if (pings === 1) {
      process.send?.(frame)
      process.send?.({ type: "log", level: "info", message: "frame-sent" })
    } else ready()
  }
  if (message.type === "shutdown") {
    if (scenario === "late" || scenario === "late-ready") {
      process.send?.(frame)
      ready()
    }
    if (scenario !== "ignore-shutdown") process.exit(0)
  }
})

process.send?.({
  type: "log",
  level: "info",
  message: `control:${process.env.SYNERGY_WORKER_CONTROL_VERSION ?? "none"}`,
})
if (scenario === "exit") process.exit(0)
if (scenario === "premature") {
  process.send?.({ type: "ready", protocolVersion: 9, generation: "startup-test", handlerIds: [] })
} else if (scenario === "wrong-pin") {
  process.send?.({ ...frame, pin: { ...pin, id: crypto.randomUUID() } })
} else if (scenario === "wrong-digest") {
  process.send?.({ ...frame, pin: { ...pin, sha256: "b".repeat(64) } })
} else if (scenario === "wrong-version") {
  process.send?.({ ...frame, version: 2 })
} else if (scenario === "wrong-runner") {
  process.send?.({ ...frame, runner: "__storage-worker-runner" })
} else if (scenario === "malformed") {
  process.send?.({ synergyLauncher: "worker-ready" })
} else if (scenario === "malformed-json") {
  process.send?.("{")
} else if (scenario === "wrong-discriminator") {
  process.send?.({ ...frame, synergyLauncher: "ready" })
} else if (
  ["duplicate", "duplicate-timeout", "late-ready", "wrong-protocol", "wrong-generation", "wrong-handlers"].includes(
    scenario!,
  )
) {
  process.send?.(frame)
}
