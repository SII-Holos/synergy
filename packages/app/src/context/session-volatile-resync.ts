export function planSessionVolatileResync(input: {
  scopeKey: string
  /** The one actively-viewed bucket key (scopeKey\nsessionID), if any. */
  activeBucketKey?: string
  inboxSessionIDs: string[]
  todoSessionIDs: string[]
  dagSessionIDs: string[]
}) {
  const retainedSessionIDs = [...new Set([...input.inboxSessionIDs, ...input.todoSessionIDs, ...input.dagSessionIDs])]
  const prefix = `${input.scopeKey}\n`
  const activeBucketKey = input.activeBucketKey
  const activeSessionIDs =
    activeBucketKey && activeBucketKey.startsWith(prefix)
      ? [activeBucketKey.slice(prefix.length)].filter((sessionID) => sessionID.length > 0)
      : []
  return { activeSessionIDs, retainedSessionIDs }
}
