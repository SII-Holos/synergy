import z from "zod"
import { Bus } from "@/bus"
import { BusEvent } from "@/bus/bus-event"
import { Storage } from "@/storage/storage"
import { StoragePath } from "@/storage/path"
import { Log } from "@/util/log"

const log = Log.create({ service: "holos.contact" })

export namespace Contact {
  export const Info = z
    .object({
      id: z.string().describe("Holos Agent ID"),
      name: z.string().describe("Display name"),
      blocked: z.boolean().default(false).describe("Block messages from this contact"),
      addedAt: z.number().describe("Timestamp when contact was added"),
    })
    .meta({ ref: "Contact" })
  export type Info = z.infer<typeof Info>

  export const Event = {
    Added: BusEvent.define("holos.contact.added", z.object({ contact: Info })),
    Removed: BusEvent.define("holos.contact.removed", z.object({ id: z.string() })),
    Updated: BusEvent.define("holos.contact.updated", z.object({ contact: Info })),
  }

  export async function list(): Promise<Info[]> {
    const keys = await Storage.list(StoragePath.holosContactsRoot())
    const contacts: Info[] = []
    for (const key of keys) {
      try {
        const contact = await Storage.read<Info>(key)
        if (contact) contacts.push(contact)
      } catch {
        continue
      }
    }
    return contacts
  }

  export async function get(id: string): Promise<Info | undefined> {
    try {
      return await Storage.read<Info>(StoragePath.holosContact(id))
    } catch {
      return undefined
    }
  }

  export async function add(contact: Omit<Info, "blocked"> & { blocked?: boolean }): Promise<Info> {
    const withDefaults: Info = { ...contact, blocked: contact.blocked ?? false }
    await Storage.write(StoragePath.holosContact(withDefaults.id), withDefaults)
    await Bus.publish(Event.Added, { contact: withDefaults })
    log.info("contact added", { id: withDefaults.id, name: withDefaults.name })
    return withDefaults
  }

  export async function update(contact: Info): Promise<Info> {
    await Storage.write(StoragePath.holosContact(contact.id), contact)
    await Bus.publish(Event.Updated, { contact })
    log.info("contact updated", { id: contact.id, name: contact.name })
    return contact
  }

  export async function remove(id: string): Promise<void> {
    await Storage.remove(StoragePath.holosContact(id))
    await Bus.publish(Event.Removed, { id })
    log.info("contact removed", { id })
  }
}
