import { z } from "zod"
import { RuntimeContext } from "../lifecycle/context"

export namespace SnapshotLink {
  const prefix = Buffer.from("\0SynergySnapshotLink\0")
  const target = z
    .string()
    .min(1)
    .max(32_768)
    .refine((value) => !value.includes("\0"))
  const envelope = z
    .object({
      version: z.literal(1),
      kind: z.enum(["file", "dir", "junction"]),
      target,
    })
    .strict()
  export type Kind = z.infer<typeof envelope>["kind"]
  export interface Link {
    target: string
    kind?: Kind
  }
  export interface Host {
    type(filename: string): Kind | undefined
  }
  const state = RuntimeContext.state(() => ({ host: undefined as Host | undefined }))

  export function register(host: Host) {
    RuntimeContext.assertCompositionOpen("Snapshot links")
    if (state().host) throw new Error("Snapshot link Host is already registered")
    state().host = host
  }

  export function capture(filename: string, value: string) {
    const kind = state().host?.type(filename)
    if (process.platform === "win32" && !kind) throw new Error("Snapshot link native kind is unavailable")
    return encode({ target: value, kind })
  }

  export function encode(link: Link): Buffer {
    target.parse(link.target)
    if (!link.kind) return Buffer.from(link.target)
    return Buffer.concat([prefix, Buffer.from(JSON.stringify(envelope.parse({ version: 1, ...link })))])
  }

  export function decode(bytes: Uint8Array): Link {
    if (bytes.byteLength > 256 * 1024) throw new Error("Snapshot link exceeds its size limit")
    const input = Buffer.from(bytes)
    const encoded = input.subarray(0, prefix.length).equals(prefix)
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      encoded ? input.subarray(prefix.length) : input,
    )
    if (encoded) return envelope.parse(JSON.parse(text))
    return { target: target.parse(text) }
  }

  export function display(link: Link) {
    const label =
      link.kind === "junction"
        ? "Junction"
        : link.kind === "dir"
          ? "Directory symbolic link"
          : link.kind === "file"
            ? "File symbolic link"
            : "Symbolic link"
    return `${label}: ${JSON.stringify(link.target)}`
  }
}
