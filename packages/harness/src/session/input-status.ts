import { Session } from "."
import { SessionInbox } from "./inbox"
import { SessionManager } from "./manager"
import { SessionInputProgress } from "./input-progress"
import { MessageV2 } from "./message-v2"
import { RolloutLedger } from "./rollout/ledger"
import { RolloutLifecycle } from "./rollout/lifecycle"
import { Storage } from "../storage/storage"
import { StoragePath } from "../storage/path"
import { Identifier } from "../id/id"

export namespace SessionInputStatus {
  export const Info = SessionInputProgress.Info

  export async function get(input: { sessionID: string; messageID: string }): Promise<SessionInputProgress.Info> {
    const session = await Session.get(input.sessionID)
    return Storage.snapshot(async () => {
      const [message] = await Storage.readMany<MessageV2.Info>([
        StoragePath.messageInfo(
          Identifier.asScopeID(session.scope.id),
          Identifier.asSessionID(session.id),
          Identifier.asMessageID(input.messageID),
        ),
      ])
      const item = (await SessionInbox.list(session.id)).find((item) => item.messageID === input.messageID)
      const run = await RolloutLedger.getRun(
        RolloutLifecycle.owner(session),
        (message?.role === "user" ? message.rootID : undefined) ?? input.messageID,
      ).catch((error) => {
        if (error instanceof Storage.NotFoundError) return
        throw error
      })
      if (!item && !message && !run) throw new Storage.NotFoundError({ message: "Input was not found" })
      const progress = SessionInputProgress.current(session.id, input.messageID)
      const terminal =
        run?.status === "completed" || run?.status === "cancelled" || run?.status === "failed" ? run.status : undefined
      const state =
        terminal ??
        (item?.status === "failed" || (item && session.paused)
          ? "failed"
          : item
            ? (progress?.state ?? "accepted")
            : message?.role === "user" && !message.isRoot
              ? "completed"
              : run?.input || SessionManager.isRunning(session.id)
                ? "running"
                : "preparing")
      return {
        ...input,
        state,
        durable: true,
        canonical: Boolean(message),
        updatedAt: run?.ended ?? progress?.updatedAt ?? item?.time.updated ?? item?.time.created ?? run?.started ?? 0,
        ...(item ? { itemID: item.id } : {}),
        ...(item?.failReason
          ? { error: { code: "InputMaterializationError", message: item.failReason } }
          : item && session.paused
            ? { error: { code: "SessionPaused", message: "The saved message is paused. Retry to resume processing." } }
            : progress?.error
              ? { error: progress.error }
              : {}),
      }
    })
  }
}
