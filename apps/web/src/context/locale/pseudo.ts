export function shouldUsePseudoLocale(development: boolean, search: string): boolean {
  if (!development) return false
  return new URLSearchParams(search).get("pseudoLocale") === "1"
}
