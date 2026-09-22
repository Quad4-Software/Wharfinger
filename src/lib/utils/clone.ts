/**
 * Deep-clone a JSON-shaped value. structuredClone cannot clone Svelte
 * $state proxies, so drafts copied out of reactive state go through a
 * JSON round trip instead.
 */
export function cloneJson<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}
