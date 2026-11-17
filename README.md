# Hazel Forge

[![make.fun bounty](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/binasalama12/makefun-github-core-clone-01-w3-rev2/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/binasalama12/makefun-github-core-clone-01-w3-rev2/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone, GitHub-compatible git forge that runs as a single Node process
with no dependencies beyond the standard library. One in-memory store backs
four surfaces, so every object reads back identically on each of them:

- **Git smart HTTP** — protocol v2 (`ls-refs`, `fetch` with shallow/deepen)
  and v0 (`fetch`, `receive-pack` with report-status), fast-forward-only
  ref updates with per-ref reporting.
- **REST v3** — repositories, contents (create/update/delete with commits),
  branches, git refs, commits, labels, issues, comments and pull requests
  with squash merges.
- **GraphQL** — `viewer`, `repository`, Relay `node(id:)`, `__type`
  introspection, issue/pull-request connections with cursor pagination, and
  the create/close/merge/comment mutations.
- **MCP** — Streamable HTTP JSON-RPC (`server/discover` plus the legacy
  `initialize` handshake) with repository, issue and pull-request tools.

## Why it is fast

The fetch path is built around three caches: objects are hashed exactly once
when they enter the store, ancestor sets and parsed commits/trees are
memoised per repository, and built packs are cached per repository version —
so a depth-1 clone of a long history is one pack build served to every
concurrent caller, and an incremental fetch walks a memoised have-closure
instead of re-walking history.

## Run

```sh
node main.ts
```

The process binds an ephemeral port, registers it with the suite at
`$MAKEFUN_ENV_URL`, answers `GET /healthz`, and exits when the suite's
`/done` long-poll reports completion.

## Layout

- `main.ts` — the entrypoint and boot contract.
- `src/forge.ts` — the store: git objects, packs, refs, issues, pull requests.
- `src/gitproto.ts` — smart HTTP: advertisements, ls-refs, fetch, receive-pack.
- `src/restapi.ts` — the REST v3 surface.
- `src/gql.ts` — the GraphQL parser and executor.
- `src/mcp.ts` — the MCP surface.
- `src/server.ts` — HTTP plumbing, routing and registration.
