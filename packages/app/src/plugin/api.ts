import type { PluginContribution } from "./contributions-fetcher"

/**
 * Fetch aggregated UI contributions from the server.
 *
 * The server exposes this at /plugin/ui/contributions (mounted from PluginRoute).
 */
export async function fetchUIContributions(serverUrl: string): Promise<PluginContribution[]> {
  const res = await fetch(`${serverUrl}/plugin/ui/contributions`)
  if (!res.ok) {
    throw new Error(`Failed to fetch plugin UI contributions: ${res.status}`)
  }
  return res.json() as Promise<PluginContribution[]>
}
