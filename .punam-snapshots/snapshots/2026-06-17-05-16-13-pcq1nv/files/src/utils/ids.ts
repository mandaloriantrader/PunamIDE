/**
 * ID Generator utility — generates unique IDs with optional prefix.
 * Ported from Zenith IDE for Punam IDE.
 */

let counter = 0;

export function generateId(prefix = "id"): string {
  counter++;
  return `${prefix}-${Date.now()}-${counter}`;
}
