/**
 * Shared encoding constants — single source of truth for agent constraints.
 *
 * These limits must stay in sync with the intent and script agent prompts.
 * Changing a value here should cascade to the prompt text (via placeholder
 * injection in builtin-internal.ts) and to the encoder user messages.
 */

/** Maximum character length for a valid intent string.
 *  Must match the constraint in intent.txt and the encoder user message. */
export const INTENT_MAX_CHARS = 150

/** Minimum character length for a non-junk intent. */
export const INTENT_MIN_CHARS = 10

/** Minimum character length for a non-junk script. */
export const SCRIPT_MIN_CHARS = 20

/** Minimum numbered steps required in a valid trajectory script. */
export const SCRIPT_MIN_STEPS = 2
