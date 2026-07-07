/**
 * Mrky Enabled State — Single source of truth for ON/OFF toggle.
 * All content modules import this instead of main.js to avoid circular dependencies.
 */

/** Global flag: is Mrky currently enabled? */
export let mrkyEnabled = true;

/**
 * Set the enabled state. Called by main.js only.
 * @param {boolean} value
 */
export function setMrkyEnabled(value) {
  mrkyEnabled = value;
}
