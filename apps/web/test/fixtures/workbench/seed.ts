import { mkdir, realpath } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"
import { createSynergyClient } from "@ericsanchezok/synergy-sdk/client"

const [home, origin] = process.argv.slice(2)
if (!home || !origin) throw new Error("Usage: seed.ts <isolated-home> <server-origin>")
const url = new URL(origin)
if (url.hostname !== "127.0.0.1" || url.protocol !== "http:") throw new Error("Fixture server must be local HTTP")
const selectedHome = await realpath(home)
if (selectedHome === (await realpath(homedir()))) throw new Error("Fixture cannot use the user home")
const client = createSynergyClient({ baseUrl: url.origin })
const { data: paths } = await client.path.get({ scopeID: "home" }, { throwOnError: true })
if (!paths || (await realpath(paths.home)) !== selectedHome)
  throw new Error("Server home does not match the selected isolated home")
const manifestFile = Bun.file(path.join(home, "workbench-fixtures.json"))
if (await manifestFile.exists()) throw new Error("This home already has a workbench fixture manifest")
const scopes = ["home"]
for (const name of ["文档协作", "Frontend Lab", "交互验收"]) {
  const directory = path.join(home, "projects", name)
  await mkdir(directory, { recursive: true })
  const { data: scope } = await client.scope.current({ directory }, { throwOnError: true })
  if (!scope) throw new Error("Fixture project was not created")
  await client.scope.update({ path_scopeID: scope.id, name }, { throwOnError: true })
  scopes.push(scope.id)
}
const sessions = []
for (let i = 0; i < 30; i++) {
  const title =
    i % 3 === 0
      ? `${i + 1} · 主工作台视觉与输入交互验收：这是一条用于检验截断和悬停时布局稳定性的中文长标题`
      : i % 3 === 1
        ? `${i + 1} · Reviewing a deliberately long task title across navigation, theme changes and keyboard focus without layout drift`
        : `${i + 1} · 任务 Task 123 · 简短标题`
  const { data: session } = await client.session.create(
    { scopeID: scopes[i % scopes.length], title },
    { throwOnError: true },
  )
  if (!session) throw new Error("Fixture session was not created")
  sessions.push({ id: session.id, scopeID: scopes[i % scopes.length], title })
}
await Bun.write(manifestFile, JSON.stringify({ scopes, sessions }, null, 2))
await Bun.write(path.join(home, "fixture.txt"), "Synthetic attachment for frontend acceptance. No personal content.\n")
console.log(`Created ${sessions.length} sessions in ${scopes.length} scopes.`)
