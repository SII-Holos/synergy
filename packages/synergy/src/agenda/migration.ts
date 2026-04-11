import { Storage } from "../storage/storage"
import { StoragePath } from "../storage/path"
import { AgendaStore } from "./store"
import { AgendaTypes } from "./types"
import { Identifier } from "../id/id"
import { Log } from "../util/log"
import type { Migration } from "../migration"

const log = Log.create({ service: "agenda.migration" })

export const migrations: Migration[] = [
  {
    id: "20260322-agenda-session-index",
    description: "Backfill agenda session index from run logs",
    async up(progress) {
      const scopeIDs = await Storage.scan(["agenda", "items"])

      const tasks: { scopeID: string; itemID: string; run: AgendaTypes.RunLog }[] = []
      for (const scopeID of scopeIDs) {
        const itemIDs = await Storage.scan(StoragePath.agendaItemsRoot(Identifier.asScopeID(scopeID)))
        for (const itemID of itemIDs) {
          const runs = await AgendaStore.listRuns(scopeID, itemID)
          for (const run of runs) {
            if (run.sessionID) tasks.push({ scopeID, itemID, run })
          }
        }
      }

      if (tasks.length === 0) return

      let done = 0
      for (const { itemID, run } of tasks) {
        const sessionIndex = await Storage.read<{ sessionID: string; scopeID: string }>(
          StoragePath.sessionIndex(Identifier.asSessionID(run.sessionID!)),
        ).catch(() => undefined)

        if (!sessionIndex) {
          log.warn("session index not found, skipping", { itemID, sessionID: run.sessionID })
          done++
          progress(done, tasks.length)
          continue
        }

        await Storage.write(StoragePath.agendaSession(itemID, run.sessionID!), {
          sessionID: run.sessionID!,
          scopeID: sessionIndex.scopeID,
        })

        const sessionScopeID = Identifier.asScopeID(sessionIndex.scopeID)
        const sessionID = Identifier.asSessionID(run.sessionID!)
        await Storage.update<any>(StoragePath.sessionInfo(sessionScopeID, sessionID), (draft) => {
          if (!draft.agenda) {
            draft.agenda = { itemID }
          }
        }).catch((err) => {
          log.warn("failed to update session info", { itemID, sessionID: run.sessionID, error: String(err) })
        })

        done++
        progress(done, tasks.length)
      }

      log.info("backfill complete", { total: tasks.length })
    },
  },
]
