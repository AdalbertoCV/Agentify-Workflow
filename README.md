<p align="center">
  <img src="assets/banner.svg" alt="agentify-workflow — one ticket, one isolated session, one click" width="100%">
</p>

<p align="center">
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-34D399?style=flat-square"></a>
  <img alt="Status: beta" src="https://img.shields.io/badge/status-beta-FBBF24?style=flat-square">
  <img alt="Electron" src="https://img.shields.io/badge/electron-desktop-22D3EE?style=flat-square&logo=electron&logoColor=white">
  <img alt="Agents" src="https://img.shields.io/badge/agents-Claude%20Code%20%7C%20Codex%20%7C%20Gemini%20%7C%20opencode-A78BFA?style=flat-square">
  <img alt="Platform" src="https://img.shields.io/badge/platform-Windows-818CF8?style=flat-square">
</p>

<p align="center">
  <b>A desktop workspace for working on tickets that span many repositories with a coding agent.</b><br>
  Every ticket is a <i>session</i>: its own worktrees, its own database, its own ports, the agent, a browser and the diff — in one window.
</p>

---

## Why

Working with coding agents across several repos usually means a terminal per repo, worktrees piling
up in random folders, two dev servers fighting for port 8000, a shared database that one branch's
migrations break for every other branch, and deleting a worktree that silently follows a
`node_modules` junction and empties the original.

`agentify-workflow` turns all of that into one card per ticket.

## What a session gives you

| | |
|---|---|
| **Worktrees** | One per repo the ticket touches, from a fresh `origin/<trunk>` (or the ticket's existing branch). |
| **Database** | A clone of a *golden* database — empty, migrated from zero and seeded once — taken in about a second. Branch migrations only run when the branch adds them. |
| **Ports** | A private block per session, so any number of sessions run side by side. |
| **Agent** | Claude Code, Codex, Gemini or opencode in a real terminal inside the app. Resumes the conversation when you come back. |
| **Probar** | One button boots the whole stack: repos in the ticket run from its branch, the rest from a fresh trunk copy, each through a small `run.sh`. |
| **Browser** | An embedded browser on the session's app, with region and full-page screenshots copied straight to the clipboard. |
| **Diff** | What is not committed yet, per repo, collapsible, unified or side by side — plus **Commit and push** (never to protected branches). |
| **Delete** | One click removes servers, worktrees, branches and the session database. It only asks when work would be lost or another program is using the session. |

## Highlights

- **Fast.** Measured on a real Django + React project: creating a session ~8 s, its database ~1 s, the full stack up in ~10 s.
- **Generated start scripts.** Add a repo from the **Repos** tab and the agent reads it and writes its `run.sh` / `stop.sh` / config; you review and save.
- **Connectors tab.** Git, GitHub CLI, Docker, PostgreSQL, each agent CLI and Linear, with a one-click fix for whatever is missing.
- **Linear.** Pick a ticket from your list; the repos it names are preselected.
- **Mock data for every model.** `examples/django-vite/repos/api/seed_all_models.py` fills a few rows of every Django model of your project, with signals muted so nothing reaches queues or mail.
- **Safe by default.** Links are removed before folders, protected branches are never pushed, the source database is never written.

## Install

```bash
npm install
npm run dist      # → dist/Agentify-Setup-<version>.exe
```

Or run from source with `npm run dev`.

## Configure

Pick the folder that holds your repos. The app writes `agentify.config.json` there with the repos
and agents it finds. Each repo can declare:

```jsonc
{
  "name": "api",
  "trunk": "main",
  "copyFiles": [".env"],                 // gitignored files a fresh worktree needs
  "linkDirs": [".venv"],                 // heavy folders shared instead of reinstalled
  "db": { "source": "empty", "seed": ["…"], "migrationPaths": [":(glob)**/migrations/*.py"], "…": "…" },
  "setup": ["uv run --no-sync python manage.py migrate --noinput"],
  "run": { "script": ".agentify/repos/api/run.sh", "port": true, "needs": [] }
}
```

`run.sh` receives `AGENTIFY_PORT`, `AGENTIFY_PORT_<OTHER_REPO>`, `AGENTIFY_DB_NAME` and
`AGENTIFY_SESSION`. A complete Django + Vite setup lives in [`examples/django-vite`](examples/django-vite).

Optional `startPrompt` sends a first message to the agent in every new session, e.g.
`"/work {ticket}"`.

## Develop

```bash
npm test          # unit + integration tests (real git repos in temp folders)
npm run e2e       # drives the built app end to end with Playwright
```

## License

[MIT](LICENSE)
