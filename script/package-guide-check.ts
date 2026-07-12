#!/usr/bin/env bun

import path from "node:path"

type RootPackage = {
  workspaces?: {
    packages?: string[]
  }
}

export async function validatePackageGuides(root: string): Promise<string[]> {
  const packageFile = path.join(root, "package.json")
  const manifest = (await Bun.file(packageFile)
    .json()
    .catch(() => undefined)) as RootPackage | undefined
  const workspaces = manifest?.workspaces?.packages
  if (!Array.isArray(workspaces) || workspaces.length === 0) return ["package.json: missing workspaces.packages"]

  const errors: string[] = []
  for (const workspace of workspaces) {
    const packageJson = Bun.file(path.join(root, workspace, "package.json"))
    if (!(await packageJson.exists())) {
      errors.push(`${workspace}: missing package.json`)
      continue
    }
    const guide = Bun.file(path.join(root, workspace, "AGENTS.md"))
    if (!(await guide.exists()) || (await guide.text()).trim().length === 0) {
      errors.push(`${workspace}: missing or empty AGENTS.md`)
    }
  }
  return errors
}

if (import.meta.main) {
  const root = path.resolve(process.argv[2] ?? ".")
  const errors = await validatePackageGuides(root)
  if (errors.length > 0) {
    for (const error of errors) console.error(`- ${error}`)
    console.error(`Package guide validation failed with ${errors.length} error(s).`)
    process.exit(1)
  }
  const manifest = (await Bun.file(path.join(root, "package.json")).json()) as RootPackage
  console.log(`Validated ${manifest.workspaces!.packages!.length} workspace package guides.`)
}
