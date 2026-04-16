import z from "zod"
import { Bus } from "@/bus"
import { BusEvent } from "@/bus/bus-event"
import { Storage } from "@/storage/storage"
import { StoragePath } from "@/storage/path"
import { Log } from "@/util/log"

const log = Log.create({ service: "holos.friend-request" })

export namespace FriendRequest {
  export const Status = z.enum(["pending", "accepted", "rejected", "pending_delivery"])
  export type Status = z.infer<typeof Status>

  export const Direction = z.enum(["incoming", "outgoing"])
  export type Direction = z.infer<typeof Direction>

  export const Info = z
    .object({
      id: z.string().describe("Request identifier"),
      direction: Direction.describe("Whether this request was sent or received"),
      peerId: z.string().describe("Holos ID of the other party"),
      peerName: z.string().optional().describe("Display name of the other party"),
      peerBio: z.string().optional().describe("Short bio of the other party"),
      status: Status.default("pending"),
      createdAt: z.number().describe("Timestamp when request was created"),
      respondedAt: z.number().optional().describe("Timestamp when request was accepted/rejected"),
    })
    .meta({ ref: "FriendRequest" })
  export type Info = z.infer<typeof Info>

  export const Event = {
    Created: BusEvent.define("holos.friend_request.created", z.object({ request: Info })),
    Updated: BusEvent.define("holos.friend_request.updated", z.object({ request: Info })),
    Removed: BusEvent.define("holos.friend_request.removed", z.object({ id: z.string() })),
  }

  export async function list(): Promise<Info[]> {
    const keys = await Storage.list(StoragePath.holosFriendRequestsRoot())
    const requests: Info[] = []
    for (const key of keys) {
      try {
        const request = await Storage.read<Info>(key)
        if (request) requests.push(request)
      } catch {
        continue
      }
    }
    return requests
  }

  export async function get(id: string): Promise<Info | undefined> {
    try {
      return await Storage.read<Info>(StoragePath.holosFriendRequest(id))
    } catch {
      return undefined
    }
  }

  export async function create(request: Info): Promise<Info> {
    await Storage.write(StoragePath.holosFriendRequest(request.id), request)
    await Bus.publish(Event.Created, { request })
    log.info("friend request created", { id: request.id, direction: request.direction, peerId: request.peerId })
    return request
  }

  export async function respond(id: string, status: "accepted" | "rejected"): Promise<Info> {
    const request = await get(id)
    if (!request) throw new Error(`Friend request ${id} not found`)

    const updated: Info = {
      ...request,
      status,
      respondedAt: Date.now(),
    }
    await Storage.write(StoragePath.holosFriendRequest(id), updated)
    await Bus.publish(Event.Updated, { request: updated })
    log.info("friend request responded", { id, status })
    return updated
  }

  export async function remove(id: string): Promise<void> {
    await Storage.remove(StoragePath.holosFriendRequest(id))
    await Bus.publish(Event.Removed, { id })
    log.info("friend request removed", { id })
  }
}
