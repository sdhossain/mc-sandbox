#!/usr/bin/env bash
# 5 trials of mirror-hut with gpt-6.2-sol on the code-commands harness (survival mode), then the summary table.
# The same protocol as scripts/trials/gpt-6.2-sol.sh with only the harness changed. Results go to
# runs/trials-code-commands/ (kept apart from the skills trials in runs/trials/). Running it again runs only the
# trials still missing, so the model never gets more than REPEATS (default 5).
# Change the defaults with environment variables, for example: REPEATS=3 LOG_DIR=trials-code-commands-check
exec env HARNESS=code-commands GAME_MODE="${GAME_MODE:-survival}" LOG_DIR="${LOG_DIR:-trials-code-commands}" \
  "$(dirname "$0")/../run-trials.sh" "${CASE:-mirror-hut}" "${REPEATS:-5}" gpt-6.2-sol
