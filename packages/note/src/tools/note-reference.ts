import { ResourceReference } from "@ericsanchezok/synergy-util/resource-reference"

export function noteReferenceLine(id: string, title: string): string {
  const label = title
    .replace(/\s+/g, " ")
    .trim()
    .replace(/&/g, "&amp;")
    .replace(/[\\`*_[\]<>]/g, "\\$&")
  return `Reference: [${label}](${ResourceReference.format({ kind: "note", id })})`
}
