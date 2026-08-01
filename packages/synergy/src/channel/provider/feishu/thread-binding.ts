import z from "zod"
import { Storage } from "@/storage/storage"
import { StoragePath } from "@/storage/path"

const Record = z
  .object({
    version: z.literal(1),
    scopeKey: z.string().min(1),
    createdAt: z.number(),
  })
  .strict()

export namespace FeishuThreadBinding {
  export async function get(input: {
    accountId: string
    chatId: string
    threadId: string
  }): Promise<string | undefined> {
    const stored = await Storage.read<unknown>(
      StoragePath.channelFeishuThreadBinding(input.accountId, input.chatId, input.threadId),
    ).catch(() => undefined)
    const parsed = Record.safeParse(stored)
    return parsed.success ? parsed.data.scopeKey : undefined
  }

  export async function set(input: {
    accountId: string
    chatId: string
    threadId: string
    scopeKey: string
  }): Promise<void> {
    await Storage.write(StoragePath.channelFeishuThreadBinding(input.accountId, input.chatId, input.threadId), {
      version: 1,
      scopeKey: input.scopeKey,
      createdAt: Date.now(),
    } satisfies z.infer<typeof Record>)
  }
}
