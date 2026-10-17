import { expect, spyOn, test } from "bun:test"
import { Storage } from "../../src/storage/storage"
import { HostConnection } from "../../src/host/connection"
import { testRuntime } from "../support/runtime"
import { tmpdir } from "../support/fixture"

test("pairing requires target confirmation and rejects replay, tampering and revoked authority", async () => {
  await using source = await testRuntime()
  await using target = await testRuntime()
  const descriptor = await target.run(() => HostConnection.configure("fixture", { enabled: true, name: "Target" }))
  const requester = await source.run(() => HostConnection.configure("fixture", { enabled: true, name: "Source" }))
  const invite = await target.run(() => HostConnection.invite())
  const request = await source.run(() => HostConnection.pairRequest(descriptor, invite.code))
  const pending = await target.run(() => HostConnection.receivePair(request))
  for (const runtime of [source, target]) {
    const records = await runtime.run(async () => {
      const values = []
      for await (const record of Storage.records({ prefix: ["host_connection"] })) values.push(record.value)
      return values
    })
    expect(JSON.stringify(records)).not.toContain(invite.code)
  }
  await expect(source.run(() => HostConnection.acceptPair(descriptor, pending))).rejects.toThrow("approved")
  const approved = await target.run(() => HostConnection.approve(pending.requestID))
  await source.run(() => HostConnection.acceptPair(descriptor, approved))
  const packet = await source.run(() =>
    HostConnection.signRequest(
      descriptor.id,
      "POST",
      "/session-transfer/prepare",
      "application/json",
      new Uint8Array([1, 2]),
    ),
  )
  await expect(
    target.run(() =>
      HostConnection.authorize(packet, "POST", "/session-transfer/prepare", "application/json", new Uint8Array([1, 2])),
    ),
  ).resolves.toMatchObject({ id: requester.id })
  await expect(
    target.run(() =>
      HostConnection.authorize(packet, "POST", "/session-transfer/prepare", "application/json", new Uint8Array([1, 2])),
    ),
  ).rejects.toThrow("replayed")
  const changed = await source.run(() =>
    HostConnection.signRequest(
      descriptor.id,
      "POST",
      "/session-transfer/prepare",
      "application/json",
      new Uint8Array([1, 2]),
    ),
  )
  await expect(
    target.run(() =>
      HostConnection.authorize(
        changed,
        "POST",
        "/session-transfer/prepare",
        "application/json",
        new Uint8Array([2, 1]),
      ),
    ),
  ).rejects.toThrow("signature")
  await target.run(() => HostConnection.revoke(requester.id))
  await expect(target.run(() => HostConnection.approve(pending.requestID))).rejects.toThrow("revoked")
  await expect(
    target.run(() =>
      HostConnection.authorize(
        changed,
        "POST",
        "/session-transfer/prepare",
        "application/json",
        new Uint8Array([1, 2]),
      ),
    ),
  ).rejects.toThrow("paired")
}, 30_000)

test("pairing identity and authority survive restart but the gateway waits for its owner to activate", async () => {
  await using home = await tmpdir()
  await using source = await testRuntime()
  let target = await testRuntime({ home: home.path })
  try {
    const descriptor = await target.run(() => HostConnection.configure("fixture", { enabled: true, name: "Target" }))
    await source.run(() => HostConnection.configure("fixture", { enabled: true, name: "Source" }))
    const invite = await target.run(() => HostConnection.invite())
    const request = await source.run(() => HostConnection.pairRequest(descriptor, invite.code))
    await target.run(() => HostConnection.receivePair(request))
    const receipt = await target.run(() => HostConnection.approve(request.requestID))
    await source.run(() => HostConnection.acceptPair(descriptor, receipt))
    const beforeRestart = await source.run(() =>
      HostConnection.signRequest(descriptor.id, "GET", "/global/health", "", new Uint8Array()),
    )
    await target.run(() => HostConnection.authorize(beforeRestart, "GET", "/global/health", "", new Uint8Array()))
    await target.close()
    target = await testRuntime({ home: home.path })
    await expect(target.run(() => HostConnection.describe())).rejects.toThrow("disabled")
    expect(await target.run(() => HostConnection.configure("fixture", { enabled: true, name: "Target" }))).toEqual(
      descriptor,
    )
    await expect(
      target.run(() => HostConnection.authorize(beforeRestart, "GET", "/global/health", "", new Uint8Array())),
    ).rejects.toThrow("replayed")
    const proof = await source.run(() =>
      HostConnection.signRequest(descriptor.id, "GET", "/global/health", "", new Uint8Array()),
    )
    await expect(
      target.run(() => HostConnection.authorize(proof, "GET", "/global/health", "", new Uint8Array())),
    ).resolves.toMatchObject({ id: request.requester.id })
    await target.run(() => HostConnection.disableOwner("fixture"))
    await expect(target.run(() => HostConnection.describe())).rejects.toThrow("disabled")
  } finally {
    await target.close()
  }
}, 30_000)

test("five wrong codes invalidate an invitation and expired requests cannot be accepted", async () => {
  await using source = await testRuntime()
  await using target = await testRuntime()
  const descriptor = await target.run(() => HostConnection.configure("fixture", { enabled: true, name: "Target" }))
  await source.run(() => HostConnection.configure("fixture", { enabled: true, name: "Source" }))
  const invite = await target.run(() => HostConnection.invite())
  for (let i = 0; i < 5; i++) {
    const request = await source.run(() => HostConnection.pairRequest(descriptor, "incorrect"))
    await expect(target.run(() => HostConnection.receivePair(request))).rejects.toThrow("code")
  }
  const request = await source.run(() => HostConnection.pairRequest(descriptor, invite.code))
  await expect(target.run(() => HostConnection.receivePair(request))).rejects.toThrow("code")
  await expect(target.run(() => HostConnection.receivePair({ ...request, expiresAt: Date.now() - 1 }))).rejects.toThrow(
    "signature",
  )
}, 30_000)

test("pairing codes are single-use and closing the gateway preserves local records", async () => {
  await using source = await testRuntime()
  await using target = await testRuntime()
  const descriptor = await target.run(() => HostConnection.configure("fixture", { enabled: true, name: "Target" }))
  await source.run(() => HostConnection.configure("fixture", { enabled: true, name: "Source" }))
  const invite = await target.run(() => HostConnection.invite())
  const request = await source.run(() => HostConnection.pairRequest(descriptor, invite.code))
  await target.run(() => HostConnection.receivePair(request))
  await expect(target.run(() => HostConnection.receivePair(request))).rejects.toThrow("code")
  await target.run(() => HostConnection.configure("fixture", { enabled: false, name: "Target" }))
  await expect(target.run(() => HostConnection.describe())).rejects.toThrow("disabled")
  await expect(target.run(() => HostConnection.approve(request.requestID))).rejects.toThrow("disabled")
}, 30_000)

test("pending admissions reject revocation, gateway replacement and an old pairing identity", async () => {
  await using source = await testRuntime()
  await using target = await testRuntime()
  const descriptor = await target.run(() => HostConnection.configure("fixture", { enabled: true, name: "Target" }))
  const requester = await source.run(() => HostConnection.configure("fixture", { enabled: true, name: "Source" }))
  const pair = async () => {
    const invitation = await target.run(() => HostConnection.invite())
    const request = await source.run(() => HostConnection.pairRequest(descriptor, invitation.code))
    await target.run(() => HostConnection.receivePair(request))
    const receipt = await target.run(() => HostConnection.approve(request.requestID))
    await source.run(() => HostConnection.acceptPair(descriptor, receipt))
    return request.pairID
  }
  const first = await pair()
  const released = await target.run(() => HostConnection.admit(requester.id, first))
  released[Symbol.dispose]()
  using revoked = await target.run(() => HostConnection.admit(requester.id, first))
  released[Symbol.dispose]()
  await target.run(() => HostConnection.revoke(requester.id))
  expect(() => revoked.assert()).toThrow()
  const second = await pair()
  await expect(target.run(() => HostConnection.admit(requester.id, first))).rejects.toThrow()
  using replaced = await target.run(() => HostConnection.admit(requester.id, second))
  await target.run(() => HostConnection.disableOwner("fixture"))
  await target.run(() => HostConnection.configure("fixture", { enabled: true, name: "Target" }))
  expect(() => replaced.assert()).toThrow()
  expect((await target.run(() => HostConnection.peers())).map((peer) => peer.id)).toEqual([requester.id])
}, 30_000)

test("bounded body reads cancel a pending reader on an external abort", async () => {
  let cancelled = false
  const started = Promise.withResolvers<void>()
  const body = new ReadableStream<Uint8Array>(
    {
      pull() {
        started.resolve()
      },
      cancel() {
        cancelled = true
      },
    },
    { highWaterMark: 0 },
  )
  const controller = new AbortController()
  const reading = HostConnection.readBody(new Response(body), 32768, controller.signal)
  await started.promise
  controller.abort(new Error("upload stopped"))
  await expect(reading).rejects.toThrow("upload stopped")
  expect(cancelled).toBe(true)
})

test.each(["configure", "invite", "pairRequest", "receivePair", "approve", "acceptPair", "revoke"] as const)(
  "%s rolls back staged authority records when cancelled before transaction completion",
  async (mutation) => {
    await using source = await testRuntime()
    await using target = await testRuntime()
    const descriptor = await target.run(() => HostConnection.configure("fixture", { enabled: true, name: "Target" }))
    await source.run(() => HostConnection.configure("fixture", { enabled: true, name: "Source" }))
    const invitation = await target.run(() => HostConnection.invite())
    const pairing = await source.run(() => HostConnection.pairRequest(descriptor, invitation.code))
    if (mutation !== "receivePair") await target.run(() => HostConnection.receivePair(pairing))
    const receipt =
      mutation === "acceptPair" || mutation === "revoke"
        ? await target.run(() => HostConnection.approve(pairing.requestID))
        : undefined
    if (mutation === "revoke") await source.run(() => HostConnection.acceptPair(descriptor, receipt!))
    const selected = mutation === "pairRequest" || mutation === "acceptPair" || mutation === "revoke" ? source : target
    await selected.run(async () => {
      const records = async () => {
        const records = []
        for await (const record of Storage.records({ prefix: ["host_connection"] })) records.push(record)
        return records
      }
      const before = await records()
      const controller = new AbortController()
      const write = Storage.write
      const remove = Storage.remove
      using _write = spyOn(Storage, "write").mockImplementation(async (key, content) => {
        const written = await write(key, content)
        if (key[0] === "host_connection") controller.abort(new Error("authority withdrawn before commit"))
        return written
      })
      using _remove = spyOn(Storage, "remove").mockImplementation(async (key) => {
        const removed = await remove(key)
        if (key[0] === "host_connection") controller.abort(new Error("authority withdrawn before commit"))
        return removed
      })
      const assertAuthority = () => controller.signal.throwIfAborted()
      const mutations = {
        configure: () => HostConnection.configure("fixture", { enabled: false, name: "Changed" }, assertAuthority),
        invite: () => HostConnection.invite(assertAuthority),
        pairRequest: () => HostConnection.pairRequest(descriptor, invitation.code, assertAuthority),
        receivePair: () => HostConnection.receivePair(pairing, assertAuthority),
        approve: () => HostConnection.approve(pairing.requestID, assertAuthority),
        acceptPair: () => HostConnection.acceptPair(descriptor, receipt!, assertAuthority),
        revoke: () => HostConnection.revoke(descriptor.id, assertAuthority),
      }
      await expect(mutations[mutation]()).rejects.toThrow("authority withdrawn before commit")
      expect(await records()).toEqual(before)
    })
  },
  30_000,
)
