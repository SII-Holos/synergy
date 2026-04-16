import { describe, expect, test, beforeEach } from "bun:test"
import { Contact } from "../../../src/holos/contact"
import { Instance } from "../../../src/scope/instance"
import { Scope } from "../../../src/scope"
import { tmpdir } from "../../fixture/fixture"

describe("Contact sync update logic", () => {
  async function withInstance(fn: () => Promise<void>) {
    await using tmp = await tmpdir()
    await Instance.provide({
      scope: await tmp.scope(),
      fn,
    })
  }

  test("add new contact", async () => {
    await withInstance(async () => {
      const contact = await Contact.add({
        id: "peer_001",
        holosId: "peer_001",
        name: "Alice",
        bio: "Hello",
        status: "active",
        addedAt: Date.now(),
      })
      expect(contact.name).toBe("Alice")

      const retrieved = await Contact.get("peer_001")
      expect(retrieved).toBeDefined()
      expect(retrieved!.name).toBe("Alice")
    })
  })

  test("update contact name only", async () => {
    await withInstance(async () => {
      const contact = await Contact.add({
        id: "peer_002",
        holosId: "peer_002",
        name: "Bob",
        bio: "Hi",
        status: "active",
        addedAt: Date.now(),
      })

      await Contact.update({ ...contact, name: "Robert" })

      const updated = await Contact.get("peer_002")
      expect(updated!.name).toBe("Robert")
      expect(updated!.bio).toBe("Hi")
    })
  })

  test("update contact bio only", async () => {
    await withInstance(async () => {
      const contact = await Contact.add({
        id: "peer_003",
        holosId: "peer_003",
        name: "Charlie",
        bio: "Old bio",
        status: "active",
        addedAt: Date.now(),
      })

      await Contact.update({ ...contact, bio: "New bio" })

      const updated = await Contact.get("peer_003")
      expect(updated!.name).toBe("Charlie")
      expect(updated!.bio).toBe("New bio")
    })
  })

  test("update preserves fields not being changed", async () => {
    await withInstance(async () => {
      const contact = await Contact.add({
        id: "peer_005",
        holosId: "peer_005",
        name: "Eve",
        bio: "Original bio",
        status: "active",
        addedAt: 1000,
      })

      await Contact.update({ ...contact, name: "Evelyn" })

      const updated = await Contact.get("peer_005")
      expect(updated!.name).toBe("Evelyn")
      expect(updated!.bio).toBe("Original bio")
      expect(updated!.addedAt).toBe(1000)
      expect(updated!.status).toBe("active")
    })
  })

  test("list includes added contacts", async () => {
    await withInstance(async () => {
      await Contact.add({
        id: "peer_list_a",
        holosId: "peer_list_a",
        name: "ListA",
        status: "active",
        addedAt: Date.now(),
      })
      await Contact.add({
        id: "peer_list_b",
        holosId: "peer_list_b",
        name: "ListB",
        status: "active",
        addedAt: Date.now(),
      })

      const contacts = await Contact.list()
      const names = contacts.map((c) => c.name)
      expect(names).toContain("ListA")
      expect(names).toContain("ListB")
    })
  })

  test("remove deletes contact", async () => {
    await withInstance(async () => {
      await Contact.add({
        id: "peer_del",
        holosId: "peer_del",
        name: "ToDelete",
        status: "active",
        addedAt: Date.now(),
      })

      await Contact.remove("peer_del")

      const result = await Contact.get("peer_del")
      expect(result).toBeUndefined()
    })
  })
})
