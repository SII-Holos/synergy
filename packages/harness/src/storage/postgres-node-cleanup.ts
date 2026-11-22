import type { SqlConnection } from "./sql-contract"

const PAGE = 128

export async function cleanPostgresNodes(
  connection: SqlConnection,
  namespace: string,
  roots: string[],
  ancestors: string[],
  cursorNumber: number,
  checkCancellation: () => void,
) {
  // Each node has one parent. Starting each distinct root once and skipping edges
  // back to roots visits overlapping subtrees once, including a cycle containing a root.
  // OFFSET 0 keeps the child lookup parameterized by the current parent on PostgreSQL.
  const subtree = `WITH RECURSIVE roots(key_id) AS (VALUES ${roots.map(() => "(?::text)").join(",")}),
    tree(key_id) AS (
      SELECT key_id FROM roots UNION ALL
      SELECT child.key_id FROM tree CROSS JOIN LATERAL (
        SELECT n.key_id FROM storage_nodes n WHERE n.namespace = ? AND n.parent_id = tree.key_id OFFSET 0
      ) child WHERE NOT EXISTS (SELECT 1 FROM roots WHERE roots.key_id = child.key_id)
    ) SELECT key_id FROM tree`
  const values = [...roots, namespace]

  async function removeLeaves(keys: string[]) {
    const scope = new Set(keys)
    let pending = [...scope]
    let changed = false
    while (pending.length) {
      checkCancellation()
      const rows = await connection.query<{ key_id: string; parent_id: string }>(
        `DELETE FROM storage_nodes WHERE namespace = ? AND key_id IN (${pending.map(() => "?").join(",")})
         AND (SELECT 1 FROM storage_records r WHERE r.namespace = storage_nodes.namespace
              AND r.key_id = storage_nodes.key_id AND r.body IS NOT NULL) IS NULL
         AND (SELECT 1 FROM storage_nodes c WHERE c.namespace = storage_nodes.namespace
              AND c.parent_id = storage_nodes.key_id LIMIT 1) IS NULL RETURNING key_id, parent_id`,
        [namespace, ...pending],
      )
      changed ||= rows.length > 0
      pending = [...new Set(rows.map((row) => row.parent_id).filter((key) => scope.has(key)))]
    }
    checkCancellation()
    return changed
  }

  checkCancellation()
  const first = await connection.query<{ key_id: string }>(subtree + ` LIMIT ${PAGE + 1}`, values)
  if (first.length + ancestors.length <= PAGE) {
    await removeLeaves([...first.map((row) => row.key_id), ...ancestors])
    return
  }

  // Keep larger address sets in a transaction-local scrollable portal. Revisit
  // the same membership until parents freed across page boundaries are reclaimed.
  const cursor = `cleanup_nodes_${cursorNumber}`
  await connection.query(`DECLARE ${cursor} SCROLL CURSOR FOR ${subtree}`, values)
  let direction: "FORWARD" | "BACKWARD" = "FORWARD"
  for (;;) {
    let changed = false
    for (;;) {
      checkCancellation()
      const page = await connection.query<{ key_id: string }>(`FETCH ${direction} ${PAGE} FROM ${cursor}`)
      if (await removeLeaves(page.map((row) => row.key_id))) changed = true
      if (page.length < PAGE) break
    }
    for (let offset = 0; offset < ancestors.length; offset += PAGE) {
      if (await removeLeaves(ancestors.slice(offset, offset + PAGE))) changed = true
    }
    if (!changed) break
    direction = direction === "FORWARD" ? "BACKWARD" : "FORWARD"
  }
  await connection.query(`CLOSE ${cursor}`)
  checkCancellation()
}
