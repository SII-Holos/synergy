export function normalizeName(value) {
  return value.trim().replace(/  /g, " ")
}

export function initials(value) {
  return value
    .split(" ")
    .map((word) => word[0] ?? "")
    .join("")
    .toUpperCase()
}
