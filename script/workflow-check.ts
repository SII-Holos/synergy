#!/usr/bin/env bun

import { $ } from "bun"
import { rm } from "fs/promises"
import os from "os"
import path from "path"

const tempDir = path.join(os.tmpdir(), `synergy-actionlint-${process.pid}`)
const ACTIONLINT_VERSION = "1.7.12"
const ZIZMOR_VERSION = "1.26.1"
const ACTIONLINT_INSTALLER = `https://raw.githubusercontent.com/rhysd/actionlint/v${ACTIONLINT_VERSION}/scripts/download-actionlint.bash`

try {
  await $`bash -c ${`mkdir -p "${tempDir}" && bash <(curl -sSfL "${ACTIONLINT_INSTALLER}") "${ACTIONLINT_VERSION}" "${tempDir}"`}`
  await $`${path.join(tempDir, "actionlint")} -color`
} catch (error) {
  console.error(
    "actionlint failed or could not be downloaded. Install actionlint locally or ensure network access, then rerun bun run workflow:check.",
  )
  throw error
} finally {
  await rm(tempDir, { recursive: true, force: true })
}

try {
  await $`uvx ${`zizmor==${ZIZMOR_VERSION}`} .`
} catch (error) {
  if (!(await hasCommand("uvx"))) {
    console.error(
      "zizmor requires uvx locally. Install uv (https://docs.astral.sh/uv/) or run the CI workflow-validation job.",
    )
  }
  throw error
}

async function hasCommand(command: string) {
  try {
    await $`which ${command}`.quiet()
    return true
  } catch {
    return false
  }
}
