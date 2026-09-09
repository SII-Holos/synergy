import { expect, test } from "bun:test"
import { Mailbox, setHolosProviderResolver } from "../../src/holos/mailbox"

test("mailbox persists inbound threads and retries failed delivery using the original message identity", async () => {
  const contact = `mailbox-${crypto.randomUUID()}`
  const deliveries: { target: string; event: string; payload: unknown }[] = []
  let available = false
  let accepted = false
  setHolosProviderResolver(async () =>
    available
      ? {
          async send(target, event, payload) {
            deliveries.push({ target, event, payload })
            return accepted ? { sent: true } : { sent: false, reason: "offline" }
          },
        }
      : null,
  )
  try {
    expect(await Mailbox.getThread(contact)).toEqual([])
    const inbound = await Mailbox.receive({
      fromId: contact,
      text: "question",
      messageId: "fixture-inbound",
      source: "human",
    })
    expect(await Mailbox.listContacts("inbox")).toContain(contact)
    expect(await Mailbox.list("inbox")).toContainEqual(inbound)
    const first = await Mailbox.send({ toId: contact, text: "answer", replyToMessageId: inbound.id })
    expect(first).toMatchObject({ sent: false, reason: "no_provider", status: "failed" })
    expect(await Mailbox.retry(first.id)).toMatchObject({ sent: false, reason: "no_provider" })
    available = true
    expect(await Mailbox.retry(first.id)).toMatchObject({ sent: false, reason: "offline" })
    const second = await Mailbox.send({ toId: contact, text: "next" })
    expect(second).toMatchObject({ sent: false, reason: "offline" })
    accepted = true
    expect(await Mailbox.retry(first.id)).toMatchObject({ id: first.id, sent: true, status: "delivered" })
    expect(
      deliveries.filter((delivery) => (delivery.payload as { messageId: string }).messageId === first.id),
    ).toHaveLength(2)
    expect(deliveries[0]).toMatchObject({
      target: contact,
      event: "chat.message",
      payload: { text: "answer", messageId: first.id, replyTo: inbound.id },
    })
    const third = await Mailbox.send({ toId: contact, text: "delivered" })
    expect(third).toMatchObject({ sent: true, status: "delivered" })
    const restored = (await Mailbox.getThread(contact)).find((message) => message.id === first.id)
    expect(restored?.status).toBe("delivered")
    expect(restored?.errorReason).toBeUndefined()
    expect(await Mailbox.listContacts("outbox")).toContain(contact)
    expect((await Mailbox.list("outbox")).filter((message) => message.contactId === contact)).toHaveLength(3)
    await Mailbox.remove(inbound.id)
    await Mailbox.remove(second.id)
    await Mailbox.remove("nonexistent")
    expect((await Mailbox.getThread(contact)).map((message) => message.id).toSorted()).toEqual(
      [first.id, third.id].toSorted(),
    )
    await expect(Mailbox.retry("nonexistent")).rejects.toThrow("not found in outbox")
    await Mailbox.removeThread(contact)
    expect(await Mailbox.getThread(contact)).toEqual([])
  } finally {
    await Mailbox.removeThread(contact)
    setHolosProviderResolver(async () => null)
  }
})
