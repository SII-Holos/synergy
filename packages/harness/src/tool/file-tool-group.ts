import { z } from "zod"

export const FileToolGroup = z.enum(["replace", "hashline", "patch"])
export type FileToolGroup = z.infer<typeof FileToolGroup>
