import { createSignal } from "solid-js"

const [version, setVersion] = createSignal(0)

function sanitizeSvg(svg: string): string {
  return svg
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<foreignObject[\s\S]*?<\/foreignObject>/gi, "")
    .replace(/\son\w+\s*=\s*["'][^"']*["']/gi, "")
    .replace(/javascript\s*:/gi, "blocked:")
}

export interface IconEntry {
  name: string
  svgContent: string // sanitized SVG markup
  pluginId?: string
}

const icons: Map<string, IconEntry> = new Map()

export function registerIcon(entry: IconEntry): () => void {
  const sanitized: IconEntry = { ...entry, svgContent: sanitizeSvg(entry.svgContent) }
  icons.set(entry.name, sanitized)
  setVersion((value) => value + 1)
  return () => {
    if (icons.get(entry.name) !== sanitized) return
    icons.delete(entry.name)
    setVersion((value) => value + 1)
  }
}

export function getIcon(name: string): IconEntry | undefined {
  version()
  return icons.get(name)
}

export function hasIcon(name: string): boolean {
  version()
  return icons.has(name)
}

export function listIcons(): IconEntry[] {
  return Array.from(icons.values())
}
