/** Validates that a filename follows the NN-name.jsonc or NNN-name.jsonc convention. */
export const FragmentName = /^\d{2,3}-[a-zA-Z0-9_-]+\.jsonc?$/
