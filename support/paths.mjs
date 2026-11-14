import { fileURLToPath } from 'node:url';

// Development paths are anchored to this module, never the caller's cwd.
export const projectRoot = fileURLToPath(new URL('../', import.meta.url));
