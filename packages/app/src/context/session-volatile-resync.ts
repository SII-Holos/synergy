export function planSessionVolatileResync(input: {
  scopeKey: string
  activeBucketKey: string | undefined
  inboxSessionIDs: string[]
  todoSessionIDs: string[]
  dagSessionIDs: string[]
}) {
  const retainedSessionIDs = [...new Set([...input.inboxSessionIDs, ...input.todoSessionIDs, ...input.dagSessionIDs])]
  const prefix = `${input.scopeKey}\n`
  const activeSessionID = input.activeBucketKey?.startsWith(prefix)
    ? input.activeBucketKey.slice(prefix.length)
    : undefined
  return { activeSessionID: activeSessionID || undefined, retainedSessionIDs }
}
