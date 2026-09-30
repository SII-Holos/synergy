import { COMPUTER_PROTOCOL_VERSION } from "@ericsanchezok/synergy-computer-protocol"
import { expect, test } from "bun:test"
import { ComputerBroker } from "../src/broker"
const token = "a".repeat(64)
function socket() {
  return {
    messages: [] as string[],
    send(x: string) {
      this.messages.push(x)
    },
    close() {},
  }
}
test("broker rejects the retired protocol before attaching a host", () => {
  const broker = new ComputerBroker(token)
  const host = socket()
  expect(() => broker.attach(host, { type: "register", version: 1, token })).toThrow()
  expect(host.messages).toHaveLength(0)
  broker.attach(host, { type: "register", version: COMPUTER_PROTOCOL_VERSION, token })
  broker.detach(host)
})
test("broker authenticates the native host and correlates results", async () => {
  const broker = new ComputerBroker(token)
  const host = socket()
  expect(() =>
    broker.attach(host, { type: "register", version: COMPUTER_PROTOCOL_VERSION, token: "b".repeat(64) }),
  ).toThrow()
  broker.attach(host, { type: "register", version: COMPUTER_PROTOCOL_VERSION, token })
  const pending = broker.execute("owner", { type: "apps" })
  const command = JSON.parse(host.messages.at(-1)!)
  broker.handle(host, { type: "result", id: command.id, result: { output: "windows", images: [], metadata: {} } })
  expect((await pending).output).toBe("windows")
  broker.detach(host)
})
test("disconnect and cancellation reject pending work without replay", async () => {
  const broker = new ComputerBroker(token)
  const host = socket()
  broker.attach(host, { type: "register", version: COMPUTER_PROTOCOL_VERSION, token })
  const abort = new AbortController()
  const pending = broker.execute("owner", { type: "apps" }, abort.signal)
  abort.abort()
  await expect(pending).rejects.toThrow()
  expect(JSON.parse(host.messages.at(-1)!).type).toBe("cancel")
  const lost = broker.execute("owner", { type: "apps" })
  broker.detach(host)
  await expect(lost).rejects.toThrow("disconnected")
  const replacement = socket()
  broker.attach(replacement, { type: "register", version: COMPUTER_PROTOCOL_VERSION, token })
  expect(replacement.messages).toHaveLength(1)
  broker.detach(replacement)
})

test("failed registration acknowledgement does not retain a dead host", () => {
  const broker = new ComputerBroker(token)
  expect(() =>
    broker.attach(
      {
        send() {
          throw new Error("closed")
        },
        close() {},
      },
      { type: "register", version: COMPUTER_PROTOCOL_VERSION, token },
    ),
  ).toThrow("closed")
  const replacement = socket()
  expect(() =>
    broker.attach(replacement, { type: "register", version: COMPUTER_PROTOCOL_VERSION, token }),
  ).not.toThrow()
  broker.detach(replacement)
})

test("only the attached host can complete commands and host errors keep their code", async () => {
  const broker = new ComputerBroker(token)
  const host = socket()
  const stranger = socket()
  await expect(broker.execute("owner", { type: "apps" })).rejects.toThrow("connected local")
  broker.attach(host, { type: "register", version: COMPUTER_PROTOCOL_VERSION, token })
  expect(() => broker.attach(stranger, { type: "register", version: COMPUTER_PROTOCOL_VERSION, token })).toThrow(
    "already connected",
  )
  expect(() => broker.handle(host, { type: "register", version: COMPUTER_PROTOCOL_VERSION, token })).toThrow(
    "already registered",
  )
  const pending = broker.execute("owner", { type: "apps" })
  const { id } = JSON.parse(host.messages.at(-1)!)
  const response = { type: "error", id, code: "permission_denied", message: "Screen recording denied" }
  broker.handle(stranger, response)
  broker.detach(stranger)
  broker.handle(host, response)
  await expect(pending).rejects.toMatchObject({ code: "permission_denied", message: "Screen recording denied" })
  expect(() => broker.handle(host, response)).not.toThrow()
  broker.detach(host)
})

test("dispatch failure cancels the command and rejects without keeping pending work", async () => {
  const broker = new ComputerBroker(token)
  const host = socket()
  broker.attach(host, { type: "register", version: COMPUTER_PROTOCOL_VERSION, token })
  host.send = () => {
    throw new Error("transport closed")
  }
  await expect(broker.execute("owner", { type: "apps" })).rejects.toThrow("while dispatching")
  broker.detach(host)
})
