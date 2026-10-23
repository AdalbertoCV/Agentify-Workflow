#!/usr/bin/env bash
# Starts the Vite frontend of one session. The browser only talks to Vite; Vite proxies /api to
# this session's Django, so the backend's CORS list never matters.
set -euo pipefail

here="${AGENTIFY_ROOT:?}/.agentify/repos/web"
export AGENTIFY_API_TARGET="http://127.0.0.1:${AGENTIFY_PORT_API:?Probar must also run the api repo}"
# Vite gives variables already in the environment priority over .env files.
export VITE_API_URL="http://localhost:${AGENTIFY_PORT:?}/api/"

# The wrapper config must live where `vite` resolves; node_modules is shared, the file is the same for every session.
cp "${here}/vite.agentify.mjs" node_modules/.agentify-vite.config.mjs
exec node node_modules/vite/bin/vite.js --config node_modules/.agentify-vite.config.mjs
