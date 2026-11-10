// Node rendering tests exercise markup; esbuild validates the actual CSS during build.
require.extensions['.css'] = () => {};
