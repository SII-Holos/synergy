import { Storage } from "@/storage/storage"
import { StoragePath } from "@/storage/path"
import type { ClarusMessageDedupEntry } from "./schemas"
import { ClarusMessageDedupEntryV2 } from "./schemas"
import { dedupMessageKey, dedupTaskMessageKey, validateSegment } from "./keys"

/** Durable message deduplication for Clarus project/task messages. */
export namespace ClarusDedup {
  export async function getMessage(
    agentId: string,
    projectId: string,
    messageId: string,
  ): Promise<ClarusMessageDedupEntry | undefined> {
    validateSegment(agentId)
    validateSegment(projectId)
    validateSegment(messageId)
    const key = dedupMessageKey(agentId, projectId, messageId)
    const raw = await Storage.read<unknown>(StoragePath.clarusDedupMessage(key)).catch(() => undefined)
    if (!raw || typeof raw !== "object") return undefined
    const parsed = ClarusMessageDedupEntryV2.safeParse(raw)
    return parsed.success ? parsed.data : undefined
  }

  export async function recordMessage(
    agentId: string,
    projectId: string,
    messageId: string,
    entry: ClarusMessageDedupEntry,
  ): Promise<void> {
    const key = dedupMessageKey(agentId, projectId, messageId)
    await Storage.write(StoragePath.clarusDedupMessage(key), entry)
  }

  export async function getTaskMessage(
    agentId: string,
    projectId: string,
    taskId: string,
    messageId: string,
  ): Promise<ClarusMessageDedupEntry | undefined> {
    validateSegment(agentId)
    validateSegment(projectId)
    validateSegment(taskId)
    validateSegment(messageId)
    const key = dedupTaskMessageKey(agentId, projectId, taskId, messageId)
    const raw = await Storage.read<unknown>(StoragePath.clarusDedupMessage(key)).catch(() => undefined)
    if (!raw || typeof raw !== "object") return undefined
    const parsed = ClarusMessageDedupEntryV2.safeParse(raw)
    return parsed.success ? parsed.data : undefined
  }

  export async function recordTaskMessage(
    agentId: string,
    projectId: string,
    taskId: string,
    messageId: string,
    entry: ClarusMessageDedupEntry,
  ): Promise<void> {
    const key = dedupTaskMessageKey(agentId, projectId, taskId, messageId)
    await Storage.write(StoragePath.clarusDedupMessage(key), entry)
  }
}
