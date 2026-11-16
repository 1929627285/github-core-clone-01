# github-core-clone-01

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/1929627285/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/1929627285/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A single-process, GitHub-compatible git forge: git smart HTTP (protocol v2 and v0, shallow fetch, push with report-status), the REST v3 API, GraphQL v4, and MCP tools, all over one in-memory store. No dependencies, no database, no git binary — just Node's standard library.

## Run it

```sh
node main.ts
```

The entry binds an ephemeral port, registers it at `$MAKEFUN_ENV_URL/register`, serves until the env answers `{"done": true}` on `$MAKEFUN_ENV_URL/done`, then exits 0. It expects `MAKEFUN_SHOP_TOKEN` for bearer authentication (when unset, requests are accepted without a token, for local development).

---

<sub>Entered on [make.fun](https://make.fun/?ref=797zmkyh&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
