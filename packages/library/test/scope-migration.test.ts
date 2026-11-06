import { expect, test } from "bun:test"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { testRuntime } from "@ericsanchezok/synergy-harness/test/support/runtime"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { LibraryDB, closeDB } from "../src/database"
import { registerLibrary, disposeLibrary } from "../src/register"
import { migrations } from "../src/migration"

const id = "20261012-library-home-scope"

test("installing Library after the shared Scope receipt catches up only its legacy Home data", async () => {
  await using tmp = await tmpdir()
  const core = await testRuntime({ home: tmp.path })
  try {
    await core.run(async () => {
      const scopeKey = ["meta", "migration", "log-scope"]
      const scopeReceipt = await Storage.read<Record<string, number>>(scopeKey)
      await Storage.write(scopeKey, {
        ...scopeReceipt,
        "20260624-scope-global-to-home": 42,
        "20260424-scope-reclaim-orphans": 42,
      })
      await Storage.write(
        ["meta", "migration", "log-library"],
        Object.fromEntries(
          [
            "20260301-library-data-path",
            "20260324-library-experience-source-model",
            "20260405-library-memory-recall-mode",
            "20260415-library-purge-invalid-experiences",
            "20260423-library-purge-tool-hallucination-intents",
            "20260424-library-q-updated-at-integer",
            "20260425-library-purge-oversized-tool-log-intents",
            "20260425b-library-purge-assistant-reasoning-intents",
            "20260715-library-reencode-job-tables",
            "20260724-library-experience-user-input",
            "20260824-library-experience-retrieval-count",
          ].map((id) => [id, 42]),
        ),
      )
      for (const scopeID of ["global", "project-retained", "orphan-retained"])
        LibraryDB.Experience.insertFailed({ id: `exp_${scopeID}`, sessionID: "ses_retained", scopeID, createdAt: 1 })
      closeDB()
    })
  } finally {
    await core.close()
  }
  const enabled = await testRuntime({
    home: tmp.path,
    composition: {
      register: registerLibrary,
      services: () => ({ disposeExtensions: disposeLibrary }),
    },
  })
  try {
    await enabled.run(async () => {
      expect(LibraryDB.Experience.list("global")).toHaveLength(0)
      expect(LibraryDB.Experience.list("home").map((row) => row.id)).toEqual(["exp_global"])
      expect(LibraryDB.Experience.list("project-retained")).toHaveLength(1)
      expect(LibraryDB.Experience.list("orphan-retained")).toHaveLength(1)
      const receipt = await Storage.read<Record<string, number>>(["meta", "migration", "log-library"])
      expect(receipt[id]).toBeGreaterThan(0)
    })
  } finally {
    await enabled.close()
  }
})

test("Library scope catch-up is atomic on failure and safe to repeat before its receipt", async () => {
  await using runtime = await testRuntime()
  await runtime.run(async () => {
    try {
      const migration = migrations.find((migration) => migration.id === id)
      expect(migration).toBeDefined()
      const db = LibraryDB.connection()
      LibraryDB.Experience.insertFailed({ id: "exp_retry", sessionID: "ses_retry", scopeID: "global", createdAt: 1 })
      db.prepare(
        "INSERT INTO experience_content (id, session_id, scope_id, user_input, script, raw, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run("exp_retry", "ses_retry", "global", "retained", "[]", "{}", '{"future":true}', 1, 1)
      db.exec(
        "CREATE TRIGGER block_scope_catchup BEFORE UPDATE OF scope_id ON experience_content BEGIN SELECT RAISE(ABORT, 'interrupted scope catchup'); END",
      )
      await expect(migration!.up(() => {})).rejects.toThrow("interrupted scope catchup")
      expect(LibraryDB.Experience.list("global")).toHaveLength(1)
      db.exec("DROP TRIGGER block_scope_catchup")
      await migration!.up(() => {})
      await migration!.up(() => {})
      expect(LibraryDB.Experience.list("home")).toHaveLength(1)
      expect(db.query("SELECT scope_id, metadata FROM experience_content WHERE id = 'exp_retry'").get()).toEqual({
        scope_id: "home",
        metadata: '{"future":true}',
      })
    } finally {
      closeDB()
    }
  })
})
