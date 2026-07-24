import { jsonSchema, tool, type JSONSchema7, type Tool as AITool } from "ai"

export namespace ToolCatalog {
  export interface Definition {
    id: string
    description: string
    inputSchema: JSONSchema7
  }

  export function modelTools(definitions: readonly Definition[]): Record<string, AITool> {
    const result: Record<string, AITool> = {}
    for (const definition of definitions) {
      result[definition.id] = tool({
        id: definition.id as never,
        description: definition.description,
        inputSchema: jsonSchema(definition.inputSchema),
      }) as AITool
    }
    return result
  }
}
