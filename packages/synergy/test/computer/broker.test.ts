import { expect, test } from "bun:test"
import { ComputerBroker } from "../../src/computer/broker"
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
test("broker authenticates the native host and correlates results", async () => {
  const broker = new ComputerBroker(token)
  const host = socket()
  expect(() => broker.attach(host, { type: "register", version: 1, token: "b".repeat(64) })).toThrow()
  broker.attach(host, { type: "register", version: 1, token })
  const pending = broker.execute("owner", { type: "apps" })
  const command = JSON.parse(host.messages.at(-1)!)
  broker.handle(host, { type: "result", id: command.id, result: { output: "windows", images: [], metadata: {} } })
  expect((await pending).output).toBe("windows")
  broker.detach(host)
})
test("disconnect and cancellation reject pending work without replay", async () => {
  const broker = new ComputerBroker(token)
  const host = socket()
  broker.attach(host, { type: "register", version: 1, token })
  const abort = new AbortController()
  const pending = broker.execute("owner", { type: "apps" }, abort.signal)
  abort.abort()
  await expect(pending).rejects.toThrow()
  expect(JSON.parse(host.messages.at(-1)!).type).toBe("cancel")
  const lost = broker.execute("owner", { type: "apps" })
  broker.detach(host)
  await expect(lost).rejects.toThrow("disconnected")
  const replacement = socket()
  broker.attach(replacement, { type: "register", version: 1, token })
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
      { type: "register", version: 1, token },
    ),
  ).toThrow("closed")
  const replacement = socket()
  expect(() => broker.attach(replacement, { type: "register", version: 1, token })).not.toThrow()
  broker.detach(replacement)
})
