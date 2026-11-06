import type { MessageV2 } from "@ericsanchezok/synergy-harness/session/message-v2"
import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { closeSync, openSync, read, unlinkSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"

const readAt = promisify(read)

type Identity = { scopeID: string; sessionID: string; messageID: string; partID: string }
export function createProjectionContent(budget = 64 * 1024 * 1024) {
  type Body = { part: MessageV2.Part } | { file: number; ready: Promise<number>; readers: number; removed: boolean }
  const entries = new Map<string, Identity & { body: Body; version: string; bytes: number }>()
  let bytes = 0
  let spooled = 0
  const close = (body: Extract<Body, { file: number }>) => {
    if (!body.removed || body.readers || body.file < 0) return
    closeSync(body.file)
    body.file = -1
  }
  const remove = (token: string) => {
    const entry = entries.get(token)
    if (!entry) return
    bytes -= entry.bytes
    entries.delete(token)
    if ("file" in entry.body) {
      spooled--
      const body = entry.body
      body.removed = true
      void body.ready.finally(() => close(body)).catch(() => {})
    }
  }
  return {
    retain(identity: Identity, part: MessageV2.Part, content: { version: string; bytes: number }) {
      const token = crypto.randomUUID()
      const size = content.bytes * 2
      let body: Body
      if (size <= budget) body = { part: structuredClone(part) }
      else {
        const filename = path.join(os.tmpdir(), `synergy-projection-${token}`)
        const file = openSync(filename, "wx+", 0o600)
        unlinkSync(filename)
        body = { file, ready: Bun.write(Bun.file(file), JSON.stringify(part)), readers: 0, removed: false }
        void body.ready.catch(() => remove(token))
        spooled++
      }
      const memory = "part" in body ? size : 0
      entries.set(token, { ...identity, body, version: content.version, bytes: memory })
      bytes += memory
      for (const key of entries.keys()) {
        if (bytes <= budget && spooled <= 16) break
        remove(key)
      }
      return { token, release: () => remove(token) }
    },
    async read(identity: Identity, token: string) {
      const entry = entries.get(token)
      if (
        !entry ||
        entry.scopeID !== identity.scopeID ||
        entry.sessionID !== identity.sessionID ||
        entry.messageID !== identity.messageID ||
        entry.partID !== identity.partID
      )
        throw new Storage.NotFoundError({ message: "Content checkpoint expired" })
      if ("part" in entry.body) return { part: entry.body.part, version: entry.version }
      const body = entry.body
      body.readers++
      try {
        const buffer = Buffer.alloc(await body.ready)
        let offset = 0
        while (offset < buffer.length) {
          const { bytesRead } = await readAt(body.file, buffer, offset, buffer.length - offset, offset)
          if (!bytesRead) throw new Storage.NotFoundError({ message: "Content checkpoint incomplete" })
          offset += bytesRead
        }
        return { part: JSON.parse(buffer.toString()) as MessageV2.Part, version: entry.version }
      } finally {
        body.readers--
        close(body)
      }
    },
    get bytes() {
      return bytes
    },
    get size() {
      return entries.size
    },
  }
}
export const projectionContent = RuntimeContext.state(() => createProjectionContent())
