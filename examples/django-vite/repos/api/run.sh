#!/usr/bin/env bash
# Starts the Django API of one session, in the foreground, from the session worktree.
# Keeps the autoreloader on: the agent edits code while Probar runs, and the server must pick it up.
set -euo pipefail

export PYTHONUTF8=1
# django-environ does not override variables that are already set, so these win over .env.
export DB_NAME="${AGENTIFY_DB_NAME:?Agentify passes the session database}"
# Point anything that would leave the machine (queues, webhooks, mail) at local/disabled values here.
export EMAIL_BACKEND=django.core.mail.backends.console.EmailBackend

exec uv run --no-sync python manage.py runserver "127.0.0.1:${AGENTIFY_PORT:?}" --skip-checks
