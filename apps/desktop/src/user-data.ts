import { mkdirSync } from "node:fs"
import path from "node:path"

export function configureDesktopUserData(
  app: { setPath(name: "userData", path: string): void },
  env: NodeJS.ProcessEnv,
) {
  const directory = env.SYNERGY_DESKTOP_USER_DATA_DIR
  if (!directory) return
  if (!path.isAbsolute(directory)) throw new Error("SYNERGY_DESKTOP_USER_DATA_DIR must be an absolute path.")
  mkdirSync(directory, { recursive: true })
  app.setPath("userData", directory)
}
