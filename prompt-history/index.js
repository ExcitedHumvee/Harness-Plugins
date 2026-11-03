/**
 * Node half of the prompt-history plugin.
 *
 * This is a pure UI plugin: the history, the key handling, and the composer
 * writes all live in the browser half, which ships through
 * `exports["./client"]` and is discovered by `@deepseek-ai/dsh-client-modules`
 * through this package's `dsh.client` declaration.
 *
 * The empty `apply` exists only so the package is a well-formed Cordis Loader
 * entry and therefore appears in the entry scan that composes
 * `window.__DSH_BOOT__`. There is no host-side behavior: history is derived from
 * conversation data the client already has, and nothing is stored.
 *
 * @module dsh-prompt-history
 */

/** Host plugin body — no host-side behavior for this surface plugin. */
export function apply() {}
