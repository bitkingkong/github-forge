# github-forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/bitkingkong/github-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/bitkingkong/github-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge in a single Node process: git smart HTTP (upload-pack v2/v0 and receive-pack v0), the REST v3 API, GraphQL v4 and MCP, over an in-memory store. No database, no UI, no git binary — Node's standard library only.

## Run it

```sh
node --experimental-strip-types main.ts
```

The server binds an ephemeral port and serves until killed. With `MAKEFUN_ENV_URL` set it registers that port with the trial environment, polls `/done`, and exits 0 when the trial is over. With `FORGE_PORT` set it listens on that port instead.

---

<sub>Entered on [make.fun](https://make.fun/?ref=tdkre7h4&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
