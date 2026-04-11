import z from "zod"
import { Bus } from "@/bus"
import { BusEvent } from "@/bus/bus-event"
import { Storage } from "@/storage/storage"
import { StoragePath } from "@/storage/path"
import { Log } from "@/util/log"

const log = Log.create({ service: "holos.contact" })

export namespace Contact {
  export const Config = z.object({
    autoReply: z.boolean().describe("Allow the agent to automatically reply to messages from this contact"),
    autoInitiate: z.boolean().describe("Allow the agent to proactively send messages to this contact"),
    blocked: z.boolean().describe("Block all messages from this contact"),
    maxAutoTurns: z.number().default(10).describe("Maximum consecutive auto-replies without human intervention"),
  })
  export type Config = z.infer<typeof Config>

  export const Info = z
    .object({
      id: z.string().describe("Local contact identifier"),
      holosId: z.string().optional().describe("Holos platform ID (when available)"),
      name: z.string().describe("Display name"),
      bio: z.string().optional().describe("Short bio"),
      status: z.enum(["active", "blocked"]).default("active"),
      addedAt: z.number().describe("Timestamp when contact was added"),
      config: Config.default({
        autoReply: false,
        autoInitiate: false,
        blocked: false,
        maxAutoTurns: 10,
      }),
    })
    .meta({ ref: "Contact" })
  export type Info = z.infer<typeof Info>

  export const Event = {
    Added: BusEvent.define("holos.contact.added", z.object({ contact: Info })),
    Removed: BusEvent.define("holos.contact.removed", z.object({ id: z.string() })),
    Updated: BusEvent.define("holos.contact.updated", z.object({ contact: Info })),
    ConfigUpdated: BusEvent.define("holos.contact.config_updated", z.object({ contact: Info })),
  }

  const DEFAULT_CONFIG: Config = {
    autoReply: false,
    autoInitiate: false,
    blocked: false,
    maxAutoTurns: 10,
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

  export async function add(contact: Omit<Info, "config"> & { config?: Config }): Promise<Info> {
    const withConfig: Info = { ...contact, config: contact.config ?? DEFAULT_CONFIG }
    await Storage.write(StoragePath.holosContact(withConfig.id), withConfig)
    await Bus.publish(Event.Added, { contact: withConfig })
    log.info("contact added", { id: withConfig.id, name: withConfig.name })
    return withConfig
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

  export async function updateConfig(id: string, config: Partial<Config>): Promise<Info> {
    const contact = await get(id)
    if (!contact) throw new Error(`Contact ${id} not found`)
    const updated: Info = {
      ...contact,
      config: { ...contact.config, ...config },
    }
    await Storage.write(StoragePath.holosContact(id), updated)
    await Bus.publish(Event.ConfigUpdated, { contact: updated })
    log.info("contact config updated", { id, config })
    return updated
  }
}
