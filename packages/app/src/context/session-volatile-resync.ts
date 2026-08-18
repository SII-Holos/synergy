export function planSessionVolatileResync(input: {
  scopeKey: string
  activeBucketKeys: string[]
  inboxSessionIDs: string[]
  todoSessionIDs: string[]
  dagSessionIDs: string[]
}) {
  const retainedSessionIDs = [...new Set([...input.inboxSessionIDs, ...input.todoSessionIDs, ...input.dagSessionIDs])]
  const prefix = `${input.scopeKey}\n`
  const activeSessionIDs = input.activeBucketKeys
    .filter((key) => key.startsWith(prefix))
    .map((key) => key.slice(prefix.length))
    .filter((sessionID) => sessionID.length > 0)
  return { activeSessionIDs: [...new Set(activeSessionIDs)], retainedSessionIDs }
}
