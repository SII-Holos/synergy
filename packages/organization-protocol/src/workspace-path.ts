import { z } from "zod"

export const WorkspacePath = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (value) =>
      !value.includes("\\") &&
      !/[\x00-\x1f]/.test(value) &&
      !value.startsWith("/") &&
      !value.split("/").some((part) => !part || part === "." || part === "..") &&
      !/^[a-zA-Z]:/.test(value),
    "Expected a relative Workspace path",
  )
