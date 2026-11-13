import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { RolloutArtifact } from "@ericsanchezok/synergy-harness/session/rollout/artifact"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { OrganizationRuntimeProtocol as Runtime } from "@ericsanchezok/synergy-organization-protocol"
import { z } from "zod"
import { openMemberConnection } from "../src/connection"
import { executionFixture } from "./support/execution"

test("actual native attachment bytes finish their original WSS blob acknowledgements before the final batch", async () => {
  await using f = await executionFixture()
  const options = { headers: f.headers, throwOnError: true as const }
  const transport = { frames: 0, fragments: 0, maxIndex: -1, maxPendingFrames: 0, maxPendingBytes: 0 }
  f.interceptFrames((socket, raw) => {
    const frame = Runtime.ClientFrame.parse(JSON.parse(String(raw)))
    transport.frames++
    transport.maxPendingFrames = Math.max(transport.maxPendingFrames, socket.data.frames)
    transport.maxPendingBytes = Math.max(transport.maxPendingBytes, socket.data.bytes)
    if (frame.type === "blob-chunk") {
      transport.fragments++
      transport.maxIndex = Math.max(transport.maxIndex, frame.index)
    }
    return false
  })
  const closed: Array<{ code: number; reason: string; pendingFrames: number; pendingBytes: number }> = []
  f.observeClose((value) => closed.push(value))
  const shared = (
    await f.client.orgSessions.share(
      { sessionID: f.sessionID, orgShareChange: { expectedShareGeneration: 0 } },
      options,
    )
  ).data
  await f.connection.close()
  await using connection = await openMemberConnection({
    home: f.member.home,
    identity: f.member.identity,
    ca: f.ca,
    buildVersion: "native-blob-tail-fixture",
    sync: true,
  })
  const size = 8 * 1024 * 1024 + 17
  const native = await f.runtime.run(async () => {
    const session = await Session.get(f.sessionID)
    const owner = { kind: "session" as const, scopeID: session.scope.id, sessionID: session.id }
    const artifact = await RolloutArtifact.write(
      owner,
      (async function* () {
        for (let offset = 0; offset < size; offset += 65536)
          yield Buffer.alloc(Math.min(65536, size - offset), (offset / 65536) % 251)
      })(),
      "application/octet-stream",
    )
    if (artifact.status !== "complete" || !artifact.sha256)
      throw new Error("The original native artifact is incomplete")
    return { owner, artifact, hash: artifact.sha256 }
  })
  const phases: Array<{
    offset: number
    bytes: number
    nativeChunks: number
    readMs: number
    uploadMs?: number
    complete?: boolean
    receivedBytes?: number
    errorName?: string
    errorCode?: string
  }> = []
  await f.runtime.run(async () => {
    let offset = 0
    let buffered = 0
    let chunks = 0
    let parts: Uint8Array[] = []
    let readStarted = performance.now()
    async function send() {
      if (!buffered) return
      const phase = { offset, bytes: buffered, nativeChunks: chunks, readMs: performance.now() - readStarted }
      phases.push(phase)
      const uploadStarted = performance.now()
      try {
        const status = await connection.uploadBlob({
          sessionID: f.sessionID,
          shareGeneration: shared.shareGeneration,
          hash: native.hash,
          offset,
          totalBytes: native.artifact.bytes,
          bytes: Buffer.concat(parts),
        })
        Object.assign(phase, {
          uploadMs: performance.now() - uploadStarted,
          complete: status.complete,
          receivedBytes: status.receivedBytes,
        })
        expect(status.receivedBytes).toBe(offset + buffered)
        expect(status.complete).toBe(offset + buffered === size)
      } catch (error) {
        const code =
          typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
            ? error.code
            : undefined
        Object.assign(phase, {
          uploadMs: performance.now() - uploadStarted,
          errorName: error instanceof Error ? error.name : "unknown",
          errorCode: code,
        })
        const response = z
          .object({ data: z.object({ code: z.string(), outcome: z.string().optional() }) })
          .safeParse(error)
        console.error(
          "NATIVE_BLOB_TAIL",
          JSON.stringify({ phase, transport, closed, response: response.success ? response.data.data : undefined }),
        )
        throw error
      }
      offset += buffered
      buffered = 0
      chunks = 0
      parts = []
      readStarted = performance.now()
    }
    for await (const bytes of RolloutArtifact.read(native.owner, native.artifact)) {
      parts.push(bytes)
      buffered += bytes.byteLength
      chunks++
      if (buffered === 4 * 1024 * 1024) await send()
    }
    await send()
    expect(offset).toBe(size)
  })
  expect(phases.map((phase) => phase.offset)).toEqual([0, 4 * 1024 * 1024, 8 * 1024 * 1024])
  const download = await f.client.orgSessionSync.downloadBlob(
    { sessionID: f.sessionID, shareGeneration: shared.shareGeneration, hash: native.hash },
    { ...options, parseAs: "stream" },
  )
  expect(download.response.status).toBe(200)
  const reader = download.response.body!.getReader()
  const digest = createHash("sha256")
  let received = 0
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      digest.update(next.value)
      received += next.value.byteLength
    }
  } finally {
    reader.releaseLock()
  }
  expect(received).toBe(size)
  expect(digest.digest("hex")).toBe(native.hash)
}, 20000)
