import type { SqlConnection, SqlDriver, SqlRow, SqlValue } from "./sql-contract"

const owner = (row: "OLD" | "NEW") =>
  `json_array(json_extract(${row}.key_text, '$[0]'), json_extract(${row}.key_text, '$[1]'), json_extract(${row}.key_text, '$[2]'), json_extract(${row}.key_text, '$[3]'))`
const eligible = (row: "OLD" | "NEW") =>
  `${row}.body IS NOT NULL AND (( ${row}.kind = 'rollout' AND ${row}.scope_id <> '' AND ${row}.session_id <> '') OR (${row}.kind = 'operations' AND json_array_length(${row}.key_text) >= 4))`
const scope = (row: "OLD" | "NEW") =>
  `CASE WHEN ${row}.kind = 'rollout' THEN ${row}.scope_id ELSE json_extract(${row}.key_text, '$[1]') END`
const identity = (row: "OLD" | "NEW") =>
  `CASE WHEN ${row}.kind = 'rollout' THEN ${row}.session_id ELSE json_extract(${row}.key_text, '$[2]') END`

function add(condition = "1") {
  return `INSERT INTO storage_evidence_owners(namespace, owner, kind, scope_id, owner_id, records, newest, generation, ready)
    SELECT NEW.namespace, ${owner("NEW")}, NEW.kind, ${scope("NEW")}, ${identity("NEW")},
      CASE WHEN p.phase = 'ready' THEN 1 ELSE 0 END, CASE WHEN p.phase = 'ready' THEN NEW.updated ELSE 0 END, 1, p.phase = 'ready'
    FROM storage_evidence_preparation p WHERE p.namespace = NEW.namespace AND ${eligible("NEW")} AND (${condition})
    ON CONFLICT(namespace, owner) DO UPDATE SET generation = generation + 1,
      records = records + ready, newest = CASE WHEN ready THEN MAX(newest, NEW.updated) ELSE newest END;`
}

function remove(condition = "1") {
  return `UPDATE storage_evidence_owners SET generation = generation + 1,
    records = CASE WHEN ready THEN records - 1 ELSE records END,
    newest = CASE WHEN ready AND newest = OLD.updated THEN COALESCE(CASE WHEN OLD.kind = 'rollout' THEN (
      SELECT r.updated FROM storage_records r WHERE r.namespace = OLD.namespace AND r.body IS NOT NULL AND
        r.kind = 'rollout' AND r.scope_id = OLD.scope_id AND r.session_id = OLD.session_id ORDER BY r.updated DESC LIMIT 1
    ) ELSE 0 END, 0) ELSE newest END,
    ready = CASE WHEN OLD.kind = 'operations' AND newest = OLD.updated THEN 0 ELSE ready END
    WHERE namespace = OLD.namespace AND owner = ${owner("OLD")} AND ${eligible("OLD")} AND (${condition});`
}

function update() {
  const same = `(${eligible("OLD")}) AND (${eligible("NEW")}) AND ${owner("OLD")} = ${owner("NEW")}`
  return `${remove(`NOT (${same})`)} ${add(`NOT (${same})`)}
    UPDATE storage_evidence_owners SET generation = generation + 1,
      newest = CASE WHEN ready THEN MAX(newest, NEW.updated) ELSE newest END,
      ready = CASE WHEN newest = OLD.updated AND NEW.updated < OLD.updated THEN 0 ELSE ready END
    WHERE namespace = NEW.namespace AND owner = ${owner("NEW")} AND (${same});`
}

// SQLite trigger semantics keep this projection in the canonical transaction,
// including imports and physical pruning: https://www.sqlite.org/lang_createtrigger.html
export const evidenceOwnerTriggers = [
  `CREATE TRIGGER IF NOT EXISTS storage_evidence_insert AFTER INSERT ON storage_records BEGIN ${add()} END`,
  `CREATE TRIGGER IF NOT EXISTS storage_evidence_delete AFTER DELETE ON storage_records BEGIN ${remove()} END`,
  `CREATE TRIGGER IF NOT EXISTS storage_evidence_update AFTER UPDATE ON storage_records BEGIN ${update()} END`,
]

export const evidenceOwnerTables = [
  `CREATE TABLE IF NOT EXISTS storage_evidence_preparation(namespace TEXT PRIMARY KEY, phase TEXT NOT NULL, cursor_order TEXT NOT NULL DEFAULT '', cursor_key BLOB)`,
  `CREATE TABLE IF NOT EXISTS storage_evidence_owners(namespace TEXT NOT NULL, owner TEXT NOT NULL, kind TEXT NOT NULL, scope_id TEXT NOT NULL, owner_id TEXT NOT NULL,
    records INTEGER NOT NULL DEFAULT 0, newest INTEGER NOT NULL DEFAULT 0, generation INTEGER NOT NULL DEFAULT 0, source_generation INTEGER NOT NULL DEFAULT -1,
    ready INTEGER NOT NULL DEFAULT 0, cursor_order TEXT NOT NULL DEFAULT '', cursor_key BLOB, scan_records INTEGER NOT NULL DEFAULT 0,
    scan_newest INTEGER NOT NULL DEFAULT 0, scan_generation INTEGER NOT NULL DEFAULT -1, PRIMARY KEY(namespace, owner))`,
]

export namespace EvidenceOwnerProjection {
  export const id = "20261001-incremental-evidence-owners"

  export async function initialize(connection: SqlConnection, namespace: string) {
    await connection.query(
      `INSERT INTO storage_evidence_preparation(namespace, phase)
      VALUES (?, CASE WHEN EXISTS(SELECT 1 FROM storage_records WHERE namespace = ? AND kind IN ('rollout', 'operations') AND body IS NOT NULL LIMIT 1) THEN 'rollout' ELSE 'ready' END)
      ON CONFLICT(namespace) DO NOTHING`,
      [namespace, namespace],
    )
  }

  export async function list(driver: SqlDriver, namespace: string) {
    const rows = await driver.query(
      `SELECT owner, kind, scope_id, owner_id, newest, records FROM storage_evidence_owners o
      WHERE namespace = ? AND ready = 1 AND records > 0 AND NOT EXISTS(
        SELECT 1 FROM storage_records p WHERE p.namespace = o.namespace AND p.kind = 'compat_pending' AND p.order_key = o.owner_id AND p.body IS NOT NULL)`,
      [namespace],
      { background: true },
    )
    return rows.map((row) => ({
      keyPrefix: JSON.parse(String(row.owner)) as string[],
      kind: row.kind === "rollout" ? "session" : "operation",
      scopeID: String(row.scope_id),
      ownerID: String(row.owner_id),
      newest: Number(row.newest),
      records: Number(row.records),
    }))
  }

  function group(row: SqlRow) {
    const key = JSON.parse(String(row.key_text)) as string[]
    if (key.length < 4 || (row.kind === "rollout" && (!row.scope_id || !row.session_id))) return
    return {
      owner: JSON.stringify(key.slice(0, 4)),
      kind: String(row.kind),
      scopeID: row.kind === "rollout" ? String(row.scope_id) : key[1]!,
      ownerID: row.kind === "rollout" ? String(row.session_id) : key[2]!,
    }
  }

  export async function advance(
    driver: SqlDriver,
    namespace: string,
    input: { maxRows?: number; signal?: AbortSignal } = {},
  ) {
    input.signal?.throwIfAborted()
    const limit = Math.max(1, Math.min(2048, Math.floor(input.maxRows ?? 512)))
    const snapshot = await driver.transaction(
      async (tx) => {
        const [state] = await tx.query("SELECT * FROM storage_evidence_preparation WHERE namespace = ?", [namespace])
        if (!state || state.phase === "ready") return { state, rows: [] as SqlRow[] }
        const values: SqlValue[] = [namespace, String(state.phase)]
        const cursor = state.cursor_key === null ? "" : "AND (order_key, key_id) > (?, ?)"
        if (cursor) values.push(String(state.cursor_order), state.cursor_key)
        const rows = await tx.query(
          `SELECT key_id, key_text, kind, scope_id, session_id, updated, order_key FROM storage_records
        WHERE namespace = ? AND kind = ? ${cursor} AND body IS NOT NULL ORDER BY order_key, key_id LIMIT ?`,
          [...values, limit],
        )
        return { state, rows }
      },
      { readOnly: true, background: true },
    )
    input.signal?.throwIfAborted()
    if (snapshot.state?.phase !== "ready") {
      await driver.transaction(
        async (tx) => {
          if (snapshot.state?.phase === "operations" && snapshot.rows.length) {
            await tx.query(
              `UPDATE storage_records SET scope_id = json_extract(key_text, '$[1]'), session_id = json_extract(key_text, '$[2]'), message_id = json_extract(key_text, '$[3]')
            WHERE namespace = ? AND key_id IN (${snapshot.rows.map(() => "?").join(",")}) AND scope_id = ''`,
              [namespace, ...snapshot.rows.map((row) => row.key_id)],
            )
          }
          const grouped = new Map<
            string,
            { owner: string; kind: string; scopeID: string; ownerID: string; count: number; newest: number }
          >()
          for (const row of snapshot.rows) {
            const value = group(row)
            if (!value) continue
            const current = grouped.get(value.owner) ?? { ...value, count: 0, newest: 0 }
            current.count++
            current.newest = Math.max(current.newest, Number(row.updated))
            grouped.set(value.owner, current)
          }
          const values = [...grouped.values()]
          for (let offset = 0; offset < values.length; offset += 64) {
            const batch = values.slice(offset, offset + 64)
            await tx.query(
              `INSERT INTO storage_evidence_owners(namespace, owner, kind, scope_id, owner_id, records, newest, source_generation)
            VALUES ${batch.map(() => "(?, ?, ?, ?, ?, ?, ?, ?)").join(",")}
            ON CONFLICT(namespace, owner) DO UPDATE SET records = records + excluded.records, newest = MAX(newest, excluded.newest),
              source_generation = CASE WHEN source_generation < 0 THEN excluded.source_generation ELSE source_generation END`,
              batch.flatMap((x) => [namespace, x.owner, x.kind, x.scopeID, x.ownerID, x.count, x.newest, 0]),
            )
          }
          const last = snapshot.rows.at(-1)
          if (snapshot.rows.length === limit && last) {
            await tx.query(
              "UPDATE storage_evidence_preparation SET cursor_order = ?, cursor_key = ? WHERE namespace = ?",
              [String(last.order_key), last.key_id, namespace],
            )
          } else if (snapshot.state?.phase === "rollout") {
            await tx.query(
              "UPDATE storage_evidence_preparation SET phase = 'operations', cursor_order = '', cursor_key = NULL WHERE namespace = ?",
              [namespace],
            )
          } else {
            await tx.query(
              "UPDATE storage_evidence_owners SET ready = 1 WHERE namespace = ? AND generation = source_generation",
              [namespace],
            )
            await tx.query("UPDATE storage_evidence_preparation SET phase = 'ready' WHERE namespace = ?", [namespace])
          }
        },
        { background: true },
      )
      return { ready: false, scanned: snapshot.rows.length }
    }
    const candidate = await driver.transaction(
      async (tx) => {
        const [owner] = await tx.query(
          "SELECT * FROM storage_evidence_owners WHERE namespace = ? AND ready = 0 ORDER BY owner LIMIT 1",
          [namespace],
        )
        if (!owner) return
        const continuing = Number(owner.generation) === Number(owner.scan_generation)
        const values: SqlValue[] = [namespace, String(owner.kind)]
        const filter = `AND session_id = ? AND scope_id = ?${owner.kind === "operations" ? " AND message_id = ? AND message_id <> ''" : ""}`
        values.push(String(owner.owner_id), String(owner.scope_id))
        if (owner.kind === "operations") values.push((JSON.parse(String(owner.owner)) as string[])[3]!)
        const cursor = continuing && owner.cursor_key !== null ? "AND (order_key, key_id) > (?, ?)" : ""
        if (cursor) values.push(String(owner.cursor_order), owner.cursor_key)
        // Provenance: https://www.sqlite.org/lang_indexedby.html
        // Local adaptation: lock owner recounts to the Session index; a shared fourth segment must not scan other owners.
        const rows = await tx.query(
          `SELECT key_id, order_key, updated FROM storage_records INDEXED BY storage_records_session
        WHERE namespace = ? AND kind = ? ${filter} ${cursor} AND body IS NOT NULL ORDER BY order_key, key_id LIMIT ?`,
          [...values, limit],
        )
        return { owner, rows, continuing }
      },
      { readOnly: true, background: true },
    )
    input.signal?.throwIfAborted()
    if (!candidate) return { ready: true, scanned: 0 }
    await driver.transaction(
      async (tx) => {
        const { owner, rows, continuing } = candidate
        const last = rows.at(-1)
        const count = (continuing ? Number(owner.scan_records) : 0) + rows.length
        const newest = Math.max(continuing ? Number(owner.scan_newest) : 0, ...rows.map((row) => Number(row.updated)))
        const ready = rows.length < limit
        await tx.query(
          `UPDATE storage_evidence_owners SET cursor_order = ?, cursor_key = ?, scan_records = ?, scan_newest = ?, scan_generation = ?,
        ready = ?, records = CASE WHEN ? THEN ? ELSE records END, newest = CASE WHEN ? THEN ? ELSE newest END, source_generation = ?
        WHERE namespace = ? AND owner = ? AND generation = ?`,
          [
            last ? String(last.order_key) : "",
            last?.key_id ?? null,
            count,
            newest,
            owner.generation,
            Number(ready),
            Number(ready),
            count,
            Number(ready),
            newest,
            owner.generation,
            namespace,
            String(owner.owner),
            owner.generation,
          ],
        )
      },
      { background: true },
    )
    return { ready: false, scanned: candidate.rows.length }
  }
}
