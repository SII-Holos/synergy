# Decision Record: Nullable config fields clear stored role settings

Status: implemented

## Problem

Settings → Models could set a model role's model string or a role's variant but never clear either. The cleared draft dropped the key from the generated patch (`newVal || undefined`, and `role_variant` entries were filtered out entirely), and the models config domain merges with `mergeDeep`, so the stored entry survived every save and the picker rendered it again after the refresh round trip. The save reported success, so the Default option looked dead. The only workaround was editing `10-models.jsonc` by hand.

## Decision

Model role strings (`model`, `nano_model`, `mini_model`, `mid_model`, `thinking_model`, `long_context_model`, `creative_model`, `vision_model`) and `role_variant` record values are now nullable in the config schema, following the convention already established by `boss.identityText` and `github.identitySync.name`/`email`: an explicit `null` is a stored "cleared" marker, and `remeda`'s `mergeDeep` replaces the old value with it, so the marker persists through the domain-file round trip. `serializeConfig` already writes `null` (it only drops `undefined`), so the marker lands on disk.

Three coordinated changes keep semantics clean:

- Config loading normalizes the markers away (`normalizeRoleNulls` in `loadStateValueInner`), so `Config.current()` readers see unset — cross-layer clear still works because the layer merge happens before normalization.
- Frontend `buildModelPatch` sends per-key explicit `null` for cleared roles and per-role `null` inside `role_variant`, preserving sibling entries under `mergeDeep`. A null clear is only sent when the server actually has a value, so a null never materializes an otherwise-empty object.
- The two type-sensitive variant readers (`Agent.modelRoleSummaries`, `SessionRootVariant.resolveName`) normalize or type-guard the null.

## Alternatives considered

**Omit-key delete semantics in the domain merge.** Making the server treat a missing key as "delete" (or sending an explicit tombstone list) would keep stored files free of `null` markers. It lost because settings saves patch whole domains derived from a UI draft: "absent" legitimately means "untouched, keep the stored value" for every other field, so delete-on-absent would need a parallel deletion channel, schema surface, and a second wire convention — strictly more machinery than reusing the nullable-marker convention two config extensions already use.

**Replacing the models domain on save (`replace-domain` merge policy or a whole-domain snapshot).** Sending the full models domain with removal-by-absence would clear correctly, but it turns concurrent edits (CLI writing one role while the panel saves another) into silent data loss, and the panel deliberately patches only changed fields today. Preserving last-writer-wins per key was worth more than marker-free files.

**Normalize `null` to deleted at the domain-write boundary instead of the load boundary.** Writing the file without the marker would produce cleaner domain files but breaks the cross-layer clear case: a lower-priority layer's value would be inherited again the moment the higher-priority marker is dropped, resurrecting the setting the user just cleared. The marker must survive in the owning layer's file.

## Consequences

Users can clear any model role and role variant from Settings, and the persisted domain file records the clear as an explicit `null` marker visible in `10-models.jsonc`. Every reader of the resolved config keeps seeing `string | undefined` because normalization strips markers at load; code that touches the stored domain view (`Config.domainGet`, the config file panel, direct file reads) must now tolerate `null`. The convention is now the third application of the nullable-clear pattern, which makes it the default answer for any Settings-clearable config value rather than a per-field decision. Channel-account `model`/`variant` fields have the same UI limitation but their own schema surface; they are intentionally not covered here.
