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
  return () => {
    icons.delete(entry.name)
  }
}

export function getIcon(name: string): IconEntry | undefined {
  return icons.get(name)
}

export function hasIcon(name: string): boolean {
  return icons.has(name)
}

export function listIcons(): IconEntry[] {
  return Array.from(icons.values())
}
