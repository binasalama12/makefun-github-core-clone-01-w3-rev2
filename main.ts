// Hazel Forge — a standalone GitHub-compatible forge in one Node process.
//
// Boot contract with the suite: bind an ephemeral port, POST {"port"} to
// $MAKEFUN_ENV_URL/register, serve git smart HTTP + REST v3 + GraphQL + MCP
// until GET $MAKEFUN_ENV_URL/done answers {"done":true}, then exit 0.

import { serve } from './src/server.ts';

// A suite that stops waiting should never leave a zombie forge behind.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => process.exit(0));
}

await serve();
