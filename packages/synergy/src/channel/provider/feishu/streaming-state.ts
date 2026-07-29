import z from "zod"
import { Storage } from "@/storage/storage"
import { StoragePath } from "@/storage/path"
import { Log } from "@/util/log"

const log = Log.create({ service: "channel.feishu.streaming-state" })
const RECOVERY_SEQUENCE = 2_147_483_647
const REQUEST_TIMEOUT_MS = 15_000
const RECOVERY_SUMMARY = "Session interrupted — server restarted"

const Record = z
  .object({
    version: z.literal(1),
    cardId: z.string().min(1),
    messageId: z.string().min(1),
    startedAt: z.number(),
  })
  .strict()

export type Record = z.infer<typeof Record>

export namespace FeishuStreamingState {
  export async function persist(input: {
    accountId: string
    sessionID: string
    cardId: string
    messageId: string
  }): Promise<void> {
    await Storage.write(StoragePath.channelFeishuStreamingCard(input.accountId, input.sessionID), {
      version: 1,
      cardId: input.cardId,
      messageId: input.messageId,
      startedAt: Date.now(),
    } satisfies Record)
  }

  export async function remove(input: { accountId: string; sessionID: string }): Promise<void> {
    await Storage.remove(StoragePath.channelFeishuStreamingCard(input.accountId, input.sessionID))
  }

  export async function reconcileAccount(input: {
    accountId: string
    apiBase: string
    getAccessToken: () => Promise<string>
  }): Promise<number> {
    const root = StoragePath.channelFeishuStreamingCardAccountRoot(input.accountId)
    const entries = await Storage.scan(root)
    let reconciled = 0

    for (const entry of entries) {
      const key = [...root, entry]
      const stored = await Storage.read<unknown>(key).catch(() => undefined)
      const parsed = Record.safeParse(stored)
      if (!parsed.success) {
        await Storage.remove(key)
        continue
      }

      const record = parsed.data
      try {
        const token = await input.getAccessToken()
        const response = await fetch(`${input.apiBase}/cardkit/v1/cards/${record.cardId}/settings`, {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json; charset=utf-8",
          },
          body: JSON.stringify({
            settings: JSON.stringify({
              config: {
                streaming_mode: false,
                summary: { content: RECOVERY_SUMMARY },
              },
            }),
            sequence: RECOVERY_SEQUENCE,
            uuid: `r_${record.cardId}_${RECOVERY_SEQUENCE}`,
          }),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        })
        const result = await parseResult(response)
        if (!response.ok || result.code !== 0) {
          if (!isTerminal(result)) {
            log.warn("orphaned streaming card recovery failed", {
              accountId: input.accountId,
              cardId: record.cardId,
              status: response.status,
              code: result.code,
              message: result.msg,
            })
            continue
          }
        }

        await Storage.remove(key)
        reconciled++
        log.info("orphaned streaming card reconciled", {
          accountId: input.accountId,
          cardId: record.cardId,
        })
      } catch (error) {
        log.warn("orphaned streaming card recovery failed", {
          accountId: input.accountId,
          cardId: record.cardId,
          error,
        })
      }
    }

    return reconciled
  }

  async function parseResult(response: Response): Promise<{ code?: number; msg?: string }> {
    try {
      return (await response.json()) as { code?: number; msg?: string }
    } catch {
      return { msg: `HTTP ${response.status}` }
    }
  }

  function isTerminal(result: { code?: number; msg?: string }): boolean {
    const message = result.msg?.toLowerCase() ?? ""
    return (
      result.code === 300309 ||
      result.code === 200740 ||
      result.code === 200750 ||
      message.includes("streaming mode is closed") ||
      message.includes("streaming mode already closed") ||
      message.includes("streaming timeout") ||
      message.includes("card expired") ||
      message.includes("card entity does not exist")
    )
  }
}
