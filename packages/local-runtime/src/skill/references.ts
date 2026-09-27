import fs from "fs/promises"
import path from "path"
import type { Skill } from "./skill"

const REFERENCE_EXTENSIONS = [".txt", ".md", ".mdx", ".json", ".yaml", ".yml"]
const REFERENCE_GLOB = new Bun.Glob("**/*")

function resolveMemoryReference(references: Record<string, string>, name: string) {
  if (references[name]) return references[name]
  const keys = Object.keys(references)
  const byBasename = keys.find((key) => path.basename(key) === name || path.basename(key) === path.basename(name))
  if (byBasename) return references[byBasename]
  const basename = path.basename(name.replace(/\.\w+$/, ""))
  const byStem = keys.find((key) => path.basename(key).replace(/\.\w+$/, "") === basename)
  return byStem ? references[byStem] : undefined
}

function isWithinDirectory(directory: string, candidate: string) {
  const relative = path.relative(directory, candidate)
  return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative))
}

async function resolveFileReference(directory: string, name: string) {
  const baseDir = await fs.realpath(directory).catch(() => undefined)
  if (!baseDir) return undefined
  const candidates = [path.resolve(baseDir, name)]
  if (!path.extname(name)) {
    for (const extension of REFERENCE_EXTENSIONS) candidates.push(path.resolve(baseDir, name + extension))
  }
  const basename = path.basename(name)
  if (!name.startsWith("references/") && !name.startsWith("references\\")) {
    candidates.push(path.resolve(baseDir, "references", basename))
    if (!path.extname(basename)) {
      for (const extension of REFERENCE_EXTENSIONS) {
        candidates.push(path.resolve(baseDir, "references", basename + extension))
      }
    }
  }

  for (const candidate of candidates) {
    if (!isWithinDirectory(baseDir, candidate)) continue
    const realCandidate = await fs.realpath(candidate).catch(() => undefined)
    if (!realCandidate || !isWithinDirectory(baseDir, realCandidate)) continue
    const file = Bun.file(realCandidate)
    if (await file.exists()) return file.text()
  }
  return undefined
}

async function referenceNames(skill: Skill.Info) {
  if (skill.backing.kind === "memory") return Object.keys(skill.backing.references ?? {})
  const referenceDir = path.join(skill.backing.baseDir, "references")
  const referenceStat = await fs.stat(referenceDir).catch(() => undefined)
  if (!referenceStat?.isDirectory()) return []
  const names: string[] = []
  for await (const file of REFERENCE_GLOB.scan({ cwd: referenceDir, absolute: false, onlyFiles: true })) {
    names.push(`references/${file.replace(/\\/g, "/")}`)
    if (names.length === 100) break
  }
  return names.sort()
}

/** Reference resolution owned by the skill domain so generic instruction
 * consumers can load references without importing the domain. */
export const SkillReferences = {
  resolve(skill: Skill.Info, name: string) {
    if (skill.backing.kind === "memory") {
      return Promise.resolve(resolveMemoryReference(skill.backing.references ?? {}, name))
    }
    return resolveFileReference(skill.backing.baseDir, name)
  },
  names: referenceNames,
}
