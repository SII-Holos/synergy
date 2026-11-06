const path = require("node:path")
const rules = require("./script/dependency-rules.json")
const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
module.exports = {
  forbidden: [
    ...Object.entries(rules).map(([owner, allowed]) => ({
      name: `ownership-${owner.replaceAll("/", "-")}`,
      severity: "error",
      from: { path: `^${escape(owner)}/src/` },
      to: { path: "^(packages|apps)/", pathNot: `^(${[owner, ...allowed].map(escape).join("|")})/` },
    })),
    {
      name: "libraries-do-not-import-applications",
      severity: "error",
      from: { path: "^packages/" },
      to: { path: "^apps/" },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    tsConfig: { fileName: path.resolve(__dirname, "packages/harness/tsconfig.json") },
  },
}
