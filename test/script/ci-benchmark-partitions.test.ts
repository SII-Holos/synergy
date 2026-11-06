import { expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { catalog } from "../../script/ci/catalog"

test("Docker selectors collect every retained lifecycle and native scenario exactly once", async () => {
  const tasks = (await catalog()).filter((task) => ["benchmark-docker", "benchmark-native"].includes(task.kind))
  const specs = [
    ...tasks.map((task) => ({ id: task.id, files: task.files, selection: task.selection })),
    {
      id: "all-lifecycle",
      files: [...new Set(tasks.filter((task) => task.kind === "benchmark-docker").flatMap((task) => task.files!))],
    },
    { id: "all-native", files: ["benchmark/test/test_matrix_docker.py"], selection: "not diagnostic" },
  ]
  const source = `import json,sys,pytest
records = {}
class Capture:
    def pytest_collection_finish(self, session):
        records[current['id']] = [item.nodeid for item in session.items]
for current in json.loads(sys.argv[1]):
    args = ['--collect-only','-q','-p','no:cacheprovider',*current['files']]
    if current.get('selection'): args += ['-k', current['selection']]
    code = pytest.main(args, plugins=[Capture()])
    if code: raise SystemExit(code)
print('CI_COLLECTION=' + json.dumps(records))
`
  const output = execFileSync(
    "uv",
    ["run", "--locked", "--project", "benchmark", "python", "-c", source, JSON.stringify(specs)],
    { encoding: "utf8", timeout: 60000, maxBuffer: 8 * 1024 * 1024 },
  )
  const collections = JSON.parse(
    output
      .split("\n")
      .find((line) => line.startsWith("CI_COLLECTION="))!
      .slice("CI_COLLECTION=".length),
  ) as Record<string, string[]>
  for (const task of tasks)
    expect(collections[task.id]!.map((id) => id.split("::").at(-1)).toSorted()).toEqual(task.scenarios!.toSorted())
  const lifecycle = tasks.filter((task) => task.kind === "benchmark-docker").flatMap((task) => collections[task.id]!)
  const expected = collections["all-lifecycle"]!.filter(
    (id) =>
      !id.includes("test_export_recovery") &&
      (!id.includes("test_oracle.py") || id.split("::").at(-1)!.startsWith("test_native_oracle")),
  )
  expect(lifecycle.toSorted()).toEqual(expected.toSorted())
  expect(new Set(lifecycle).size).toBe(lifecycle.length)
  const synergy = tasks.filter((task) => task.variant === "synergy").flatMap((task) => collections[task.id]!)
  expect(synergy.toSorted()).toEqual(collections["all-native"]!.toSorted())
  expect(new Set(synergy).size).toBe(synergy.length)
}, 70000)
