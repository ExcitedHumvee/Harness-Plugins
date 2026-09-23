/**
 * Node half of the sound-alerts plugin.
 *
 * This is a pure UI plugin: the sounds, their settings, and the header control
 * all live in the browser half, which ships through `exports["./client"]` and is
 * discovered by `@deepseek-ai/dsh-client-modules` through this package's
 * `dsh.client` declaration.
 *
 * The empty `apply` exists only so the package is a well-formed Cordis Loader
 * entry and therefore appears in the entry scan that composes
 * `window.__DSH_BOOT__`. There is no host-side behavior: preferences are
 * browser-local, so no settings namespace has to be registered on the host.
 *
 * @module dsh-sound-alerts
 */

/** Host plugin body — no host-side behavior for this surface plugin. */
export function apply() {}
