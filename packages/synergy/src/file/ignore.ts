export namespace FileIgnore {
  const FOLDERS = new Set([
    "node_modules",
    "bower_components",
    ".pnpm-store",
    "vendor",
    ".npm",
    "dist",
    "build",
    "out",
    ".next",
    "target",
    "bin",
    "obj",
    ".git",
    ".svn",
    ".hg",
    ".vscode",
    ".idea",
    ".turbo",
    ".output",
    "desktop",
    ".sst",
    ".cache",
    ".webkit-cache",
    "__pycache__",
    ".pytest_cache",
    "mypy_cache",
    ".history",
    ".gradle",
  ])

  const FILES = [
    "**/*.swp",
    "**/*.swo",

    "**/*.pyc",

    // OS
    "**/.DS_Store",
    "**/Thumbs.db",

    // Logs & temp
    "**/logs/**",
    "**/tmp/**",
    "**/temp/**",
    "**/.scout-tmp/**",
    "**/*.log",

    // Coverage/test outputs
    "**/coverage/**",
    "**/.nyc_output/**",
  ]

  const FILE_GLOBS = FILES.map((p) => new Bun.Glob(p))

  // Provenance: https://github.com/parcel-bundler/watcher/blob/v2.5.6/wrapper.js
  // (plain ignore entries resolve to absolute top-level prefix paths; glob
  // entries are picomatch-compiled and full-matched against every relative
  // path) and https://github.com/parcel-bundler/watcher/blob/v2.5.6/src/Watcher.cc
  // (isIgnored: ignorePaths prefix-match, ignoreGlobs regex-match).
  // Local adaptation: PATTERNS keeps each plain top-level folder name AND adds
  // its `**/<folder>/**` recursive glob so nested generated trees are pruned
  // at any depth by native backends too. The trailing `/**` matters: the bare
  // `**/<folder>` glob matches only the directory node, not its contents.
  export const PATTERNS = [...FILES, ...FOLDERS, ...[...FOLDERS].map((folder) => `**/${folder}/**`)]

  export function match(
    filepath: string,
    opts?: {
      extra?: Bun.Glob[]
      whitelist?: Bun.Glob[]
    },
  ) {
    for (const glob of opts?.whitelist || []) {
      if (glob.match(filepath)) return false
    }

    const parts = filepath.replaceAll("\\", "/").split("/")
    for (let i = 0; i < parts.length; i++) {
      if (FOLDERS.has(parts[i])) return true
    }

    const extra = opts?.extra || []
    for (const glob of [...FILE_GLOBS, ...extra]) {
      if (glob.match(filepath)) return true
    }

    return false
  }
}
