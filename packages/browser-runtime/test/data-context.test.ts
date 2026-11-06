import { afterAll, afterEach, expect, test } from "bun:test"
import {
  BROWSER_PROTOCOL_VERSION,
  BrowserHostMessageSchema,
  type BrowserHostMessage,
} from "@ericsanchezok/synergy-browser-core"
import { BrowserBroker, type BrowserBrokerSocket } from "../src/broker"
import { BrowserProfiles } from "../src/profiles"
import { BrowserRuntime } from "../src/runtime"
import { testRuntime } from "./support/runtime"

const runtime = await testRuntime()
afterAll(() => runtime.close())
afterEach(() => runtime.run(() => BrowserBroker.resetForTest()))
const owner = { mode: "scope" as const, scopeID: "home", directory: null }

class Socket implements BrowserBrokerSocket {
  sent: BrowserHostMessage[] = []
  send(value: string) {
    const message = BrowserHostMessageSchema.parse(JSON.parse(value))
    this.sent.push(message)
    if (
      message.type === "profile.data.prepare" ||
      message.type === "profile.data.release" ||
      message.type === "profile.data.revoke"
    )
      queueMicrotask(() =>
        BrowserBroker.handle(this, {
          type: "page.result",
          protocolVersion: BROWSER_PROTOCOL_VERSION,
          requestId: message.requestId,
          result: { type: "void" },
        }),
      )
  }
  close() {}
}
function connect() {
  const socket = new Socket()
  BrowserBroker.attach(socket, {
    type: "host.register",
    protocolVersion: BROWSER_PROTOCOL_VERSION,
    hostId: "fixture",
    token: BrowserBroker.secret(),
    capabilities: { native: true },
  })
  return socket
}

test("data contexts use a private authoritative partition without pages or task owners", () =>
  runtime.run(async () => {
    const host = connect()
    const result = await BrowserBroker.dataContext(owner)
    expect(result.profile.kind).toBe("persistent")
    expect(JSON.stringify(result)).not.toContain("partition")
    expect(host.sent.filter((message) => message.type === "profile.data.prepare")).toHaveLength(1)
    expect(host.sent.some((message) => message.type === "page.create")).toBe(false)
    expect(BrowserRuntime.resourceStats()).toMatchObject({ ownerCount: 0, activePageCount: 0, sessionOwnerCount: 0 })
    await expect(BrowserBroker.releaseDataContext({ ...owner, scopeID: "another" }, result.contextId)).rejects.toThrow()
    await BrowserBroker.releaseDataContext(owner, result.contextId)
    expect(
      host.sent.some((message) => message.type === "profile.data.release" && message.contextId === result.contextId),
    ).toBe(true)
  }))

test("revision changes revoke contexts before mutation; defaults never retarget an existing context", () =>
  runtime.run(async () => {
    const host = connect()
    const first = await BrowserBroker.dataContext(owner)
    const other = await BrowserProfiles.create({ name: "Other", kind: "persistent" })
    await BrowserProfiles.setDefault(other.id)
    expect(first.profile.id).not.toBe(other.id)
    await BrowserProfiles.update(first.profile.id, { name: "Updated" })
    expect(
      host.sent.some((message) => message.type === "profile.data.revoke" && message.profileId === first.profile.id),
    ).toBe(true)
    const temporary = await BrowserProfiles.create({ name: "Temporary", kind: "temporary" })
    await expect(BrowserBroker.dataContext(owner, temporary.id)).rejects.toThrow()
    await BrowserProfiles.update(other.id, { enabled: false })
    await expect(BrowserBroker.dataContext(owner, other.id)).rejects.toThrow()
  }))
