import z from "zod"
import { randomBytes } from "crypto"

export namespace Identifier {
  export type ScopeID = string & { readonly __brand: "ScopeID" }
  export type SessionID = string & { readonly __brand: "SessionID" }
  export type MessageID = string & { readonly __brand: "MessageID" }
  export type PartID = string & { readonly __brand: "PartID" }

  export const asScopeID = (s: string) => s as ScopeID
  export const asSessionID = (s: string) => s as SessionID
  export const asMessageID = (s: string) => s as MessageID
  export const asPartID = (s: string) => s as PartID

  const prefixes = {
    session: "ses",
    message: "msg",
    permission: "per",
    question: "que",
    user: "usr",
    part: "prt",
    pty: "pty",
    tool: "tool",
    cortex: "ctx",
    process: "proc",
    memory: "mem",
    agenda: "agd",
    note: "nte",
  } as const

  export function schema(prefix: keyof typeof prefixes) {
    return z.string().startsWith(prefixes[prefix])
  }

  const LENGTH = 26

  let lastTimestamp = 0
  let counter = 0

  export function ascending(prefix: "session", given?: string): SessionID
  export function ascending(prefix: "message", given?: string): MessageID
  export function ascending(prefix: "part", given?: string): PartID
  export function ascending(prefix: keyof typeof prefixes, given?: string): string
  export function ascending(prefix: keyof typeof prefixes, given?: string): string {
    return generateID(prefix, false, given)
  }

  export function descending(prefix: "session", given?: string): SessionID
  export function descending(prefix: "message", given?: string): MessageID
  export function descending(prefix: "part", given?: string): PartID
  export function descending(prefix: keyof typeof prefixes, given?: string): string
  export function descending(prefix: keyof typeof prefixes, given?: string): string {
    return generateID(prefix, true, given)
  }

  function generateID(prefix: keyof typeof prefixes, descending: boolean, given?: string): string {
    if (!given) {
      return create(prefix, descending)
    }

    if (!given.startsWith(prefixes[prefix])) {
      throw new Error(`ID ${given} does not start with ${prefixes[prefix]}`)
    }
    return given
  }

  function randomBase62(length: number): string {
    const chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
    let result = ""
    const bytes = randomBytes(length)
    for (let i = 0; i < length; i++) {
      result += chars[bytes[i] % 62]
    }
    return result
  }

  export function create(prefix: keyof typeof prefixes, descending: boolean, timestamp?: number): string {
    const currentTimestamp = timestamp ?? Date.now()

    if (currentTimestamp !== lastTimestamp) {
      lastTimestamp = currentTimestamp
      counter = 0
    }
    counter++

    let now = BigInt(currentTimestamp) * BigInt(0x1000) + BigInt(counter)

    now = descending ? ~now : now

    const timeBytes = Buffer.alloc(6)
    for (let i = 0; i < 6; i++) {
      timeBytes[i] = Number((now >> BigInt(40 - 8 * i)) & BigInt(0xff))
    }

    return prefixes[prefix] + "_" + timeBytes.toString("hex") + randomBase62(LENGTH - 12)
  }

  export function timestamp(id: string): number {
    const prefix = id.split("_")[0]
    const hex = id.slice(prefix.length + 1, prefix.length + 13)
    const encoded = BigInt("0x" + hex)
    return Number(encoded / BigInt(0x1000))
  }

  let shortCounter = 0

  export function short(prefix: keyof typeof prefixes): string {
    const ts = Date.now().toString(36)
    const seq = (shortCounter++).toString(36).padStart(4, "0")
    return `${prefixes[prefix]}_${ts}${seq}${randomBase62(4)}`
  }
}
