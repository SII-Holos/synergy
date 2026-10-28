export function upgradeCommand(file: string, output: "silent" | "stdout") {
  return `cat record.txt > ${file}; printf x >> effects.txt${output === "stdout" ? `; cat ${file}` : ""}`
}
