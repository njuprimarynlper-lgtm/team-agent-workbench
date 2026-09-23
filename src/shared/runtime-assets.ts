declare const __WORKBENCH_ASSETS__: string;

// The build embeds an immutable asset directory in each main process bundle.
// Existing processes keep their matching UI when another launch rebuilds dist.
export const runtimeAssets = typeof __WORKBENCH_ASSETS__ === 'string' ? __WORKBENCH_ASSETS__ : '.';
