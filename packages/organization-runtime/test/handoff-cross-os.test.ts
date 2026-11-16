import assert from "node:assert/strict"
import { test } from "bun:test"
import { dns } from "bun"
import fs from "node:fs/promises"
import path from "node:path"
import { createHash } from "node:crypto"
import { z } from "zod"
import { createOrganizationClient } from "@ericsanchezok/synergy-sdk/organization"
import { openOrganizationService } from "@ericsanchezok/synergy-organization/service"
import {
  OrganizationProtocol,
  OrganizationCommandProtocol as Command,
  OrganizationHandoffProtocol as Handoff,
  OrganizationResourceProtocol as Resource,
  OrganizationRuntimeProtocol as Runtime,
} from "@ericsanchezok/synergy-organization-protocol"
import { Action, Task, Outcome, InitialBytes, LinuxBytes, createPeer, json } from "./support/cross-os-peer"
import { createHandoffCompletion } from "./support/handoff-completion"
import {
  observeDNSAfterFailedHealth,
  observeTemporaryName,
  observeDNSAfterFirstHeaderFailure,
} from "./support/cross-os-dns"
import { observeCrossOSResolverRoute } from "./support/cross-os-resolver-route"
import { startCrossOSPostFailureHTTP } from "./support/cross-os-post-failure-http"
import {
  createCrossOSTunnelObservation,
  readCrossOSTunnelStderr,
  type CrossOSCleanupOwner,
} from "./support/cross-os-tunnel"
import {
  safeCrossOSTransportText as safeTransportText,
  safeCrossOSHeaderFailure,
  recordCrossOSHeaderFailure,
  isOriginalHeaderTimeout,
  type HeaderFailureSample,
  type HeaderFailureKindSample,
} from "./support/cross-os-failures"
import {
  Bootstrap,
  PublicOrigin,
  PublicPeer,
  readPublicPeerHealth,
  acceptPeerHealth,
  decode,
  encode,
  equalRun,
  readControlJSON,
  exchange,
  identity,
  run,
  state,
  waitArtifact,
  safeCrossOSFailure as safeFailure,
} from "./support/cross-os-transport"

const role = process.env.SYNERGY_CROSS_OS_ROLE
const tunnelObservation = createCrossOSTunnelObservation()

const dnsCacheKeys = ["cacheHitsCompleted", "cacheHitsInflight", "cacheMisses", "size", "errors", "totalCount"] as const
type DNSCacheCounters = Pick<ReturnType<typeof dns.getCacheStats>, (typeof dnsCacheKeys)[number]>
type DNSCacheObservation = { available: false } | { available: true; counters: DNSCacheCounters }

// Provenance: https://github.com/oven-sh/bun/blob/c6da4a4d3010e5553438c60f6bd76d981976867c/packages/bun-types/bun.d.ts#L2621-L2631
// Local adaptation: retain only the fixed numeric public counters; observation never requests a lookup.
function observeDNSCache(): DNSCacheObservation {
  try {
    const value = dns.getCacheStats()
    const entries = dnsCacheKeys.map((key) => [key, value[key]] as const)
    if (entries.some(([, count]) => !Number.isSafeInteger(count) || count < 0)) return { available: false }
    return { available: true, counters: Object.fromEntries(entries) as DNSCacheCounters }
  } catch {
    return { available: false }
  }
}
function dnsCacheDelta(before: DNSCacheObservation | undefined, after: DNSCacheObservation): DNSCacheObservation {
  try {
    if (before?.available && after.available)
      return {
        available: true,
        counters: Object.fromEntries(
          dnsCacheKeys.map((key) => [key, after.counters[key] - before.counters[key]]),
        ) as DNSCacheCounters,
      }
  } catch {}
  return { available: false }
}

const transportFacts = {
  stderrLines: 0,
  firstDiagnosticStderr: [] as string[],
  registrationEvents: 0,
  firstRegistrationMs: -1,
  lastRegistrationMs: -1,
  exitCode: undefined as number | undefined,
  stderrCategories: {
    edgeConnect: 0,
    edgeRegister: 0,
    edgeLost: 0,
    edgeServe: 0,
    originReach: 0,
    originTLS: 0,
    requestEnded: 0,
    otherError: 0,
  },
  health: {
    dnsCache: {
      before: undefined as DNSCacheObservation | undefined,
      final: undefined as DNSCacheObservation | undefined,
      delta: undefined as DNSCacheObservation | undefined,
    },
    attempts: 0,
    originalENOTFOUND: 0,
    firstFailureDNSError: undefined as "OBSERVATION_ERROR" | undefined,
    firstFailureDNS: undefined as Awaited<ReturnType<typeof observeDNSAfterFirstHeaderFailure>["result"]> | undefined,
    firstFailureDNSCleanup: undefined as
      Awaited<ReturnType<ReturnType<typeof observeDNSAfterFirstHeaderFailure>["close"]>> | undefined,
    passiveResolverRoute: undefined as ReturnType<typeof observeCrossOSResolverRoute> | undefined,
    temporaryNameHint: undefined as Awaited<ReturnType<typeof observeTemporaryName>["result"]> | undefined,
    temporaryNameCleanup: undefined as
      Awaited<ReturnType<ReturnType<typeof observeTemporaryName>["close"]>> | undefined,
    afterFailureDNS: undefined as Awaited<ReturnType<typeof observeDNSAfterFailedHealth>>,
    afterFailureHTTP: undefined as Awaited<ReturnType<typeof startCrossOSPostFailureHTTP>["result"]> | undefined,
    headerResponses: 0,
    headerFailures: 0,
    headerTimeouts: 0,
    budgetAborts: 0,
    nonOKResponses: 0,
    originHandled: 0,
    lastHeaderFailure: undefined as ReturnType<typeof safeFailure> | undefined,
    firstHeaderFailures: [] as HeaderFailureSample<DNSCacheObservation>[],
    firstFailureKinds: [] as HeaderFailureKindSample<DNSCacheObservation>[],
    failureKinds: {} as Record<string, number>,
  },
}
// Provenance: https://github.com/cloudflare/cloudflared/blob/2026.11.0/connection/observer.go
// Local adaptation: Count registration events and bounded failure categories without treating a printed URL as readiness.
function observeTunnelStderr(line: string) {
  transportFacts.stderrLines++
  if (line.includes("Registered tunnel connection")) {
    transportFacts.registrationEvents++
    if (transportFacts.firstRegistrationMs < 0) transportFacts.firstRegistrationMs = performance.now()
    transportFacts.lastRegistrationMs = performance.now()
  }
  const categories = transportFacts.stderrCategories
  let classified = false
  for (const [category, matches] of [
    ["edgeConnect", line.includes("Unable to establish connection with Cloudflare edge")],
    ["edgeRegister", line.includes("Register tunnel error from server side")],
    ["edgeLost", line.includes("Lost connection with the edge")],
    ["edgeServe", line.includes("Serve tunnel error")],
    ["originReach", line.includes("Unable to reach the origin service")],
    ["originTLS", /x509:|tls:|TLS handshake timeout/.test(line)],
    ["requestEnded", line.includes("Incoming request ended abruptly")],
  ] as const) {
    if (!matches) continue
    categories[category]++
    classified = true
  }
  if (!classified && /(?:^|\s)ERR(?:\s|$)/.test(line)) categories.otherError++
  if ((classified || /(?:^|\s)(?:ERR|WRN)(?:\s|$)/.test(line)) && transportFacts.firstDiagnosticStderr.length < 4)
    transportFacts.firstDiagnosticStderr.push(safeTransportText(line))
}
function transportSnapshot() {
  return {
    stderrLines: transportFacts.stderrLines,
    lifecycle: tunnelObservation.snapshot(),
    firstDiagnosticStderr: [...transportFacts.firstDiagnosticStderr],
    registrationEvents: transportFacts.registrationEvents,
    firstRegistrationMs: transportFacts.firstRegistrationMs,
    lastRegistrationMs: transportFacts.lastRegistrationMs,
    ...(transportFacts.exitCode === undefined ? {} : { exitCode: transportFacts.exitCode }),
    stderrCategories: { ...transportFacts.stderrCategories },
    health: {
      ...transportFacts.health,
      dnsCache: { ...transportFacts.health.dnsCache },
      firstHeaderFailures: [...transportFacts.health.firstHeaderFailures],
      firstFailureKinds: [...transportFacts.health.firstFailureKinds],
      failureKinds: { ...transportFacts.health.failureKinds },
    },
    environmentPresence: Object.fromEntries(
      [
        "HTTP_PROXY",
        "http_proxy",
        "HTTPS_PROXY",
        "https_proxy",
        "ALL_PROXY",
        "all_proxy",
        "NO_PROXY",
        "no_proxy",
        "NODE_EXTRA_CA_CERTS",
        "SSL_CERT_FILE",
        "SSL_CERT_DIR",
        "NODE_TLS_REJECT_UNAUTHORIZED",
      ].map((key) => [key, Object.hasOwn(process.env, key)]),
    ),
  }
}
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex")
const fileHash = (value: Uint8Array) => createHash("sha256").update(value).digest("hex")
const Json = z.json()
const NativeObservation = z.object({
  platform: z.enum(["darwin", "linux"]),
  architecture: z.string(),
  uname: z.string(),
  native: Handoff.NativeEnvironmentSelection.omit({ kind: true }).extend({
    state: z.enum(["idle", "ready"]),
  }),
  sessionID: z.string(),
  organization: z.object({
    bindingEpoch: z.number(),
    driverRuntimeID: z.string(),
  }),
  paused: z.object({ since: z.number() }).nullable(),
  controlVersion: z.number(),
  workspaceID: z.string(),
  directoryIsOriginal: z.boolean(),
  files: z.object({
    current: z.string(),
    binary: z.string(),
    ignored: z.string(),
    unicode: z.string(),
    mode: z.number(),
    link: z.string(),
    historicalPresent: z.boolean(),
  }),
  original: z.object({ current: z.string(), binary: z.string() }),
  messages: z.array(
    z.object({
      info: z.object({ id: z.string(), sessionID: z.string() }).passthrough(),
      parts: z.array(Json),
    }),
  ),
})
const HistoricalWorkspacePart = z
  .object({
    type: z.enum(["patch", "snapshot", "step-start", "step-finish"]),
    workspace: z.object({ id: z.string() }).passthrough(),
  })
  .passthrough()
function assertHistory(source: z.infer<typeof NativeObservation>, target: z.infer<typeof NativeObservation>) {
  let workspaceReferences = 0
  const expected = source.messages.map((message) => ({
    ...message,
    parts: message.parts.map((part) => {
      const historical = HistoricalWorkspacePart.safeParse(part)
      if (!historical.success) return part
      assert.equal(historical.data.workspace.id, source.workspaceID)
      workspaceReferences++
      return {
        ...historical.data,
        workspace: { ...historical.data.workspace, id: target.workspaceID },
      }
    }),
  }))
  assert.ok(workspaceReferences > 0, "The actual Snapshot history must retain its Workspace references")
  assert.deepEqual(target.messages, expected)
}
const Execution = z.object({
  platform: z.enum(["darwin", "linux"]),
  architecture: z.string(),
  executionID: z.string(),
  state: z.literal("completed"),
  snapshot: z.string(),
  outputHash: z.string(),
})

async function until<T>(read: () => Promise<T | undefined>, budget: number, message: string) {
  const deadline = Date.now() + budget
  while (Date.now() < deadline) {
    const value = await read()
    if (value !== undefined) return value
    await Bun.sleep(25)
  }
  throw new Error(message)
}
// Provenance: https://developers.cloudflare.com/tunnel/reference/origin-parameters/
// Local adaptation: The temporary test edge still verifies its private origin CA.
async function tunnel(directory: string, port: number) {
  const cert = path.join(directory, "origin-cert.pem"),
    key = path.join(directory, "origin-key.pem")
  await setup(
    "darwin-origin-certificate-exit",
    async () => {
      const generated = Bun.spawn(
        [
          "openssl",
          "req",
          "-x509",
          "-newkey",
          "rsa:2048",
          "-nodes",
          "-days",
          "1",
          "-subj",
          "/CN=localhost",
          "-addext",
          "subjectAltName=DNS:localhost,IP:127.0.0.1",
          "-keyout",
          key,
          "-out",
          cert,
        ],
        { stdout: "ignore", stderr: "pipe" },
      )
      const exitCode = await generated.exited
      if (exitCode !== 0)
        throw Object.assign(new Error("The task origin certificate could not be generated"), {
          code: "ORIGIN_CERTIFICATE_FAILED",
          exitCode,
        })
      return exitCode
    },
    (exitCode) => ({ exitCode }),
  )
  await setup("darwin-origin-key-mode", () => fs.chmod(key, 0o600))
  const child = await setup("darwin-cloudflared-launch", async () =>
    Bun.spawn(
      [
        path.join(state(), "cloudflared"),
        "tunnel",
        "--no-autoupdate",
        "--protocol",
        "http2",
        "--url",
        `https://127.0.0.1:${port}`,
        "--origin-server-name",
        "localhost",
        "--origin-ca-pool",
        cert,
        "--metrics",
        "127.0.0.1:0",
      ],
      {
        stdout: "ignore",
        stderr: "pipe",
        env: Object.fromEntries(
          Object.entries(process.env).filter(([key]) => key !== "GITHUB_TOKEN" && key !== "GH_TOKEN"),
        ),
      },
    ),
  )
  tunnelObservation.launched()
  void child.exited.then((code) => {
    transportFacts.exitCode = code
    tunnelObservation.exited(code)
  })
  const ready = Promise.withResolvers<string>()
  const reader = readCrossOSTunnelStderr(child.stderr, {
    line(value) {
      observeTunnelStderr(value)
      tunnelObservation.line(value)
    },
    ready,
    selected: tunnelObservation.selected,
    eof: tunnelObservation.eof,
    settled: tunnelObservation.settled,
  })
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    timer = setTimeout(
      () => ready.reject(new Error("The task-owned tunnel did not initialize within 120 seconds")),
      120000,
    )
    const origin = await setup("darwin-cloudflared-ready", () => ready.promise)
    return {
      origin,
      cert: await Bun.file(cert).text(),
      key: await Bun.file(key).text(),
      async close() {
        child.kill("SIGTERM")
        await child.exited
        await reader
      },
    }
  } catch (error) {
    child.kill("SIGTERM")
    await child.exited
    await reader
    throw error
  } finally {
    clearTimeout(timer)
  }
}

let setupStage: string | undefined
let setupHTTPStatus: number | undefined
async function setupReport(
  phase: string,
  status: "pending" | "completed" | "failed",
  started: number,
  error?: unknown,
  metadata?: { exitCode: number },
) {
  return fs.writeFile(
    path.join(state(), "report.json"),
    JSON.stringify({
      version: 1,
      run: run(),
      passed: false,
      phase,
      status,
      ...metadata,
      elapsedMs: performance.now() - started,
      ...(setupHTTPStatus === undefined ? {} : { httpStatus: setupHTTPStatus }),
      ...(error === undefined ? {} : { errors: [safeFailure(error)] }),
      ...(role === "darwin" ? { transport: transportSnapshot() } : {}),
    }),
  )
}
async function setupHTTP(phase: string, started: number, response?: Response) {
  setupStage = phase
  setupHTTPStatus = response?.status
  await setupReport(phase, "pending", started)
}
async function setup<T>(
  phase: string,
  action: () => Promise<T>,
  completed?: (value: T) => { exitCode: number },
): Promise<T> {
  const started = performance.now()
  setupStage = phase
  setupHTTPStatus = undefined
  const report = (status: "pending" | "completed" | "failed", error?: unknown, metadata?: { exitCode: number }) =>
    setupReport(status === "failed" ? (setupStage ?? phase) : phase, status, started, error, metadata)
  await report("pending")
  try {
    const value = await action()
    setupStage = phase
    await report("completed", undefined, completed?.(value))
    return value
  } catch (error) {
    try {
      await report("failed", error)
    } catch (diagnostic) {
      throw new AggregateError([error, diagnostic], "Cross-OS setup and its safe diagnostic both failed")
    }
    throw error
  }
}

async function host() {
  assert.equal(process.platform, "darwin")
  const bootstrapSignal = AbortSignal.timeout(Math.max(0, Math.ceil(120000 - process.uptime() * 1000)))
  const secret = await setup("darwin-identity", identity)
  const rendezvousStarted = performance.now()
  const linuxPublic = await setup("darwin-public-peer-rendezvous", async () =>
    PublicPeer.parse(await waitArtifact("linux", "public", bootstrapSignal)),
  )
  const artifactWaitMs = performance.now() - rendezvousStarted
  const root = await setup("darwin-temporary-root", () =>
    fs.mkdtemp(path.join(process.env.SYNERGY_TEST_ROOT!, "cross-os-host-")),
  )
  const probe = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(),
  })
  const port = probe.port!
  await probe.stop(true)
  const tunnelStarted = performance.now()
  const connection = await setup("darwin-tunnel-bootstrap", () => tunnel(root, port))
  const capturedHostname = new URL(connection.origin).hostname
  let temporaryNameHint: ReturnType<typeof observeTemporaryName> | undefined
  let firstHeaderDNS: ReturnType<typeof observeDNSAfterFirstHeaderFailure> | undefined
  let failedPublicHealth = false
  const cleanups: Array<{ owner: CrossOSCleanupOwner; close(): Promise<unknown> }> = [
    { owner: "tunnel", close: () => connection.close() },
  ]
  const costs: Record<string, number> = {
    artifactWaitMs,
    tunnelBootstrapMs: performance.now() - tunnelStarted,
  }
  const handoffDenials = [
    ["Handoff machine plan is invalid for this connection", "native-machine-plan"],
    ["Handoff inspection does not match this finite connection", "native-inspection-plan"],
    ["Resource proof is outside its validity window", "native-resource-window"],
    ["Handoff object request is outside its finite authorization window", "object-window"],
    ["Handoff object request belongs to another source or destination", "object-binding"],
    ["Handoff destination signature is invalid", "object-target-signature"],
    ["Handoff source identity changed", "object-source-identity"],
    ["This account cannot drive this handoff participant", "service-participant-actor"],
    ["Handoff read authority changed while its original response was pending", "service-read-authority"],
    ["Handoff machine identity changed", "service-machine-identity"],
    ["Handoff machine is unavailable", "service-machine-unavailable"],
    ["Handoff machine plan belongs to another or expired signing authority", "service-plan-signing"],
    ["Runtime is not authorized", "service-runtime-authority"],
    ["Runtime account is not active", "service-runtime-account"],
    ["This action is not allowed", "service-action-denied"],
  ] as const
  const handoffDenialReasons = new Map<string, (typeof handoffDenials)[number][1]>(handoffDenials)
  function handoffDenialReason(error: unknown) {
    try {
      if (typeof error !== "object" || error === null) return "unknown"
      const fields = Object.getOwnPropertyDescriptors(error)
      const canonical = OrganizationProtocol.Error.safeParse({
        code: fields.code?.value,
        message: fields.message?.value,
        outcome: fields.outcome?.value,
        retryable: fields.retryable?.value,
      })
      return canonical.success && canonical.data.code === "PERMISSION_DENIED"
        ? (handoffDenialReasons.get(canonical.data.message) ?? "unknown")
        : "unknown"
    } catch {
      return "unknown"
    }
  }
  const requests: Array<{
    phase: string
    operation: string
    driveOperation?: Handoff.Drive["operation"]
    denialReason?: ReturnType<typeof handoffDenialReason>
    machine?: Pick<Handoff.MachineResult, "state" | "stage"> & { factsCount: number }
    elapsedMs: number
    status?: number
    content?: string
    failure?: ReturnType<typeof safeFailure>
  }> = []
  const requestFailures: typeof requests = []
  let phase = "service-bootstrap"
  let started = performance.now()
  let targetPreparationFailures: Awaited<ReturnType<typeof createPeer>>["targetPreparationFailures"] = () => []
  try {
    const service = await setup("darwin-service-bootstrap", () =>
      openOrganizationService({
        home: path.join(root, "service"),
        publicOrigin: connection.origin,
        connections: { heartbeatMs: 100, offlineMs: 5000 },
      }),
    )
    cleanups.push({ owner: "service", close: () => service.close() })
    const nonces = new Set<string>(),
      connected = new Map<string, number>(),
      sockets = new Map<unknown, string>()
    const pending: Array<z.infer<typeof Task>> = []
    const replies = new Map<string, ReturnType<typeof Promise.withResolvers<z.infer<typeof Outcome>>>>()
    const linuxReady = Promise.withResolvers<string>()
    let headers: { cookie: string; "x-csrf-token": string } | undefined
    let account: { orgID: string; accountID: string } | undefined
    let bootstrapRequest: "bootstrap" | "login" | undefined
    let activeDrive:
      | {
          operation: Handoff.Drive["operation"]
          record?: (typeof requests)[number]
        }
      | undefined
    function requestOperation(input: Parameters<typeof fetch>[0]) {
      try {
        const pathname = new URL(input instanceof Request ? input.url : String(input)).pathname
        if (/^\/org\/v1\/sessions\/[^/]+\/handoff-options$/.test(pathname)) return "handoff-options"
        if (/^\/org\/v1\/sessions\/[^/]+\/handoffs$/.test(pathname)) return "handoff-prepare"
        const match = pathname.match(/^\/org\/v1\/handoffs\/[^/]+(?:\/(accept|commit|permit|drive))?$/)
        return match ? "handoff-" + (match[1] ?? "get") : undefined
      } catch {
        return undefined
      }
    }
    function recordRequest(value: (typeof requests)[number]) {
      requests.push(value)
      if (requests.length > 16) requests.shift()
      if ((value.failure || (value.status !== undefined && value.status >= 400)) && requestFailures.length < 4)
        requestFailures.push(value)
      return value
    }
    const client = createOrganizationClient({
      baseUrl: connection.origin,
      headers: { origin: connection.origin },
      fetch: Object.assign(
        async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
          const bootstrapPhase = bootstrapRequest
          const operation = requestOperation(input)
          const driveObservation = operation === "handoff-drive" ? activeDrive : undefined
          const driveOperation = driveObservation?.operation
          const requestPhase = phase
          const requestStarted = performance.now()
          try {
            if (bootstrapPhase) await setupHTTP(`darwin-${bootstrapPhase}-headers`, requestStarted)
            const response = await fetch(input, init)
            if (operation) {
              const contentType = response.headers.get("content-type") ?? ""
              const record = recordRequest({
                phase: requestPhase,
                operation,
                ...(driveOperation ? { driveOperation } : {}),
                elapsedMs: performance.now() - requestStarted,
                status: response.status,
                content: contentType.includes("json") ? "json" : contentType.includes("html") ? "html" : "other",
              })
              if (driveObservation) driveObservation.record = record
            }
            if (bootstrapPhase) await setupHTTP(`darwin-${bootstrapPhase}-body`, requestStarted, response)
            return response
          } catch (error) {
            if (operation) {
              const record = recordRequest({
                phase: requestPhase,
                operation,
                ...(driveOperation ? { driveOperation } : {}),
                elapsedMs: performance.now() - requestStarted,
                failure: safeFailure(error),
              })
              if (driveObservation) driveObservation.record = record
            }
            throw error
          }
        },
        { preconnect() {} },
      ),
    })
    let hello: { publicKey: string; ticket: z.infer<typeof Runtime.Ticket> } | undefined
    let linuxRuntimeID: string | undefined
    async function control(request: Request) {
      if (request.method !== "POST") return new Response(null, { status: 400 })
      try {
        const input = decode(secret, linuxPublic, await readControlJSON(request), nonces)
        let value: z.infer<typeof Json> = null
        if (input.action === "hello") {
          const selected = z.strictObject({ publicKey: z.string().min(32).max(8192) }).parse(input.value)
          if (!headers || !account) throw new Error("The actual Service has not bootstrapped")
          if (hello && hello.publicKey !== selected.publicKey) throw new Error("The Linux product key changed")
          hello ??= {
            publicKey: selected.publicKey,
            ticket: (
              await client.orgRuntime.registerMember(
                {
                  orgMemberRuntimeRegistration: {
                    deviceID: "cross-os-linux",
                    publicKey: selected.publicKey,
                  },
                },
                { headers, throwOnError: true },
              )
            ).data,
          }
          value = json(hello.ticket)
        } else if (input.action === "ready") {
          const selected = z
            .strictObject({
              runtimeID: z.string(),
              platform: z.literal("linux"),
            })
            .parse(input.value)
          assert.equal(selected.runtimeID, hello?.ticket.runtime.runtimeID)
          linuxRuntimeID = selected.runtimeID
          linuxReady.resolve(selected.runtimeID)
        } else if (input.action === "next") value = json(pending.shift() ?? null)
        else if (input.action === "result") {
          const answer = Outcome.parse(input.value)
          const accepted = replies.get(answer.id)
          if (!accepted) throw new Error("The peer returned an unknown fixture operation")
          replies.delete(answer.id)
          accepted.resolve(answer)
        } else throw new Error("The cross-OS endpoint accepts only its finite fixture protocol")
        return Response.json(encode(secret, linuxPublic, input.action, value))
      } catch {
        return new Response(null, { status: 400 })
      }
    }
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port,
      tls: { cert: connection.cert, key: connection.key },
      websocket: {
        ...service.websocket,
        async message(socket, raw) {
          await service.websocket.message(socket, raw)
          const frame = Runtime.ClientFrame.parse(JSON.parse(String(raw)))
          if (frame.type === "handshake") sockets.set(socket, frame.proof.handshake.runtimeID)
          if (frame.type === "heartbeat") {
            const id = sockets.get(socket)
            if (id) connected.set(id, Date.now())
          }
        },
        async close(socket, code, reason) {
          const id = sockets.get(socket)
          if (id) connected.delete(id)
          sockets.delete(socket)
          await service.websocket.close?.(socket, code, reason)
        },
      },
      fetch(request, server) {
        const url = new URL(request.url)
        if (url.pathname === "/__cross-os-health") {
          transportFacts.health.originHandled++
          return Response.json({ run: run(), native: process.platform })
        }
        if (url.pathname === "/__cross-os-control") return control(request)
        return service.fetch(request, server)
      },
    })
    tunnelObservation.listener(server.port, port)
    cleanups.splice(1, 0, { owner: "origin-listener", close: () => server.stop(false) })
    const publicOrigin = PublicOrigin.parse({ ...secret.public, role: "darwin", origin: connection.origin })
    await setup("darwin-public-origin-publication", () =>
      fs.writeFile(path.join(state(), "origin.json"), JSON.stringify(publicOrigin), {
        mode: 0o600,
        flag: "wx",
        signal: bootstrapSignal,
      }),
    )
    await setup("darwin-linux-health-rendezvous", async () => {
      const receipt = await waitArtifact("linux", "health", bootstrapSignal)
      acceptPeerHealth(secret, linuxPublic, connection.origin, receipt, nonces)
      bootstrapSignal.throwIfAborted()
    })
    temporaryNameHint = observeTemporaryName(capturedHostname, bootstrapSignal)
    transportFacts.health.temporaryNameHint = await temporaryNameHint.result
    transportFacts.health.dnsCache.before = observeDNSCache()
    await setup("darwin-public-health", () =>
      until(
        async () => {
          const requestStarted = performance.now()
          let headersReceived = false
          let fetchInvoked = false
          let requestTimeout: AbortSignal | undefined
          try {
            bootstrapSignal.throwIfAborted()
            await setupHTTP("darwin-public-health-headers", requestStarted)
            transportFacts.health.attempts++
            fetchInvoked = true
            requestTimeout = AbortSignal.timeout(5000)
            const response = await fetch(connection.origin + "/__cross-os-health", {
              signal: AbortSignal.any([bootstrapSignal, requestTimeout]),
            })
            headersReceived = true
            transportFacts.health.headerResponses++
            await setupHTTP("darwin-public-health-body", requestStarted, response)
            if (!response.ok) {
              transportFacts.health.nonOKResponses++
              await response.body?.cancel()
              return
            }
            const value = z.object({ run: z.unknown(), native: z.literal("darwin") }).parse(await response.json())
            equalRun(run())
            assert.deepEqual(value.run, run())
            return true
          } catch (error) {
            let firstDNSTrigger: { attempt: number; observedAtMs: number } | undefined
            if (!headersReceived) {
              transportFacts.health.headerFailures++
              transportFacts.health.lastHeaderFailure = safeFailure(error)
              const failure = safeCrossOSHeaderFailure(error, capturedHostname)
              if (
                fetchInvoked &&
                [failure.code, failure.cause?.code, failure.cause?.cause?.code].includes("ENOTFOUND")
              ) {
                transportFacts.health.originalENOTFOUND++
                if (!firstHeaderDNS) {
                  firstDNSTrigger = { attempt: transportFacts.health.attempts, observedAtMs: performance.now() }
                }
              }
              recordCrossOSHeaderFailure(transportFacts.health, failure, () => ({
                attempt: fetchInvoked ? transportFacts.health.attempts : null,
                observedAtMs: performance.now(),
                elapsedBeforeFailureMs: performance.now() - requestStarted,
                fetchInvoked,
                dnsCache: observeDNSCache(),
              }))
              if (isOriginalHeaderTimeout(error, failure, [bootstrapSignal, requestTimeout]))
                transportFacts.health.headerTimeouts++
              if (bootstrapSignal.aborted) transportFacts.health.budgetAborts++
            }
            if (bootstrapSignal.aborted) throw error
            if (firstDNSTrigger && !firstHeaderDNS) {
              firstHeaderDNS = observeDNSAfterFirstHeaderFailure(connection.origin, firstDNSTrigger, bootstrapSignal)
              void firstHeaderDNS.result.then(
                (facts) => {
                  transportFacts.health.firstFailureDNS = facts
                },
                () => {
                  transportFacts.health.firstFailureDNSError = "OBSERVATION_ERROR"
                },
              )
            }
            await setupReport("darwin-public-health-retry", "pending", requestStarted, error)
            return
          }
        },
        120000,
        "The task TLS tunnel did not reach its actual native origin",
      ).finally(() => {
        const final = observeDNSCache()
        transportFacts.health.dnsCache.final = final
        transportFacts.health.dnsCache.delta = dnsCacheDelta(transportFacts.health.dnsCache.before, final)
      }),
    ).catch((error: unknown) => {
      failedPublicHealth = true
      throw error
    })
    const setupToken = await setup("darwin-bootstrap-token", async () => {
      bootstrapSignal.throwIfAborted()
      const token = await service.bootstrapToken()
      bootstrapSignal.throwIfAborted()
      return token
    })
    const password = "synthetic-" + crypto.randomUUID()
    account = (
      await setup("darwin-setup-bootstrap", async () => {
        bootstrapRequest = "bootstrap"
        try {
          return await client.orgSetup.bootstrap(
            {
              orgBootstrapInput: {
                token: setupToken,
                requestID: crypto.randomUUID(),
                organizationName: "Cross-OS synthetic acceptance",
                loginName: "cross-os-owner",
                displayName: "Synthetic Owner",
                password,
              },
            },
            { throwOnError: true, signal: bootstrapSignal },
          )
        } finally {
          bootstrapRequest = undefined
        }
      })
    ).data
    const login = await setup("darwin-setup-login", async () => {
      bootstrapRequest = "login"
      try {
        return await client.orgAuth.login(
          { orgLoginInput: { loginName: "cross-os-owner", password } },
          { throwOnError: true, signal: bootstrapSignal },
        )
      } finally {
        bootstrapRequest = undefined
      }
    })
    headers = {
      cookie: login.response.headers.get("set-cookie")!.split(";")[0]!,
      "x-csrf-token": login.data.csrfToken,
    }
    const options = { headers, throwOnError: true as const }
    const bootstrap = Bootstrap.parse({
      ...secret.public,
      role: "darwin",
      origin: connection.origin,
      identity: { orgID: account.orgID, accountID: account.accountID },
    })
    await setup("darwin-bootstrap-publication", () =>
      fs.writeFile(path.join(state(), "bootstrap.json"), JSON.stringify(bootstrap), {
        mode: 0o600,
        flag: "wx",
        signal: bootstrapSignal,
      }),
    )
    const darwin = await createPeer({
      root: path.join(root, "darwin"),
      origin: connection.origin,
      identity: { ...bootstrap.identity, deviceID: "cross-os-darwin" },
      async ticket(publicKey) {
        return (
          await client.orgRuntime.registerMember(
            {
              orgMemberRuntimeRegistration: {
                deviceID: "cross-os-darwin",
                publicKey,
              },
            },
            options,
          )
        ).data
      },
    })
    targetPreparationFailures = darwin.targetPreparationFailures
    cleanups.push({ owner: "darwin-peer", close: () => darwin.close() })
    const linuxID = await until(
      async () => linuxRuntimeID,
      120000,
      "The Linux runner did not enroll its actual native Runtime",
    )
    assert.equal(await linuxReady.promise, linuxID)
    await until(
      async () =>
        [linuxID, darwin.registration.runtimeID].every((id) => Date.now() - (connected.get(id) ?? 0) < 1000)
          ? true
          : undefined,
      10000,
      "Both real enrolled peers must heartbeat concurrently before Handoff",
    )
    costs.bootstrapMs = performance.now() - started
    async function linux(action: Action) {
      const id = crypto.randomUUID(),
        wait = Promise.withResolvers<z.infer<typeof Outcome>>()
      replies.set(id, wait)
      pending.push(Task.parse({ id, action }))
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        timer = setTimeout(
          () => wait.reject(new Error("The original Linux fixture operation did not return: " + action.kind)),
          30000,
        )
        const answer = await wait.promise
        if (!answer.ok) throw new Error("Linux fixture failed: " + answer.name + ": " + answer.message)
        return answer.value
      } finally {
        clearTimeout(timer)
        replies.delete(id)
      }
    }
    const project = (
      await client.orgProjects.create({ orgProjectCreate: { name: "Darwin Linux actual peers" } }, options)
    ).data
    await darwin.dispatch({ kind: "bind", projectID: project.projectID })
    const model = (
      await client.orgResources.create(
        {
          orgResourceCreate: {
            name: "Synthetic manual-tool model contract",
            scope: { kind: "project", projectID: project.projectID },
            configuration: {
              protocol: "openai-compatible",
              endpoint: "https://provider.invalid/v1",
              model: Resource.Model.parse({
                id: "cross-os-manual",
                name: "Manual tool fixture",
                limit: { context: 8192, output: 1024 },
              }),
            },
            credential: { kind: "none" },
          },
        },
        options,
      )
    ).data
    await client.orgResourceGrants.set(
      {
        resourceID: model.resourceID,
        kind: "account",
        subjectID: account.accountID,
        orgResourceGrantChange: { expectedRevision: 0, enabled: true },
      },
      options,
    )
    const created = (
      await client.orgSessions.create(
        {
          orgCommandCreateRequest: {
            schemaVersion: 1,
            orgID: account.orgID,
            projectID: project.projectID,
            runtimeID: darwin.registration.runtimeID,
            requestID: "cross-os-create",
            creation: {
              operation: "create",
              title: "The same native Session across two operating systems",
            },
          },
        },
        options,
      )
    ).data
    const sessionID = created.effect.sessionID
    await client.orgSessionResources.set(
      {
        sessionID,
        orgSessionResourceChange: {
          expectedRevision: 0,
          selection: {
            modelResourceID: model.resourceID,
            connectionResourceIDs: [],
            infrastructure: { workspace: null, environment: null },
          },
        },
      },
      options,
    )
    const accepted = Command.InputAccepted.parse(
      (
        await client.orgCommands.input(
          {
            sessionID,
            orgCommandInputRequest: {
              schemaVersion: 1,
              orgID: account.orgID,
              projectID: project.projectID,
              sessionID,
              runtimeID: darwin.registration.runtimeID,
              requestID: "cross-os-task",
              input: {
                operation: "input",
                mode: "task",
                parts: [
                  {
                    type: "text",
                    text: "Retain this original actor and history across the native directory roundtrip",
                  },
                ],
              },
            },
          },
          options,
        )
      ).data,
    )
    await darwin.dispatch({
      kind: "attach",
      sessionID,
      accepted,
      initial: true,
    })
    phase = "darwin-original-tool"
    started = performance.now()
    const first = Execution.parse(await darwin.dispatch({ kind: "execute", phase: "darwin-first" }))
    assert.equal(first.platform, "darwin")
    const original = NativeObservation.parse(await darwin.dispatch({ kind: "observe" }))
    assert.equal(original.uname, "Darwin")
    assert.equal(original.files.historicalPresent, false)
    assert.equal(original.files.current, "dirty Darwin bytes\n")
    costs.initialNativeMs = performance.now() - started
    async function move(sourceID: string, targetID: string, handoffID: string) {
      assert.ok(
        [sourceID, targetID].every((id) => Date.now() - (connected.get(id) ?? 0) < 1000),
        "Both actual OS peers must still heartbeat before each transfer",
      )
      const preview = Handoff.Options.parse(
        (
          await client.orgHandoff.options(
            {
              sessionID,
              targetRuntimeID: targetID,
              requestID: handoffID + "-options",
            },
            options,
          )
        ).data,
      )
      assert.equal(preview.source?.kind, "native")
      const destination = preview.environment?.native
      if (!destination || !preview.environment) throw new Error("The actual target has no advertised native descriptor")
      assert.notEqual(preview.environment.source.kind, "none")
      const environmentMapping = Handoff.EnvironmentMapping.parse({
        version: 1,
        expectedSelectionRevision: preview.environment.expectedSelectionRevision,
        source: preview.environment.source,
        target: destination,
      })
      const environmentHash = await Handoff.environmentMappingHash(environmentMapping)
      const prepared = (
        await client.orgHandoff.prepare(
          {
            sessionID,
            orgHandoffPrepare: {
              handoffID,
              targetRuntimeID: targetID,
              expectedBindingEpoch: preview.bindingEpoch,
              expectedControlRevision: preview.controlRevision,
              mappingPlanRevision: 1,
              workspaceMapping: { kind: "native" },
              environmentMapping,
            },
          },
          options,
        )
      ).data
      if (!prepared.targetAccepted)
        await client.orgHandoff.accept(
          {
            handoffID,
            orgHandoffAccept: {
              mappingPlanRevision: prepared.mappingPlanRevision,
              mappingHash: prepared.mappingHash,
            },
          },
          options,
        )
      const participants = [darwin.registration, hello?.ticket.runtime]
      const source = participants.find((participant) => participant?.runtimeID === sourceID)
      const target = participants.find((participant) => participant?.runtimeID === targetID)
      if (!source || !target) throw new Error("Handoff completion requires both original enrolled machine keys")
      const sourceMachine = { runtimeID: source.runtimeID, publicKey: source.publicKey }
      const targetMachine = { runtimeID: target.runtimeID, publicKey: target.publicKey }
      async function drive(operation: Handoff.Drive["operation"]) {
        const observedSince = performance.now()
        const end = observedSince + 120000
        let foregroundUnknownMs: number | undefined
        const complete = createHandoffCompletion({
          binding: Handoff.Binding.strip().parse(prepared),
          source: sourceMachine,
          target: targetMachine,
          async invoke(operation, requestID) {
            if (performance.now() >= end)
              throw new Error("The original machine receipt inspection did not settle within its observation window")
            const driveObservation: NonNullable<typeof activeDrive> = { operation }
            activeDrive = driveObservation
            try {
              const result = Handoff.MachineResult.parse(
                (await client.orgHandoff.drive({ handoffID, orgHandoffDrive: { operation, requestID } }, options)).data,
              )
              if (driveObservation.record)
                driveObservation.record.machine = {
                  state: result.state,
                  stage: result.stage,
                  factsCount: result.facts.length,
                }
              return result
            } catch (error) {
              if (driveObservation.record) driveObservation.record.denialReason = handoffDenialReason(error)
              if (
                operation === "prepare-target" &&
                z.object({ code: z.literal("COMMAND_OUTCOME_UNKNOWN"), outcome: z.literal("unknown") }).safeParse(error)
                  .success
              ) {
                foregroundUnknownMs = performance.now() - observedSince
                costs[handoffID + "ForegroundUnknownMs"] = foregroundUnknownMs
              }
              throw error
            } finally {
              if (activeDrive === driveObservation) activeDrive = undefined
            }
          },
        })
        const result = await complete(operation)
        if (foregroundUnknownMs !== undefined)
          costs[handoffID + "InspectionMs"] = performance.now() - observedSince - foregroundUnknownMs
        return result
      }
      const frozen = (await drive("prepare-source")).facts[0]?.proof
      assert.equal(frozen?.purpose, "source-frozen")
      if (frozen?.purpose !== "source-frozen") throw new Error("The actual source never froze")
      assert.equal(frozen.environmentMappingHash, environmentHash)
      const staged = (await drive("prepare-target")).facts[0]?.proof
      assert.equal(staged?.purpose, "target-prepared")
      if (staged?.purpose !== "target-prepared") throw new Error("The actual target never prepared")
      assert.equal(staged.environmentMappingHash, environmentHash)
      await client.orgHandoff.permit(
        {
          handoffID,
          orgHandoffPermitRequest: { purpose: "handoff-surrender" },
        },
        options,
      )
      assert.equal((await drive("surrender-source")).facts[0]?.proof.purpose, "source-surrendered")
      const committed = (await client.orgHandoff.commit({ handoffID, body: {} }, options)).data
      assert.equal(committed.currentDriver, targetID)
      assert.equal(committed.bindingEpoch, preview.bindingEpoch + 1)
      await client.orgHandoff.permit(
        {
          handoffID,
          orgHandoffPermitRequest: { purpose: "handoff-activation" },
        },
        options,
      )
      assert.equal((await drive("activate-target")).facts[0]?.proof.purpose, "target-activated")
      assert.equal((await client.orgHandoff.get({ handoffID }, options)).data.phase, "completed")
      const noLongerDriver = await client.orgCommands.input(
        {
          sessionID,
          orgCommandInputRequest: {
            schemaVersion: 1,
            orgID: account!.orgID,
            projectID: project.projectID,
            sessionID,
            runtimeID: sourceID,
            requestID: handoffID + "-old-source-cannot-run",
            input: {
              operation: "input",
              mode: "context",
              parts: [
                {
                  type: "text",
                  text: "This old driver must remain surrendered",
                },
              ],
            },
          },
        },
        { headers },
      )
      assert.ok(noLongerDriver.error, "The previous driver must not accept new input after permanent surrender")
      return {
        frozenHash: digest(frozen),
        preparedHash: await Handoff.proofHash(staged),
        epoch: committed.bindingEpoch,
      }
    }
    async function continueOriginal(current: z.infer<typeof NativeObservation>, targetID: string) {
      assert.ok(current.paused)
      const result = Command.ControlAccepted.parse(
        (
          await client.orgCommands.control(
            {
              sessionID,
              orgCommandControlRequest: {
                schemaVersion: 1,
                orgID: account!.orgID,
                projectID: project.projectID,
                sessionID,
                runtimeID: targetID,
                requestID: "independent-continue-" + crypto.randomUUID(),
                control: {
                  operation: "continue",
                  pausedSince: current.paused.since,
                  controlVersion: current.controlVersion,
                },
              },
            },
            options,
          )
        ).data,
      )
      assert.equal(result.effect.operation, "continue")
      if (result.effect.operation !== "continue") throw new Error("The independent Continue changed its operation")
      assert.equal(result.effect.rootID, accepted.effect.messageID)
    }
    phase = "darwin-to-linux"
    started = performance.now()
    const outbound = await move(darwin.registration.runtimeID, linuxID, "cross-os-outbound")
    await linux({ kind: "attach", sessionID, accepted, initial: false })
    const received = NativeObservation.parse(await linux({ kind: "observe" }))
    assert.equal(received.platform, "linux")
    assert.equal(received.uname, "Linux")
    assert.equal(received.native.descriptor.platform, "linux")
    assert.equal(received.organization.bindingEpoch, 2)
    assert.equal(received.sessionID, sessionID)
    assert.equal(received.directoryIsOriginal, false)
    assert.ok(received.paused)
    assert.deepEqual(received.files, original.files)
    assertHistory(original, received)
    assert.notEqual(received.workspaceID, original.workspaceID)
    const historyFirst = await linux({
      kind: "historical",
      snapshots: [first.snapshot],
    })
    assert.deepEqual(historyFirst, [{ snapshot: first.snapshot, current: "before the original native task" }])
    costs.outboundMs = performance.now() - started
    phase = "linux-independent-continue"
    started = performance.now()
    await continueOriginal(received, linuxID)
    const second = Execution.parse(await linux({ kind: "execute", phase: "linux-second" }))
    assert.equal(second.platform, "linux")
    const advanced = NativeObservation.parse(await linux({ kind: "observe" }))
    assert.equal(advanced.files.current, "dirty Linux bytes\n")
    assert.equal(advanced.files.binary, fileHash(LinuxBytes))
    assert.equal(advanced.files.ignored, fileHash(InitialBytes))
    assert.equal(advanced.files.mode, 0o755)
    assert.equal(advanced.files.link, "current.txt")
    assert.equal(advanced.files.unicode, "跨平台真实目录\n")
    assert.equal(advanced.original.current, "before the original native task\n")
    costs.linuxNativeMs = performance.now() - started
    phase = "linux-to-darwin"
    started = performance.now()
    const returning = await move(linuxID, darwin.registration.runtimeID, "cross-os-return")
    await darwin.dispatch({
      kind: "attach",
      sessionID,
      accepted,
      initial: false,
    })
    const returned = NativeObservation.parse(await darwin.dispatch({ kind: "observe" }))
    assert.equal(returned.platform, "darwin")
    assert.equal(returned.uname, "Darwin")
    assert.equal(returned.organization.bindingEpoch, 3)
    assert.ok(returned.paused)
    assert.equal(returned.sessionID, sessionID)
    assert.equal(returned.directoryIsOriginal, false)
    assert.deepEqual(returned.files, advanced.files)
    assertHistory(advanced, returned)
    assert.equal(returned.original.current, "dirty Darwin bytes\n")
    assert.equal(returned.original.binary, fileHash(InitialBytes))
    assert.deepEqual(
      await darwin.dispatch({
        kind: "historical",
        snapshots: [first.snapshot, second.snapshot],
      }),
      [
        {
          snapshot: first.snapshot,
          current: "before the original native task",
        },
        { snapshot: second.snapshot, current: "dirty Darwin bytes" },
      ],
    )
    costs.returnMs = performance.now() - started
    phase = "darwin-return-independent-continue"
    await continueOriginal(returned, darwin.registration.runtimeID)
    const last = Execution.parse(await darwin.dispatch({ kind: "execute", phase: "darwin-return" }))
    assert.equal(last.platform, "darwin")
    await darwin.dispatch({ kind: "settle" })
    phase = "cleanup"
    started = performance.now()
    await linux({ kind: "close" })
    const errors: unknown[] = []
    for (const owned of cleanups.toReversed()) {
      tunnelObservation.cleanup(owned.owner, "started")
      try {
        await owned.close()
        tunnelObservation.cleanup(owned.owner, "completed")
      } catch (error) {
        tunnelObservation.cleanup(owned.owner, "failed")
        errors.push(error)
      }
    }
    cleanups.length = 0
    try {
      transportFacts.health.temporaryNameCleanup = await temporaryNameHint?.close()
    } catch (error) {
      errors.push(error)
    }
    if (firstHeaderDNS) transportFacts.health.firstFailureDNSCleanup = await firstHeaderDNS.close()
    if (errors.length) throw new AggregateError(errors, "Cross-OS actual owners did not close")
    costs.cleanupMs = performance.now() - started
    await fs.writeFile(
      path.join(state(), "report.json"),
      JSON.stringify({
        version: 1,
        run: run(),
        passed: true,
        transport: transportSnapshot(),
        actualPlatforms: [original.platform, received.platform, returned.platform],
        nativeDescriptors: [original.native.descriptor, received.native.descriptor, returned.native.descriptor],
        epochs: [outbound.epoch, returning.epoch],
        receipts: [outbound, returning],
        historyHashes: [digest(original.messages), digest(advanced.messages)],
        costs,
      }),
    )
  } catch (error) {
    const failedTransport = transportSnapshot()
    const failedRequests = { recent: [...requests], failures: [...requestFailures] }
    const errors: unknown[] = [error]
    const failedPhase = phase === "service-bootstrap" ? (setupStage ?? phase) : phase
    const failedHTTPStatus = phase === "service-bootstrap" ? setupHTTPStatus : undefined
    let postFailureHTTP: ReturnType<typeof startCrossOSPostFailureHTTP> | undefined
    let postFailureCleanup: Awaited<ReturnType<ReturnType<typeof startCrossOSPostFailureHTTP>["close"]>> | undefined
    async function writeFailureReport(
      cleanupStage: "before-original-cleanup" | "before-diagnostic-join" | "before-passive-configuration" | "complete",
    ) {
      await fs.writeFile(
        path.join(state(), "report.json"),
        JSON.stringify({
          version: 1,
          run: run(),
          passed: false,
          cleanupPending: cleanupStage !== "complete",
          cleanupStage,
          phase: failedPhase,
          ...(failedHTTPStatus === undefined ? {} : { httpStatus: failedHTTPStatus }),
          costs,
          errors: errors.map(safeFailure),
          requests: failedRequests,
          targetPreparationFailures: targetPreparationFailures(),
          transport: failedTransport,
          postFailureOriginHandled: Math.max(
            0,
            transportFacts.health.originHandled - failedTransport.health.originHandled,
          ),
          ...(postFailureCleanup ? { postFailureHTTPCleanup: postFailureCleanup } : {}),
          cleanupTransport: tunnelObservation.snapshot(),
        }),
      )
    }
    if (failedPublicHealth) {
      const dns = observeDNSAfterFailedHealth(connection.origin, failedTransport.health.originalENOTFOUND)
      try {
        if (bootstrapSignal.aborted && failedTransport.health.originalENOTFOUND > 0)
          postFailureHTTP = startCrossOSPostFailureHTTP(connection.origin, run())
        const [afterFailureDNS, afterFailureHTTP] = await Promise.all([dns, postFailureHTTP?.result])
        failedTransport.health.afterFailureDNS = afterFailureDNS
        failedTransport.health.afterFailureHTTP = afterFailureHTTP
      } catch (diagnostic) {
        errors.push(diagnostic)
      } finally {
        if (postFailureHTTP) {
          try {
            await writeFailureReport("before-original-cleanup")
          } catch (checkpoint) {
            errors.push(checkpoint)
          }
        }
      }
    }
    for (const owned of cleanups.toReversed()) {
      tunnelObservation.cleanup(owned.owner, "started")
      try {
        await owned.close()
        tunnelObservation.cleanup(owned.owner, "completed")
      } catch (cleanup) {
        tunnelObservation.cleanup(owned.owner, "failed")
        errors.push(cleanup)
      }
    }
    if (postFailureHTTP) {
      try {
        await writeFailureReport("before-diagnostic-join")
      } catch (checkpoint) {
        errors.push(checkpoint)
      }
      try {
        postFailureCleanup = await postFailureHTTP.close()
      } catch (diagnosticCleanup) {
        errors.push(diagnosticCleanup)
      }
    }
    if (temporaryNameHint) {
      try {
        await writeFailureReport("before-diagnostic-join")
      } catch (checkpoint) {
        errors.push(checkpoint)
      }
      try {
        failedTransport.health.temporaryNameCleanup = await temporaryNameHint.close()
      } catch (cleanup) {
        errors.push(cleanup)
      }
    }
    if (firstHeaderDNS) {
      try {
        failedTransport.health.firstFailureDNSCleanup = await firstHeaderDNS.close()
        failedTransport.health.firstFailureDNS = transportFacts.health.firstFailureDNS
      } catch (diagnostic) {
        errors.push(diagnostic)
      }
    }
    if (failedPublicHealth && failedTransport.health.originalENOTFOUND > 0) {
      try {
        await writeFailureReport("before-passive-configuration")
      } catch (checkpoint) {
        errors.push(checkpoint)
      }
      failedTransport.health.passiveResolverRoute = observeCrossOSResolverRoute(capturedHostname)
    }
    await writeFailureReport("complete")
    throw new Error("Actual cross-OS acceptance failed at " + phase + "; original failure retained in the runner", {
      cause: error,
    })
  }
}

async function linux() {
  assert.equal(process.platform, "linux")
  const bootstrapSignal = AbortSignal.timeout(Math.max(0, Math.ceil(120000 - process.uptime() * 1000)))
  const secret = await setup("linux-identity", identity)
  const publicOrigin = await setup("linux-public-origin-rendezvous", async () =>
    PublicOrigin.parse(await waitArtifact("darwin", "origin", bootstrapSignal)),
  )
  await setup("linux-original-public-health", () =>
    until(
      async () => {
        try {
          await readPublicPeerHealth(publicOrigin.origin, secret.public.run, bootstrapSignal)
          return true
        } catch (error) {
          bootstrapSignal.throwIfAborted()
          return undefined
        }
      },
      Math.max(0, Math.ceil(120000 - process.uptime() * 1000)),
      "The original Linux peer could not verify the same public HTTPS origin",
    ),
  )
  await setup("linux-public-health-publication", () =>
    fs.writeFile(
      path.join(state(), "health.json"),
      JSON.stringify(encode(secret, publicOrigin, "health", { origin: publicOrigin.origin, native: "darwin" })),
      { mode: 0o600, flag: "wx", signal: bootstrapSignal },
    ),
  )
  const bootstrap = await setup("linux-bootstrap-rendezvous", async () => {
    const value = Bootstrap.parse(await waitArtifact("darwin", "bootstrap", bootstrapSignal))
    assert.deepEqual(
      {
        version: value.version,
        run: value.run,
        role: value.role,
        signing: value.signing,
        encryption: value.encryption,
        origin: value.origin,
      },
      publicOrigin,
    )
    bootstrapSignal.throwIfAborted()
    return value
  })
  const nonces = new Set<string>(),
    root = await setup("linux-temporary-root", () =>
      fs.mkdtemp(path.join(process.env.SYNERGY_TEST_ROOT!, "cross-os-linux-")),
    )
  const peer = await setup("linux-peer-bootstrap", () =>
    createPeer({
      root,
      origin: bootstrap.origin,
      identity: { ...bootstrap.identity, deviceID: "cross-os-linux" },
      async ticket(publicKey) {
        return Runtime.Ticket.parse(await exchange(secret, bootstrap, bootstrap.origin, "hello", { publicKey }, nonces))
      },
    }),
  )
  let closed = false
  let phase = "linux-ready"
  const started = performance.now()
  let ownerFailure: { phase: string; error: unknown } | undefined
  const errors: unknown[] = []
  const failed = () =>
    fs.writeFile(
      path.join(state(), "report.json"),
      JSON.stringify({
        version: 1,
        run: run(),
        passed: false,
        phase: ownerFailure?.phase ?? phase,
        status: "failed",
        elapsedMs: performance.now() - started,
        errors: errors.map(safeFailure),
        targetPreparationFailures: peer.targetPreparationFailures(),
      }),
    )
  try {
    await exchange(
      secret,
      bootstrap,
      bootstrap.origin,
      "ready",
      { runtimeID: peer.registration.runtimeID, platform: "linux" },
      nonces,
    )
    const deadline = Date.now() + 12 * 60 * 1000
    while (Date.now() < deadline) {
      phase = "linux-control-next"
      const next = await exchange(secret, bootstrap, bootstrap.origin, "next", null, nonces)
      if (next === null) {
        await Bun.sleep(100)
        continue
      }
      const task = Task.parse(next)
      phase = "linux-dispatch-" + task.action.kind
      let outcome: z.infer<typeof Outcome>
      try {
        outcome = {
          id: task.id,
          ok: true,
          value: await peer.dispatch(task.action),
        }
      } catch (error) {
        ownerFailure = { phase, error }
        outcome = {
          id: task.id,
          ok: false,
          name: error instanceof Error ? error.name : "UnknownError",
          message: "The actual Linux owner rejected fixture action " + task.action.kind,
        }
      }
      phase = "linux-control-result"
      await exchange(secret, bootstrap, bootstrap.origin, "result", json(outcome), nonces)
      if (!outcome.ok) throw new Error(outcome.message)
      if (task.action.kind === "close") {
        closed = true
        await fs.writeFile(
          path.join(state(), "report.json"),
          JSON.stringify({
            version: 1,
            run: run(),
            passed: true,
            actualPlatform: process.platform,
            architecture: process.arch,
            cleanup: "original-runtime-closed",
          }),
        )
        return
      }
    }
    throw new Error("The finite cross-OS fixture did not finish")
  } catch (error) {
    if (ownerFailure) errors.push(ownerFailure.error)
    if (error !== ownerFailure?.error) errors.push(error)
    try {
      await failed()
    } catch (diagnostic) {
      throw new AggregateError([...errors, diagnostic], "Actual Linux peer failure and its safe diagnostic failed")
    }
    throw error
  } finally {
    if (!closed) {
      try {
        await peer.close()
      } catch (cleanup) {
        if (!errors.length) phase = "linux-cleanup"
        errors.push(cleanup)
        try {
          await failed()
        } catch (diagnostic) {
          errors.push(diagnostic)
        }
        throw new AggregateError(errors, "Actual Linux peer failure and original cleanup failed")
      }
    }
    if (errors.length) await failed().catch(() => {})
  }
}

test.skipIf(role === undefined)(
  "real Darwin and Linux Native peers roundtrip the same directory and historical objects",
  async () => {
    const selected = z.enum(["darwin", "linux"]).parse(role)
    assert.equal(process.platform, selected)
    if (selected === "darwin") await host()
    else await linux()
  },
  15 * 60 * 1000,
)
