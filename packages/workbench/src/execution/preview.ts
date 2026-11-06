// Provenance: ../../../../docs/decisions/implemented/bug-fix/2026-10-22-detach-execution-previews.md
// Local adaptation: build bounded UTF-16 output without retaining source-string backing storage.
export function preview(value: string): string {
  const codes: number[] = []
  let whitespace = false
  for (let index = 0; index < value.length && codes.length < 240; index++) {
    const space = /\s/.test(value[index]!)
    if (!space || !whitespace) codes.push(space ? 32 : value.charCodeAt(index))
    whitespace = space
  }
  return String.fromCharCode(...codes)
}
