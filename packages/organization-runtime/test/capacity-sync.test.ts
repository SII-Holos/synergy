import { expect, test } from "bun:test"
import path from "node:path"
import { createHash } from "node:crypto"
import { fileURLToPath } from "node:url"
import { z } from "zod"
import { createOrganizationClient } from "@ericsanchezok/synergy-sdk/organization"
import { OrganizationRuntimeProtocol as Protocol } from "@ericsanchezok/synergy-organization-protocol"
import { testResources } from "@ericsanchezok/synergy-testing/resources"
import { prepareMemberHome, prepareHostedHome, type RuntimeIdentity } from "../src/home"
import { enrollMemberRuntime, enrollHostedRuntime } from "../src/enrollment"
import { fixture } from "./support/organization"
import {
  CapacityBacklog,
  CapacityMetrics,
  CapacityReply,
  WrittenHistory,
  measureCapacity,
  measureOwnedProcessMemory,
  messageChecksum,
  type CapacityRequest,
} from "./support/capacity-runtime"

type WithoutID<T> = T extends { id: string } ? Omit<T, "id"> : never

async function eventually<T>(label: string, read: () => Promise<T>, accepts: (value: T) => boolean, timeout = 240000) {
  const deadline = Date.now() + timeout
  while (true) {
    const result = await read()
    if (accepts(result)) return result
    if (Date.now() >= deadline) throw new Error(`${label}: ${JSON.stringify(result)}`)
    await Bun.sleep(50)
  }
}

test("ten authenticated clients replay a shared 10000-message history while three enrolled Runtime processes drain one hundred Sessions within bounded pages", async () => {
  const resources = testResources()
  const osMemory = measureOwnedProcessMemory()
  osMemory.own(process.pid, () => true)
  resources.defer("capacity OS process sampler", () => osMemory[Symbol.asyncDispose]())
  let failed: { error: unknown } | undefined
  const observedAt = performance.now()
  let observedPhase = "setup"
  function phase(value: string, counts: Record<string, number> = {}) {
    observedPhase = value
    console.log(
      "CAPACITY_PHASE",
      JSON.stringify({ phase: value, elapsedMs: performance.now() - observedAt, ...counts }),
    )
  }
  phase("setup")
  try {
    const service = await fixture()
    resources.defer("capacity organization service", () => service[Symbol.asyncDispose]())
    using serviceMetrics = measureCapacity()
    const owner = { headers: service.headers, throwOnError: true as const }
    const started = performance.now()
    const timings: Record<string, number> = {}
    const wire = {
      batches: 0,
      maxEvents: 0,
      maxBatchBytes: 0,
      blobFrames: 0,
      maxBlobFrameBytes: 0,
      maxBlobFrameWireBytes: 0,
      blobOffsets: new Set<number>(),
    }
    type Socket = Parameters<typeof service.service.websocket.message>[0]
    type Frame = Parameters<typeof service.service.websocket.message>[1]
    const sockets = new Map<Socket, string>()
    const online = new Set<string>()
    const activity = new Map<
      string,
      { handshakes: number; heartbeats: number; states: number; batches: number; at: number; epoch: number }
    >()
    const connectionActivity = (runtimeID: string) => {
      const current = activity.get(runtimeID)
      return {
        handshakes: current?.handshakes ?? 0,
        heartbeats: current?.heartbeats ?? 0,
        states: current?.states ?? 0,
        runtimeBatches: current?.batches ?? 0,
        heartbeatAgeMs: current?.at ? Math.round(performance.now() - current.at) : -1,
        heartbeatEpoch: current?.epoch ?? 0,
      }
    }
    let gatedSession: string | undefined
    let observedSession: string | undefined
    let tailStarted = false
    let tailBatchFrames = 0
    let lastLongBatch: Record<string, number> = {}
    const held: Array<{ socket: Socket; raw: Frame }> = []
    const firstHeld = Promise.withResolvers<void>()
    service.interceptFrames((socket, raw) => {
      const frame = Protocol.ClientFrame.parse(JSON.parse(String(raw)))
      if (frame.type === "handshake") {
        const runtimeID = frame.proof.handshake.runtimeID
        sockets.set(socket, runtimeID)
        const current = activity.get(runtimeID) ?? {
          handshakes: 0,
          heartbeats: 0,
          states: 0,
          batches: 0,
          at: 0,
          epoch: 0,
        }
        current.handshakes++
        activity.set(runtimeID, current)
      }
      const current = activity.get(sockets.get(socket) ?? "")
      if (current) {
        if (frame.type === "heartbeat") {
          current.heartbeats++
          current.at = performance.now()
          current.epoch = frame.connectionEpoch
        }
        if (frame.type === "sync-state") current.states++
        if (frame.type === "sync-batch") current.batches++
      }
      if (frame.type === "heartbeat") {
        const runtimeID = sockets.get(socket)
        if (runtimeID) online.add(runtimeID)
      }
      if (frame.type === "blob-chunk") {
        wire.blobFrames++
        wire.maxBlobFrameBytes = Math.max(wire.maxBlobFrameBytes, Buffer.from(frame.data, "base64url").byteLength)
        wire.maxBlobFrameWireBytes = Math.max(wire.maxBlobFrameWireBytes, Buffer.byteLength(raw))
        wire.blobOffsets.add(frame.offset)
      }
      if (frame.type !== "sync-batch") return false
      wire.batches++
      if (frame.batch.sessionID === observedSession) {
        const changed = lastLongBatch.lastSeq !== frame.batch.lastSeq
        lastLongBatch = {
          firstSeq: frame.batch.firstSeq,
          lastSeq: frame.batch.lastSeq,
          events: frame.batch.events.length,
          shareGeneration: frame.batch.shareGeneration,
          bindingEpoch: frame.batch.bindingEpoch,
          connectionEpoch: frame.connectionEpoch,
          messageEvents: frame.batch.events.filter((event) => event.type === "message").length,
        }
        if (tailStarted && (++tailBatchFrames === 1 || changed || tailBatchFrames % 20 === 0))
          console.log("CAPACITY_TAIL_WIRE", JSON.stringify({ frames: tailBatchFrames, ...lastLongBatch }))
      }
      wire.maxEvents = Math.max(wire.maxEvents, frame.batch.events.length)
      wire.maxBatchBytes = Math.max(wire.maxBatchBytes, Buffer.byteLength(JSON.stringify(frame.batch)))
      if (frame.batch.sessionID !== gatedSession) return false
      held.push({ socket, raw: typeof raw === "string" ? raw : Buffer.from(raw) })
      firstHeld.resolve()
      return true
    })
    resources.defer("capacity synchronization gate", async () => {
      gatedSession = undefined
      for (const item of held.splice(0)) await service.service.websocket.message(item.socket, item.raw)
      service.interceptFrames(undefined)
    })

    async function account(loginName: string) {
      const invite = (await service.client.orgInvites.create({ orgInviteCreate: { role: "member" } }, owner)).data
      const password = `A capacity fixture password for ${loginName}`
      const accepted = (
        await service.client.orgInvites.consume(
          {
            orgInviteConsume: {
              token: invite.token,
              requestID: crypto.randomUUID(),
              loginName,
              displayName: loginName,
              password,
            },
          },
          { throwOnError: true },
        )
      ).data
      const login = await service.client.orgAuth.login(
        { orgLoginInput: { loginName, password } },
        { throwOnError: true },
      )
      const cookie = login.response.headers.get("set-cookie")?.split(";")[0]
      if (!cookie) throw new Error("Capacity account did not establish its authenticated session")
      return {
        accountID: accepted.accountID,
        loginName,
        password,
        headers: { cookie, "x-csrf-token": login.data.csrfToken },
      }
    }
    const member = await account("capacity-member")
    const reader = await account("capacity-reader")
    const projects = []
    for (const name of ["Capacity P", "Capacity Q"]) {
      const project = (await service.client.orgProjects.create({ orgProjectCreate: { name } }, owner)).data
      for (const [account, role] of [
        [member, "collaborator"],
        [reader, "reader"],
      ] as const) {
        const current = (await service.client.orgProjects.get({ projectID: project.projectID }, owner)).data
        await service.client.orgProjects.member(
          {
            projectID: project.projectID,
            accountID: account.accountID,
            orgProjectMemberChange: { expectedRevision: current.revision, role },
          },
          owner,
        )
      }
      projects.push(project)
    }

    async function child(home: { home: string; root: string; identity: RuntimeIdentity }, runtimeID: string) {
      const pending = new Map<string, ReturnType<typeof Promise.withResolvers<unknown>>>()
      const ready = Promise.withResolvers<number>()
      const processHandle = Bun.spawn({
        cmd: [
          process.execPath,
          "run",
          "--no-env-file",
          `--config=${process.platform === "win32" ? "NUL" : "/dev/null"}`,
          fileURLToPath(new URL("./support/capacity-runtime.ts", import.meta.url)),
        ],
        cwd: home.root,
        env: {
          ...process.env,
          SYNERGY_HOME: home.home,
          SYNERGY_CAPACITY_RUNTIME: JSON.stringify({ home: home.home, identity: home.identity, ca: service.ca }),
        },
        stdin: "ignore",
        stdout: "ignore",
        stderr: "pipe",
        ipc(raw: unknown) {
          const message = CapacityReply.parse(raw)
          if (message.type === "ready") return ready.resolve(message.pid)
          if (message.type === "progress") {
            console.log(
              `CAPACITY_NATIVE_PROGRESS ${JSON.stringify({ pid: processHandle.pid, completed: message.completed, total: message.total, elapsedMs: message.elapsedMs, peakRSS: message.peakRSS, peakHeap: message.peakHeap, nativeTransactions: message.nativeTransactions, markerScans: message.markerScans, cpuUserMs: message.cpuUserMs, cpuSystemMs: message.cpuSystemMs, bunOptionsPresent: message.bunOptionsPresent, nodeOptionsPresent: message.nodeOptionsPresent, jscTuningPresent: message.jscTuningPresent, coverageRequested: message.coverageRequested, profilerRequested: message.profilerRequested })}`,
            )
            return
          }
          if (message.type === "result") return pending.get(message.id)?.resolve(message.result)
          const error = new Error(message.message)
          if (message.id) pending.get(message.id)?.reject(error)
          else ready.reject(error)
        },
      })
      osMemory.own(processHandle.pid, () => processHandle.exitCode === null)
      const errors = (async () => {
        let text = ""
        for await (const chunk of processHandle.stderr)
          if (text.length < 16384)
            text += Buffer.from(chunk)
              .toString()
              .slice(0, 16384 - text.length)
        return text
      })()
      void processHandle.exited.then(async (code) => {
        const error = new Error(`Capacity Runtime child exited (${code}): ${await errors}`)
        ready.reject(error)
        for (const request of pending.values()) request.reject(error)
      })
      async function request<T extends z.ZodType>(
        command: WithoutID<CapacityRequest>,
        schema: T,
        timeout = 240000,
      ): Promise<z.output<T>> {
        const id = crypto.randomUUID()
        const result = Promise.withResolvers<unknown>()
        pending.set(id, result)
        const timer = setTimeout(
          () => result.reject(new Error(`Capacity Runtime ${command.operation} did not settle`)),
          timeout,
        )
        try {
          processHandle.send({ ...command, id })
          return schema.parse(await result.promise)
        } finally {
          clearTimeout(timer)
          pending.delete(id)
        }
      }
      resources.defer("capacity native child", async () => {
        if (processHandle.exitCode !== null) return
        try {
          await request({ operation: "close" }, CapacityMetrics, 10000)
        } finally {
          if (processHandle.exitCode === null) processHandle.kill()
          await processHandle.exited
        }
      })
      const timer = setTimeout(() => ready.reject(new Error("Enrolled capacity Runtime did not open")), 30000)
      const pid = await ready.promise.finally(() => clearTimeout(timer))
      await eventually(
        "The Service did not accept the enrolled Runtime heartbeat",
        async () => online.has(runtimeID),
        Boolean,
        10000,
      )
      return {
        pid,
        runtimeID,
        request,
        headers:
          "accountID" in home.identity && home.identity.accountID === member.accountID
            ? member.headers
            : service.headers,
      }
    }
    const memberA = await prepareMemberHome({
      baseDirectory: path.join(service.root, "members"),
      identity: { ...service.identity, deviceID: "capacity-a" },
      origin: service.origin,
    })
    const memberB = await prepareMemberHome({
      baseDirectory: path.join(service.root, "members"),
      identity: { ...service.identity, accountID: member.accountID, deviceID: "capacity-b" },
      origin: service.origin,
    })
    const hosted = await prepareHostedHome({
      baseDirectory: path.join(service.root, "hosted"),
      identity: { orgID: service.identity.orgID, hostID: "capacity-hosted" },
      origin: service.origin,
    })
    const memberRegistrationA = await enrollMemberRuntime({
      home: memberA.home,
      identity: memberA.identity,
      ca: service.ca,
      ticket: await service.ticket(memberA.identity.deviceID, memberA.publicKey),
    })
    const memberTicketB = (
      await service.client.orgRuntime.registerMember(
        { orgMemberRuntimeRegistration: { deviceID: memberB.identity.deviceID, publicKey: memberB.publicKey } },
        { headers: member.headers, throwOnError: true },
      )
    ).data
    const memberRegistrationB = await enrollMemberRuntime({
      home: memberB.home,
      identity: memberB.identity,
      ca: service.ca,
      ticket: memberTicketB,
    })
    const hostedTicket = (
      await service.client.orgRuntime.registerHosted(
        { orgHostedRuntimeRegistration: { name: "Capacity Hosted", publicKey: hosted.publicKey } },
        owner,
      )
    ).data
    const hostedRegistration = await enrollHostedRuntime({
      home: hosted.home,
      identity: hosted.identity,
      ca: service.ca,
      ticket: hostedTicket,
    })
    const runtimes = await Promise.all([
      child(memberA, memberRegistrationA.runtimeID),
      child(memberB, memberRegistrationB.runtimeID),
      child(hosted, hostedRegistration.runtimeID),
    ])
    expect(new Set(runtimes.map((entry) => entry.pid)).size).toBe(3)
    expect(runtimes.every((entry) => entry.pid !== process.pid)).toBe(true)
    expect(new Set([memberA.home, memberB.home, hosted.home]).size).toBe(3)
    timings.enrollmentMs = performance.now() - started
    const sessions: Array<{ sessionID: string; projectID: string; runtime: number }> = []
    for (let index = 0; index < 100; index++) {
      const runtime = index % runtimes.length
      const projectID = projects[index % projects.length].projectID
      const created = (
        await service.client.orgSessions.create(
          {
            orgCommandCreateRequest: {
              schemaVersion: 1,
              orgID: service.identity.orgID,
              projectID,
              runtimeID: runtimes[runtime].runtimeID,
              requestID: `capacity-create-${index}`,
              creation: { operation: "create", title: `Capacity Session ${index}` },
            },
          },
          { headers: runtimes[runtime].headers, throwOnError: true },
        )
      ).data
      sessions.push({ sessionID: created.effect.sessionID, projectID, runtime })
    }
    expect(new Set(sessions.map((entry) => entry.sessionID)).size).toBe(100)
    const long = sessions[0]
    phase("native-append", { sessions: sessions.length, messages: 10000, runtimes: runtimes.length })
    const produced = (
      await Promise.all(
        runtimes.map((runtime, index) =>
          runtime.request(
            {
              operation: "append",
              sessions: sessions
                .filter((entry) => entry.runtime === index)
                .map((entry) => ({
                  sessionID: entry.sessionID,
                  count: entry.sessionID === long.sessionID ? 10000 : 1,
                  attachment: entry.sessionID === long.sessionID,
                })),
            },
            z.array(WrittenHistory),
          ),
        ),
      )
    ).flat()
    const history = produced.find((entry) => entry.sessionID === long.sessionID)!
    expect(history.count).toBe(10000)
    expect(history.attachment?.bytes).toBe(8 * 1024 * 1024 + 17)
    expect(history.attachment!.chunks).toBeGreaterThan(1)
    timings.producedMs = performance.now() - started
    observedSession = long.sessionID
    phase("native-append-complete", {
      sessions: produced.length,
      messages: history.count,
      attachmentBytes: history.attachment!.bytes,
    })
    gatedSession = long.sessionID
    let shared = 0
    phase("share", { completed: 0, total: sessions.length, held: held.length, batches: wire.batches })
    for (const entry of sessions) {
      await service.client.orgSessions.share(
        { sessionID: entry.sessionID, orgShareChange: { expectedShareGeneration: 0 } },
        { headers: runtimes[entry.runtime].headers, throwOnError: true },
      )
      if (++shared % 10 === 0)
        phase("share", { completed: shared, total: sessions.length, held: held.length, batches: wire.batches })
    }
    phase("first-held-wait", { shared, held: held.length, batches: wire.batches })
    const heldTimer = setTimeout(
      () => firstHeld.reject(new Error("The real exporter did not reach its sync batch barrier")),
      240000,
    )
    await firstHeld.promise.finally(() => clearTimeout(heldTimer))
    timings.firstBatchMs = performance.now() - started
    phase("held-backlog-read", { held: held.length, batches: wire.batches, firstBatchMs: timings.firstBatchMs })
    const queued = await runtimes[0].request(
      {
        operation: "backlog",
        sessions: sessions.filter((entry) => entry.runtime === 0).map((entry) => entry.sessionID),
      },
      CapacityBacklog,
    )
    expect(queued.drafts).toBeGreaterThanOrEqual(20000)
    expect(queued.pendingBatches).toBeGreaterThan(0)
    phase("held-release", { held: held.length, drafts: queued.drafts, pendingBatches: queued.pendingBatches })
    gatedSession = undefined
    for (const item of held.splice(0)) await service.service.websocket.message(item.socket, item.raw)
    phase("drain")
    const drained = await eventually(
      "Original durable exporter backlog did not drain",
      () =>
        Promise.all(
          runtimes.map((runtime, index) =>
            runtime.request(
              {
                operation: "backlog",
                sessions: sessions.filter((entry) => entry.runtime === index).map((entry) => entry.sessionID),
              },
              CapacityBacklog,
            ),
          ),
        ),
      (entries) =>
        entries.every((entry) => entry.drafts === 0 && entry.pendingBatches === 0 && entry.synced === entry.sessions),
    )
    expect(drained.reduce((sum, entry) => sum + entry.sessions, 0)).toBe(100)
    expect(wire.maxEvents).toBeLessThanOrEqual(256)
    expect(wire.maxBatchBytes).toBeLessThanOrEqual(1024 * 1024)
    expect(wire.maxBlobFrameWireBytes).toBeLessThanOrEqual(64 * 1024)
    expect([...wire.blobOffsets].sort((a, b) => a - b)).toEqual([0, 4 * 1024 * 1024, 8 * 1024 * 1024])
    timings.drainedMs = performance.now() - started
    phase("drained", {
      sessions: drained.reduce((sum, value) => sum + value.sessions, 0),
      drafts: drained.reduce((sum, value) => sum + value.drafts, 0),
      drainedMs: timings.drainedMs,
    })

    const api = { calls: 0, bytes: 0, maxResponseBytes: 0 }
    const clients: Array<{
      client: ReturnType<typeof createOrganizationClient>
      options: { headers: { cookie: string; "x-csrf-token": string }; throwOnError: true }
    }> = []
    for (let index = 0; index < 10; index++) {
      const transport = new Bun.FetchSession({ tls: { ca: service.ca, rejectUnauthorized: true }, proxy: false })
      resources.defer("capacity independent TLS client", () => transport.close())
      const client = createOrganizationClient({
        baseUrl: service.origin,
        fetch: Object.assign(
          async (input: Parameters<typeof transport.fetch>[0], init?: Parameters<typeof transport.fetch>[1]) => {
            const response = await transport.fetch(input, init)
            if (
              new URL(response.url).pathname.includes("/sync/") &&
              response.headers.get("content-type")?.includes("json")
            ) {
              const bytes = (await response.clone().arrayBuffer()).byteLength
              api.calls++
              api.bytes += bytes
              api.maxResponseBytes = Math.max(api.maxResponseBytes, bytes)
            }
            return response
          },
          { preconnect() {} },
        ),
        headers: { origin: "https://organization.example" },
      })
      const actor =
        index % 3 === 0
          ? { loginName: "owner", password: "a long integration password" }
          : index % 3 === 1
            ? member
            : reader
      const login = await client.orgAuth.login(
        { orgLoginInput: { loginName: actor.loginName, password: actor.password } },
        { throwOnError: true },
      )
      const cookie = login.response.headers.get("set-cookie")?.split(";")[0]
      if (!cookie) throw new Error("Independent capacity client login failed")
      clients.push({
        client,
        options: { headers: { cookie, "x-csrf-token": login.data.csrfToken }, throwOnError: true as const },
      })
    }
    expect(new Set(clients.map((entry) => entry.options.headers.cookie)).size).toBe(10)
    serviceMetrics.begin()
    phase("first-screen", { clients: clients.length })
    const first = await Promise.all(
      clients.map(async ({ client, options }) => {
        const [directory, messages, snapshot] = await Promise.all([
          client.orgSessions.list({ projectID: long.projectID, limit: 10 }, options),
          client.orgSessionSync.messages({ sessionID: long.sessionID, limit: 50 }, options),
          client.orgSessionSync.snapshot({ sessionID: long.sessionID, limit: 50 }, options),
        ])
        expect(directory.data.items).toHaveLength(10)
        expect(messages.data.items).toHaveLength(50)
        expect(snapshot.data.items).toHaveLength(50)
        expect(messages.data.cursor).toBeDefined()
        return messages.data
      }),
    )
    const firstScreen = { sql: serviceMetrics.snapshot(), api: { ...api } }
    expect(firstScreen.api.maxResponseBytes).toBeLessThan(128 * 1024)
    const transcriptRanges = firstScreen.sql.ranges.filter((entry) => entry.selector.includes('"transcript"'))
    expect(transcriptRanges.length).toBeGreaterThan(0)
    expect(
      transcriptRanges.every((entry) => entry.maxRows <= 51 && entry.maxLimit <= 51 && entry.unbounded === 0),
    ).toBe(true)
    expect(firstScreen.sql.maxReadMany).toBeLessThanOrEqual(128)
    const watermark = first[0].watermark
    phase("client-replay", { clients: clients.length, watermark, apiCalls: api.calls })
    const replays = await Promise.all(
      clients.map(async ({ client, options }, index) => {
        let page = first[index]
        let count = 0
        let pages = 0
        let checksum = 0n
        let oldest = Infinity
        while (true) {
          expect(page.watermark).toBe(watermark)
          expect(page.items.length).toBeLessThanOrEqual(50)
          expect(page.items.at(-1)!.createdAt).toBeLessThanOrEqual(oldest)
          for (const entry of page.items) {
            count++
            checksum ^= messageChecksum(entry.messageID)
          }
          oldest = page.items[0]!.createdAt
          pages++
          if (!page.cursor) break
          page = (
            await client.orgSessionSync.messages(
              { sessionID: long.sessionID, limit: 50, cursor: page.cursor, watermark },
              options,
            )
          ).data
        }
        expect(count).toBe(10000)
        expect(checksum.toString(16).padStart(64, "0")).toBe(history.checksum)
        return { count, pages }
      }),
    )
    phase("client-replay-complete", {
      clients: replays.length,
      pages: replays.reduce((sum, value) => sum + value.pages, 0),
      messages: replays.reduce((sum, value) => sum + value.count, 0),
    })
    const attachment = history.attachment!
    phase("attachment-download", { expectedBytes: attachment.bytes })
    const download = await clients[9].client.orgSessionSync.downloadBlob(
      { sessionID: long.sessionID, hash: attachment.hash, shareGeneration: first[9].shareGeneration },
      { ...clients[9].options, parseAs: "stream" },
    )
    if (!(download.data instanceof ReadableStream))
      throw new Error("Capacity attachment did not use its streaming download")
    let downloadedBytes = 0
    let maxDownloadChunk = 0
    const hash = createHash("sha256")
    for await (const value of download.data) {
      const bytes = z.instanceof(Uint8Array).parse(value)
      hash.update(bytes)
      downloadedBytes += bytes.byteLength
      maxDownloadChunk = Math.max(maxDownloadChunk, bytes.byteLength)
    }
    expect(downloadedBytes).toBe(attachment.bytes)
    expect(hash.digest("hex")).toBe(attachment.hash)
    phase("attachment-complete", { bytes: downloadedBytes, maxChunk: maxDownloadChunk })
    tailStarted = true
    phase("tail-append", { watermark, batches: wire.batches, ...lastLongBatch })
    const tail = (
      await runtimes[0].request(
        { operation: "append", sessions: [{ sessionID: long.sessionID, count: 1 }] },
        z.array(WrittenHistory),
      )
    )[0]
    phase("tail-appended", { messages: tail.count, batches: wire.batches, ...lastLongBatch })
    const tailNativeBacklog = await runtimes[0].request(
      { operation: "backlog", sessions: [long.sessionID], inspectNative: true },
      CapacityBacklog,
    )
    phase("tail-native-backlog", {
      sessions: tailNativeBacklog.sessions,
      drafts: tailNativeBacklog.drafts,
      pendingBatches: tailNativeBacklog.pendingBatches,
      synced: tailNativeBacklog.synced,
      ...tailNativeBacklog.native,
      ...connectionActivity(runtimes[0].runtimeID),
      ...lastLongBatch,
    })
    phase("tail-events", { clients: clients.length, watermark })
    let tailPolls = 0
    const replayedTail = await eventually(
      "The ten clients did not receive the post-checkpoint event",
      async () => {
        const entries = await Promise.all(
          clients.map(
            async ({ client, options }) =>
              (await client.orgSessionSync.events({ sessionID: long.sessionID, limit: 50, cursor: watermark }, options))
                .data,
          ),
        )
        if (++tailPolls === 20) {
          const backlog = await runtimes[0].request(
            { operation: "backlog", sessions: [long.sessionID], inspectNative: true },
            CapacityBacklog,
          )
          phase("tail-native-backlog", {
            polls: tailPolls,
            drafts: backlog.drafts,
            pendingBatches: backlog.pendingBatches,
            synced: backlog.synced,
            ...backlog.native,
            bindingAbsent:
              backlog.sessions - (backlog.native?.boundSessions ?? 0) - (backlog.native?.bindingUnavailable ?? 0),
            ...connectionActivity(runtimes[0].runtimeID),
          })
        }
        if (tailPolls === 1 || tailPolls % 20 === 0)
          phase("tail-events", {
            polls: tailPolls,
            clients: entries.length,
            watermark,
            minNextSeq: Math.min(...entries.map((entry) => entry.nextSeq)),
            maxNextSeq: Math.max(...entries.map((entry) => entry.nextSeq)),
            items: entries.reduce((sum, entry) => sum + entry.items.length, 0),
            clientsWithTail: entries.filter((entry) =>
              entry.items.some((event) => event.type === "message" && event.messageID === tail.lastMessageID),
            ).length,
            tailBatchFrames,
            ...connectionActivity(runtimes[0].runtimeID),
            ...lastLongBatch,
          })
        return entries
      },
      (entries) =>
        entries.every((entry) =>
          entry.items.some((event) => event.type === "message" && event.messageID === tail.lastMessageID),
        ),
    )
    expect(replayedTail.every((entry) => entry.items.length <= 50)).toBe(true)
    phase("tail-drain", { clients: replayedTail.length, tailBatchFrames, ...lastLongBatch })
    const finalBacklog = await eventually(
      "The post-checkpoint native drafts did not settle",
      () =>
        runtimes[0].request(
          {
            operation: "backlog",
            sessions: sessions.filter((entry) => entry.runtime === 0).map((entry) => entry.sessionID),
          },
          CapacityBacklog,
        ),
      (entry) => entry.drafts === 0 && entry.pendingBatches === 0,
    )
    phase("final-backlog", { drafts: finalBacklog.drafts, pendingBatches: finalBacklog.pendingBatches })
    const finalMetrics = await Promise.all(
      runtimes.map((runtime, index) =>
        runtime.request(
          {
            operation: "backlog",
            sessions: sessions.filter((entry) => entry.runtime === index).map((entry) => entry.sessionID),
          },
          CapacityBacklog,
        ),
      ),
    )
    timings.totalMs = performance.now() - started
    phase("final-report", { runtimes: finalMetrics.length, clients: replays.length, totalMs: timings.totalMs })
    const osSamples = await osMemory.snapshot()
    const nativeMetrics = [serviceMetrics.snapshot(), ...finalMetrics.map((entry) => entry.metrics)]
    const processes = nativeMetrics.map((entry) => {
      const os = osSamples.find((sample) => sample.pid === entry.pid)
      if (!os || !os.samples || os.identityChanged)
        throw new Error("Capacity OS peak has no stable original process samples")
      return {
        ...entry,
        runtimeReportedPeakRSS: entry.peakRSS,
        peakRSS: os.peakRSS,
        rss: os,
        heapSource: "process.memoryUsage",
      }
    })
    const report = {
      sample: {
        producerTransactionMessages: 100,
        clients: clients.length,
        runtimes: runtimes.length,
        sessions: sessions.length,
        longHistory: history.count,
        attachmentBytes: attachment.bytes,
      },
      timings,
      backlog: { queuedDrafts: queued.drafts, queuedBatches: queued.pendingBatches, finalDrafts: finalBacklog.drafts },
      wire: { ...wire, blobOffsets: [...wire.blobOffsets] },
      firstScreen,
      api,
      replays,
      attachment: { downloadedBytes, maxDownloadChunk },
      processes,
    }
    console.log(`CAPACITY_SYNC_REPORT ${JSON.stringify(report)}`)
    if (process.env.SYNERGY_TEST_CAPACITY_REPORT)
      await Bun.write(process.env.SYNERGY_TEST_CAPACITY_REPORT, `${JSON.stringify(report, null, 2)}\n`)
    phase("completed", {
      clients: clients.length,
      sessions: sessions.length,
      messages: history.count,
      totalMs: timings.totalMs,
    })
  } catch (error) {
    console.error(
      "CAPACITY_PHASE_FAILURE",
      JSON.stringify({ phase: observedPhase, elapsedMs: performance.now() - observedAt }),
    )
    failed = { error }
    console.error("CAPACITY_SYNC_FAILURE", error)
    console.error("CAPACITY_OS_PEAKS", JSON.stringify(await osMemory.snapshot()))
  }
  phase("cleanup")
  try {
    await resources.close()
    phase("cleanup-complete")
  } catch (cleanup) {
    console.error("CAPACITY_SYNC_CLEANUP_FAILURE", cleanup)
    if (failed)
      throw new AggregateError([failed.error, cleanup], "Capacity workload and owned cleanup both failed", {
        cause: failed.error,
      })
    throw cleanup
  }
  if (failed) throw failed.error
}, 600000)
