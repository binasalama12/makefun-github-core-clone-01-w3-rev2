// Hazel Forge — a standalone GitHub-compatible forge in one Node process.
//
// Boot contract with the suite: bind an ephemeral port, POST {"port"} to
// $MAKEFUN_ENV_URL/register, serve git smart HTTP + REST v3 + GraphQL + MCP
// until GET $MAKEFUN_ENV_URL/done answers {"done":true}, then exit 0.

import { serve } from './src/server.ts';

await serve();
