import { expect, test } from "bun:test"
import path from "node:path"
import { createHash } from "node:crypto"
import { fileURLToPath } from "node:url"
import { z } from "zod"
import { OrganizationRuntimeProtocol as Protocol } from "@ericsanchezok/synergy-organization-protocol"
import { testResources } from "@ericsanchezok/synergy-testing/resources"
import { prepareMemberHome } from "../src/home"
import { enrollMemberRuntime } from "../src/enrollment"
import { fixture } from "./support/organization"
import {
  CapacityBacklog,
  CapacityMetrics,
  CapacityReply,
  WrittenHistory,
  type CapacityRequest,
} from "./support/capacity-runtime"

type WithoutID<T> = T extends { id: string } ? Omit<T, "id"> : never

async function until<T>(label: string, read: () => Promise<T>, accepts: (value: T) => boolean) {
  const end = Date.now() + 15000
  for (;;) {
    const value = await read()
    if (accepts(value)) return value
    if (Date.now() >= end) throw new Error(`${label}: ${JSON.stringify(value)}`)
    await Bun.sleep(25)
  }
}

for (const [sessionCount, withAttachment] of [
  [2, false],
  [34, false],
  [2, true],
] as const)
  test(`the same resident capacity child publishes a post-checkpoint native fact across ${sessionCount} Sessions and two Scopes with attachment ${withAttachment}`, async () => {
    await using resources = testResources()
    const service = await fixture()
    resources.defer("resident child organization Service", () => service[Symbol.asyncDispose]())
    const options = { headers: service.headers, throwOnError: true as const }
    const home = await prepareMemberHome({
      baseDirectory: path.join(service.root, "members"),
      identity: service.identity,
      origin: service.origin,
    })
    const registration = await enrollMemberRuntime({
      home: home.home,
      identity: home.identity,
      ca: service.ca,
      ticket: await service.ticket(home.identity.deviceID, home.publicKey),
    })
    const sockets = new Set<unknown>()
    let online = false
    const wire = new Map<string, { batches: number; lastSeq: number; connectionEpoch: number }>()
    service.interceptFrames((socket, raw) => {
      const frame = Protocol.ClientFrame.parse(JSON.parse(String(raw)))
      if (frame.type === "handshake" && frame.proof.handshake.runtimeID === registration.runtimeID) sockets.add(socket)
      if (frame.type === "heartbeat" && sockets.has(socket)) online = true
      if (frame.type === "sync-batch" && sockets.has(socket))
        wire.set(frame.batch.sessionID, {
          batches: (wire.get(frame.batch.sessionID)?.batches ?? 0) + 1,
          lastSeq: frame.batch.lastSeq,
          connectionEpoch: frame.connectionEpoch,
        })
      return false
    })
    const pending = new Map<string, ReturnType<typeof Promise.withResolvers<unknown>>>()
    const ready = Promise.withResolvers<number>()
    const child = Bun.spawn({
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
        if (message.type === "progress") return
        if (message.type === "result") return pending.get(message.id)?.resolve(message.result)
        const error = new Error(message.message)
        if (message.id) pending.get(message.id)?.reject(error)
        else ready.reject(error)
      },
    })
    const stderr = (async () => {
      let text = ""
      for await (const chunk of child.stderr)
        if (text.length < 16384)
          text += Buffer.from(chunk)
            .toString()
            .slice(0, 16384 - text.length)
      return text
    })()
    void child.exited.then(async (code) => {
      const error = new Error(`Resident capacity child exited (${code}): ${await stderr}`)
      ready.reject(error)
      for (const request of pending.values()) request.reject(error)
    })
    async function request<T extends z.ZodType>(
      command: WithoutID<CapacityRequest>,
      schema: T,
      timeout = 15000,
    ): Promise<z.output<T>> {
      const id = crypto.randomUUID()
      const reply = Promise.withResolvers<unknown>()
      pending.set(id, reply)
      const timer = setTimeout(
        () => reply.reject(new Error(`Resident child ${command.operation} did not settle`)),
        timeout,
      )
      try {
        child.send({ ...command, id })
        return schema.parse(await reply.promise)
      } finally {
        clearTimeout(timer)
        pending.delete(id)
      }
    }
    resources.defer("original resident capacity child", async () => {
      if (child.exitCode !== null) return
      try {
        await request({ operation: "close" }, CapacityMetrics, 10000)
      } finally {
        if (child.exitCode === null) child.kill()
        await child.exited
      }
    })
    const timer = setTimeout(() => ready.reject(new Error("The original resident child did not open")), 15000)
    const pid = await ready.promise.finally(() => clearTimeout(timer))
    expect(pid).toBe(child.pid)
    expect(pid).not.toBe(process.pid)
    await until("actual child heartbeat not observed", async () => online, Boolean)
    const projects = []
    for (const suffix of ["A", "B"])
      projects.push(
        (await service.client.orgProjects.create({ orgProjectCreate: { name: `Resident Scope ${suffix}` } }, options))
          .data,
      )
    const sessions: Array<{ sessionID: string; projectID: string }> = []
    for (let index = 0; index < sessionCount; index++) {
      const project = projects[index % projects.length]
      const created = (
        await service.client.orgSessions.create(
          {
            orgCommandCreateRequest: {
              schemaVersion: 1,
              orgID: home.identity.orgID,
              projectID: project.projectID,
              runtimeID: registration.runtimeID,
              requestID: `resident-create-${index}`,
              creation: { operation: "create", title: `Resident Session ${index}` },
            },
          },
          options,
        )
      ).data
      sessions.push({ sessionID: created.effect.sessionID, projectID: project.projectID })
    }
    expect(new Set(sessions.map((entry) => entry.projectID)).size).toBe(2)
    expect(new Set(sessions.map((entry) => entry.sessionID)).size).toBe(sessionCount)
    const original = sessions[0]
    const counts = sessions.map((_, index) => (index === 0 ? 32 : 1))
    const initial = await request(
      {
        operation: "append",
        sessions: sessions.map((entry, index) => ({
          sessionID: entry.sessionID,
          count: counts[index],
          ...(index === 0 && withAttachment ? { attachment: true } : {}),
        })),
      },
      z.array(WrittenHistory),
    )
    expect(initial.map((entry) => entry.count)).toEqual(counts)
    const sharedGenerations: number[] = []
    for (const entry of sessions)
      sharedGenerations.push(
        (
          await service.client.orgSessions.share(
            { sessionID: entry.sessionID, orgShareChange: { expectedShareGeneration: 0 } },
            options,
          )
        ).data.shareGeneration,
      )
    await until(
      "original child drafts did not drain",
      () => request({ operation: "backlog", sessions: sessions.map((entry) => entry.sessionID) }, CapacityBacklog),
      (value) => value.drafts === 0 && value.pendingBatches === 0 && value.synced === sessions.length,
    )
    const checkpoint = (
      await service.client.orgSessionSync.snapshot({ sessionID: original.sessionID, limit: 50 }, options)
    ).data
    let cursor: string | undefined
    const initialIDs: string[] = []
    do {
      const page = (
        await service.client.orgSessionSync.messages(
          { sessionID: original.sessionID, limit: 16, cursor, watermark: checkpoint.watermark },
          options,
        )
      ).data
      initialIDs.push(...page.items.map((entry) => entry.messageID))
      cursor = page.cursor
    } while (cursor)
    expect(initialIDs).toHaveLength(counts[0])
    expect(initialIDs).toContain(initial[0].lastMessageID)
    if (withAttachment) {
      const attachment = initial[0].attachment
      if (!attachment) throw new Error("The original capacity child did not publish its attachment")
      expect(attachment.bytes).toBe(8 * 1024 * 1024 + 17)
      expect(attachment.chunks).toBeGreaterThan(1)
      const download = await service.client.orgSessionSync.downloadBlob(
        { sessionID: original.sessionID, hash: attachment.hash, shareGeneration: checkpoint.shareGeneration },
        { ...options, parseAs: "stream" },
      )
      if (!(download.data instanceof ReadableStream)) throw new Error("The native attachment was not streamed")
      const hash = createHash("sha256")
      let bytes = 0
      for await (const value of download.data) {
        const chunk = z.instanceof(Uint8Array).parse(value)
        hash.update(chunk)
        bytes += chunk.byteLength
      }
      expect(bytes).toBe(attachment.bytes)
      expect(hash.digest("hex")).toBe(attachment.hash)
    }
    const before = wire.get(original.sessionID)
    expect(before?.lastSeq).toBe(checkpoint.watermark)
    const tail = (
      await request(
        { operation: "append", sessions: [{ sessionID: original.sessionID, count: 1 }] },
        z.array(WrittenHistory),
      )
    )[0]
    expect(tail.count).toBe(1)
    expect(tail.lastMessageID).not.toBe(initial[0].lastMessageID)
    try {
      const events = await until(
        "the same child did not publish its original post-checkpoint native message",
        async () =>
          (
            await service.client.orgSessionSync.events(
              { sessionID: original.sessionID, limit: 50, cursor: checkpoint.watermark },
              options,
            )
          ).data,
        (page) => page.items.some((event) => event.type === "message" && event.messageID === tail.lastMessageID),
      )
      expect(events.shareGeneration).toBe(sharedGenerations[0])
      expect(events.nextSeq).toBeGreaterThan(checkpoint.watermark + 1)
      expect(wire.get(original.sessionID)?.batches).toBeGreaterThan(before?.batches ?? 0)
      await until(
        "post-checkpoint native obligations did not drain",
        () => request({ operation: "backlog", sessions: sessions.map((entry) => entry.sessionID) }, CapacityBacklog),
        (value) => value.drafts === 0 && value.pendingBatches === 0,
      )
    } catch (error) {
      try {
        const backlog = await request(
          { operation: "backlog", sessions: sessions.map((entry) => entry.sessionID), inspectNative: true },
          CapacityBacklog,
        )
        console.error(
          "CAPACITY_CHILD_POST_CHECKPOINT",
          JSON.stringify({
            drafts: backlog.drafts,
            pendingBatches: backlog.pendingBatches,
            synced: backlog.synced,
            ...backlog.native,
            before,
            after: wire.get(original.sessionID),
          }),
        )
      } catch (diagnosticError) {
        console.error(
          "CAPACITY_CHILD_POST_CHECKPOINT_DIAGNOSTIC",
          diagnosticError instanceof Error ? diagnosticError.name : "unknown",
        )
      }
      throw error
    }
  }, 60000)
