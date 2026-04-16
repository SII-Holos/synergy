#!/usr/bin/env bun
/**
 * Skill Packager - Creates a distributable .skill archive from a skill folder
 *
 * Usage:
 *     package-skill.ts <path/to/skill-folder> [output-directory]
 *
 * Example:
 *     package-skill.ts skills/public/my-skill
 *     package-skill.ts skills/public/my-skill ./dist
 */

import path from "path"
import fs from "fs/promises"
import { BlobWriter, ZipWriter } from "@zip.js/zip.js"
import { validateSkill } from "./validate-skill"

/**
 * Recursively get all files in a directory
 */
async function getAllFiles(dir: string): Promise<string[]> {
  const files: string[] = []
  const entries = await fs.readdir(dir, { withFileTypes: true })

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      const subFiles = await getAllFiles(fullPath)
      files.push(...subFiles)
    } else if (entry.isFile()) {
      files.push(fullPath)
    }
  }

  return files
}

/**
 * Package a skill folder into a .skill file.
 *
 * @param skillPath - Path to the skill folder
 * @param outputDir - Optional output directory for the .skill file (defaults to current directory)
 * @returns Path to the created .skill file, or null if error
 */
export async function packageSkill(skillPath: string, outputDir?: string): Promise<string | null> {
  const resolvedSkillPath = path.resolve(skillPath)

  // Validate skill folder exists
  try {
    const stat = await fs.stat(resolvedSkillPath)
    if (!stat.isDirectory()) {
      console.log(`❌ Error: Path is not a directory: ${resolvedSkillPath}`)
      return null
    }
  } catch {
    console.log(`❌ Error: Skill folder not found: ${resolvedSkillPath}`)
    return null
  }

  // Validate SKILL.md exists
  const skillMdPath = path.join(resolvedSkillPath, "SKILL.md")
  const skillMdFile = Bun.file(skillMdPath)
  if (!(await skillMdFile.exists())) {
    console.log(`❌ Error: SKILL.md not found in ${resolvedSkillPath}`)
    return null
  }

  // Run validation before packaging
  console.log("🔍 Validating skill...")
  const validation = await validateSkill(resolvedSkillPath)
  if (!validation.valid) {
    console.log(`❌ Validation failed: ${validation.message}`)
    console.log("   Please fix the validation errors before packaging.")
    return null
  }
  console.log(`✅ ${validation.message}\n`)

  // Determine output location
  const skillName = path.basename(resolvedSkillPath)
  let resolvedOutputPath: string
  if (outputDir) {
    resolvedOutputPath = path.resolve(outputDir)
    await fs.mkdir(resolvedOutputPath, { recursive: true })
  } else {
    resolvedOutputPath = process.cwd()
  }

  const skillFilename = path.join(resolvedOutputPath, `${skillName}.skill`)

  // Create the .skill file (zip format)
  try {
    const blobWriter = new BlobWriter("application/zip")
    const zipWriter = new ZipWriter(blobWriter, { level: 9 })

    // Walk through the skill directory
    const files = await getAllFiles(resolvedSkillPath)
    const parentDir = path.dirname(resolvedSkillPath)

    for (const filePath of files) {
      // Calculate the relative path within the zip
      const arcname = path.relative(parentDir, filePath)
      const fileContent = await Bun.file(filePath).arrayBuffer()
      await zipWriter.add(arcname, new Blob([fileContent]).stream())
      console.log(`  Added: ${arcname}`)
    }

    await zipWriter.close()
    const blob = await blobWriter.getData()
    const arrayBuffer = await blob.arrayBuffer()
    await Bun.write(skillFilename, arrayBuffer)

    console.log(`\n✅ Successfully packaged skill to: ${skillFilename}`)
    return skillFilename
  } catch (e) {
    console.log(`❌ Error creating .skill file: ${e}`)
    return null
  }
}

// CLI entry point
if (import.meta.main) {
  const args = process.argv.slice(2)
  if (args.length < 1) {
    console.log("Usage: package-skill.ts <path/to/skill-folder> [output-directory]")
    console.log("\nExample:")
    console.log("  package-skill.ts skills/public/my-skill")
    console.log("  package-skill.ts skills/public/my-skill ./dist")
    process.exit(1)
  }

  const skillPath = args[0]
  const outputDir = args.length > 1 ? args[1] : undefined

  console.log(`📦 Packaging skill: ${skillPath}`)
  if (outputDir) {
    console.log(`   Output directory: ${outputDir}`)
  }
  console.log()

  const result = await packageSkill(skillPath, outputDir)

  if (result) {
    process.exit(0)
  } else {
    process.exit(1)
  }
}
