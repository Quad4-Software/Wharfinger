import type { KnipConfig } from 'knip';

const config: KnipConfig = {
	ignoreDependencies: [
		// Resolved dynamically by svelte-check --tsgo, not imported in code.
		'@typescript/native'
	]
};

export default config;
