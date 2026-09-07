import fs from "node:fs"
import path from "node:path"

function ignored(file: string) {
  const parts = file.split(path.sep)
  return (
    parts.some(
      (part) => part === ".git" || part === "dist" || part === "node_modules" || part.startsWith(".synergy-plugin-"),
    ) ||
    file === `src${path.sep}generated${path.sep}plugin-data` ||
    file.startsWith(`src${path.sep}generated${path.sep}plugin-data${path.sep}`)
  )
}

function hasAuthoredFiles(root: string, relative: string): boolean {
  try {
    return fs.readdirSync(path.join(root, relative), { withFileTypes: true }).some((entry) => {
      const file = path.join(relative, entry.name)
      if (ignored(file)) return false
      return !entry.isDirectory() || hasAuthoredFiles(root, file)
    })
  } catch {
    return true
  }
}

export function watchPluginSources(root: string, changed: () => void) {
  let closed = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const schedule = () => {
    if (closed) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(changed, 200)
  }
  const watcher = fs.watch(root, { recursive: true }, (_event, filename) => {
    const file = filename?.toString()
    if (file && ignored(file)) return
    if ((file === "src" || file === `src${path.sep}generated`) && !hasAuthoredFiles(root, file)) return
    schedule()
  })
  let previous = new Set<string>()
  const dependencies = new Map<string, { watcher: fs.FSWatcher; names: Set<string> }>()
  return {
    update(files: readonly string[], valid = true) {
      if (closed) return
      previous = new Set(valid ? files : [...previous, ...files])
      const targets = new Map<string, Set<string>>()
      for (const file of previous) {
        let resolved: string
        try {
          resolved = fs.realpathSync(file)
        } catch {
          continue
        }
        const relative = path.relative(root, resolved)
        if (!relative.startsWith("..") && !ignored(relative)) continue
        const parent = path.dirname(resolved)
        const names = targets.get(parent) ?? new Set<string>()
        names.add(path.basename(resolved))
        targets.set(parent, names)
      }
      for (const [parent, entry] of dependencies) {
        const names = targets.get(parent)
        if (names) {
          entry.names = names
          targets.delete(parent)
          continue
        }
        entry.watcher.close()
        dependencies.delete(parent)
      }
      for (const [parent, names] of targets) {
        const entry = {
          names,
          watcher: fs.watch(parent, (_event, filename) => {
            if (!filename || entry.names.has(filename.toString())) schedule()
          }),
        }
        dependencies.set(parent, entry)
      }
    },
    close() {
      if (closed) return
      closed = true
      if (timer) clearTimeout(timer)
      watcher.close()
      for (const entry of dependencies.values()) entry.watcher.close()
      dependencies.clear()
    },
  }
}
