/**
 * Test utility mirroring the removed LLM.collectText: consumes the AI SDK
 * text promise while cancelling the residual fullStream branch retained as
 * baseStream by tee().
 */
export async function collectText(result: { text: Promise<string>; baseStream?: { cancel(): Promise<void> } }) {
  // Accessing `text` first lets the result getter materialize the baseStream
  // branch retained by tee(); only then can it be cancelled.
  const text = result.text
  let cancellation: Promise<void> | undefined
  try {
    cancellation = result.baseStream?.cancel().catch(() => undefined) as Promise<void> | undefined
  } catch {
    // A synchronous cancel() failure must not mask the consumed text.
  }
  try {
    return await text
  } finally {
    await cancellation
  }
}
