export function parseModelID(model: string) {
  const [providerID, ...rest] = model.split("/")
  return { providerID, modelID: rest.join("/") }
}
