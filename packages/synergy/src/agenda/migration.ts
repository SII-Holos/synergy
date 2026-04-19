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
  {
    id: "20260420-agenda-flatten-task-delivery",
    description: "Flatten task/delivery into top-level item fields",
    async up(progress) {
      const scopeIDs = await Storage.scan(["agenda", "items"])
      let total = 0
      let done = 0

      for (const scopeID of scopeIDs) {
        const itemIDs = await Storage.scan(StoragePath.agendaItemsRoot(Identifier.asScopeID(scopeID)))
        total += itemIDs.length
      }

      if (total === 0) return

      for (const scopeID of scopeIDs) {
        const sid = Identifier.asScopeID(scopeID)
        const itemIDs = await Storage.scan(StoragePath.agendaItemsRoot(sid))

        for (const itemID of itemIDs) {
          const path = StoragePath.agendaItem(sid, itemID)
          try {
            await Storage.update<any>(path, (draft) => {
              if (draft.prompt !== undefined && draft.wake !== undefined) return

              const task = draft.task as any
              if (task) {
                if (task.prompt && !draft.prompt) draft.prompt = task.prompt
                if (task.agent && !draft.agent) draft.agent = task.agent
                if (task.model && !draft.model) draft.model = task.model
                if (task.sessionRefs && !draft.sessionRefs) draft.sessionRefs = task.sessionRefs
                if (task.timeout && !draft.timeout) draft.timeout = task.timeout
                delete draft.task
              }

              if (!draft.prompt) draft.prompt = draft.title ?? ""

              const delivery = draft.delivery as any
              if (delivery) {
                if (delivery.target === "silent") {
                  draft.wake = false
                  draft.silent = true
                } else {
                  draft.wake = true
                  draft.silent = false
                }
                delete draft.delivery
              }

              if (draft.wake === undefined) draft.wake = true
              if (draft.silent === undefined) draft.silent = false
              if (draft.global === undefined) draft.global = false
            })
          } catch (err) {
            log.warn("failed to migrate agenda item", { scopeID, itemID, error: String(err) })
          }

          done++
          progress(done, total)
        }
      }

      log.info("agenda flatten migration complete", { total: done })
    },
  },
]
