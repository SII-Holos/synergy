const ARCHIVED_PREFIX = "archived:"

/**
 * Parse a search query string and determine whether archived sessions
 * should be included, along with the cleaned search term.
 *
 * When the query starts with "archived:" (case-insensitive), archived
 * sessions are included and the prefix is stripped from the search.
 */
export function resolveArchivedInput(raw: string): { search: string; includeArchived: boolean } {
  const trimmed = raw.trimStart()
  if (trimmed.toLowerCase().startsWith(ARCHIVED_PREFIX)) {
    const remainder = trimmed.slice(ARCHIVED_PREFIX.length).trimStart()
    return { search: remainder, includeArchived: true }
  }
  return { search: raw, includeArchived: false }
}
