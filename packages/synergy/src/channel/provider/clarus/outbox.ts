import z from "zod"
import { Storage } from "@/storage/storage"
import { StoragePath } from "@/storage/path"
import { Lock } from "@/util/lock"
import { parseClarusRequestFailure } from "./agent-tunnel-port"

const Record = z.object({
  requestID: z.string(),
  projectID: z.string(),
  content: z.string(),
  state: z.enum(["pending", "acknowledged", "not_dispatched", "rejected", "ambiguous"]),
  responseMessageID: z.string().optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
})

export type ClarusOutboxRecord = z.infer<typeof Record>

type Send = (input: { requestID: string; projectID: string; content: string }) => Promise<{ messageID: string }>

function hash(value: string): string {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex")
}

async function dispatch(input: {
  key: string[]
  record: ClarusOutboxRecord
  send: Send
}): Promise<{ messageID: string }> {
  try {
    const result = await input.send({
      requestID: input.record.requestID,
      projectID: input.record.projectID,
      content: input.record.content,
    })
    await Storage.write(input.key, {
      ...input.record,
      state: "acknowledged",
      responseMessageID: result.messageID,
      updatedAt: Date.now(),
    } satisfies ClarusOutboxRecord)
    return result
  } catch (error) {
    const failure = parseClarusRequestFailure(error)
    await Storage.write(input.key, {
      ...input.record,
      state: failure?.disposition ?? "ambiguous",
      updatedAt: Date.now(),
    } satisfies ClarusOutboxRecord)
    throw error
  }
}

export namespace ClarusOutbox {
  export async function enqueue(input: {
    accountHash: string
    projectID: string
    content: string
    send: Send
  }): Promise<{ messageID: string }> {
    const recordID = crypto.randomUUID()
    const now = Date.now()
    const record: ClarusOutboxRecord = {
      requestID: crypto.randomUUID(),
      projectID: input.projectID,
      content: input.content,
      state: "pending",
      createdAt: now,
      updatedAt: now,
    }
    const key = StoragePath.clarusProviderMessageOutbox(input.accountHash, hash(recordID))
    await Storage.write(key, record)
    return dispatch({ key, record, send: input.send })
  }

  export async function recover(input: { accountHash: string; send: Send }): Promise<void> {
    using _ = await Lock.write(`channel:clarus:outbox:${input.accountHash}`)
    const recordHashes = await Storage.scan(StoragePath.clarusProviderMessageOutboxRoot(input.accountHash))
    for (const recordHash of recordHashes) {
      const key = StoragePath.clarusProviderMessageOutbox(input.accountHash, recordHash)
      const record = await Storage.read<unknown>(key)
        .then((value) => Record.parse(value))
        .catch(() => undefined)
      if (!record) continue
      if (record.state === "pending") {
        await Storage.write(key, { ...record, state: "ambiguous", updatedAt: Date.now() })
        continue
      }
      if (record.state !== "not_dispatched") continue

      const retry: ClarusOutboxRecord = {
        ...record,
        requestID: crypto.randomUUID(),
        state: "pending",
        updatedAt: Date.now(),
      }
      await Storage.write(key, retry)
      await dispatch({ key, record: retry, send: input.send }).catch(() => undefined)
    }
  }
}
