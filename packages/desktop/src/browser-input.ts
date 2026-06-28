export type ElectronInputModifier = NonNullable<Electron.InputEvent["modifiers"]>[number]

export function inputModifiers(input: unknown, options: { autoRepeat?: unknown } = {}): ElectronInputModifier[] {
  const modifiers = Array.isArray(input) ? input : []
  const result = new Set<ElectronInputModifier>()
  for (const modifier of modifiers) {
    if (modifier === "Shift") result.add("shift")
    if (modifier === "Control") result.add("control")
    if (modifier === "Alt") result.add("alt")
    if (modifier === "Meta") result.add("meta")
  }
  if (options.autoRepeat) result.add("isautorepeat")
  return [...result]
}
