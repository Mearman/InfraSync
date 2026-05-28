/**
 * Type narrowing helpers for GitHub API state objects.
 *
 * The engine passes `unknown` state to resource methods. Rather than
 * using type assertions (banned by project eslint config), these
 * helpers narrow safely using the `in` operator and typeof checks.
 */

// ─── State narrowing ─────────────────────────────────────────────────────────

/**
 * Get a string field from an unknown state object.
 * Returns `undefined` if the value isn't a non-null object,
 * the field is absent, or the field value isn't a string.
 */
export function getStringField(
  state: unknown,
  field: string,
): string | undefined {
  if (typeof state !== "object" || state === null) return undefined;
  if (!(field in state)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(state, field);
  if (descriptor === undefined) return undefined;
  return typeof descriptor.value === "string" ? descriptor.value : undefined;
}

/**
 * Get a nested string field from an unknown state object.
 * E.g. `getNestedString(state, "owner", "login")` → `state.owner.login`
 */
export function getNestedStringField(
  state: unknown,
  objectField: string,
  stringField: string,
): string | undefined {
  if (typeof state !== "object" || state === null) return undefined;
  if (!(objectField in state)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(state, objectField);
  if (descriptor === undefined) return undefined;
  return getStringField(descriptor.value, stringField);
}

/**
 * Get a number field from an unknown state object.
 */
export function getNumberField(
  state: unknown,
  field: string,
): number | undefined {
  if (typeof state !== "object" || state === null) return undefined;
  if (!(field in state)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(state, field);
  if (descriptor === undefined) return undefined;
  return typeof descriptor.value === "number" ? descriptor.value : undefined;
}
