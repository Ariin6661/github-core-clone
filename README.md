# github-core-clone

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/Ariin6661/github-core-clone/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/Ariin6661/github-core-clone/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone GitHub-compatible git forge in one Node 22 process: git smart HTTP (upload-pack v2, receive-pack v0), REST v3, GraphQL and MCP from its own in-memory store, no UI, no git binary, no outside service.

## What it does

- **Git core** (`src/gitcore.ts`) — a from-scratch object store (loose objects, packfiles, delta resolution) with commits, trees, blobs, refs, merges and diffs, implemented in TypeScript with no `git` binary involved.
- **Git smart HTTP** (`src/githttp.ts`) — `git-upload-pack` v2 and `git-receive-pack` v0 over HTTP, so a real `git clone` / `git push` works against the forge.
- **REST v3** (`src/rest.ts`) — the GitHub REST API surface the suite exercises: repositories, branches, commits, issues, pull requests and more.
- **GraphQL** (`src/graphql.ts`) — a GitHub-compatible GraphQL endpoint, including repository, issue, pull-request and file queries.
- **MCP** (`src/mcp.ts`) — the same forge exposed as Model Context Protocol tools.
- **Store & scenario** (`src/store.ts`, `src/scenario.ts`) — everything lives in one in-memory store, seeded with a scenario the test suite drives.
- **Server & lifecycle** (`src/server.ts`, `main.ts`) — binds an ephemeral port, registers it with the make.fun suite, serves until the suite says the trial is done, then exits 0.

## Run it

```sh
node main.ts
```

Requires Node 22.18 or newer, no dependencies to install and no build step. The entry expects the suite to provide `MAKEFUN_ENV_URL` and `MAKEFUN_SHOP_TOKEN`: it binds an ephemeral port, registers that port with the suite, serves until the trial is done, then exits 0. `npm start` runs the same command.

---

<sub>Entered on [make.fun](https://make.fun/?ref=k7ew9786&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
