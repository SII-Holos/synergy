export interface IconEntry {
  name: string
  svgContent: string // sanitized SVG markup
  pluginId?: string
}

const icons: Map<string, IconEntry> = new Map()

export function registerIcon(entry: IconEntry): () => void {
  icons.set(entry.name, entry)
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
