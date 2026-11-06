import type { RenderArtifact } from "@ericsanchezok/synergy-util/render-artifact"

const cache = new Map<string, Promise<string>>()
export function loadRenderLibraries(libraries: RenderArtifact.Source["libraries"]) {
  return Promise.all(
    libraries.map((library) => {
      const cached = cache.get(library)
      if (cached) return cached
      const pending = (async () => {
        if (library === "mermaid") return (await import("mermaid/dist/mermaid.min.js?raw")).default
        const url =
          library === "chart"
            ? (await import("./library-chart?worker&url")).default
            : (await import("./library-d3?worker&url")).default
        const response = await fetch(url)
        if (!response.ok) throw new Error(`Bundled library unavailable: ${library}`)
        return `(() => {${await response.text()}\n})();`
      })().catch((error) => {
        cache.delete(library)
        throw error
      })
      cache.set(library, pending)
      return pending
    }),
  )
}
