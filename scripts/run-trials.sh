#!/usr/bin/env bash
# Runs a failure case for each model, one model after another, unattended, until the log holds the
# requested number of trials for each model (with this harness and game mode).
#
# Usage:  scripts/run-trials.sh [case] [trials per model] [model ...]
#   scripts/run-trials.sh                                   mirror-hut, 5 trials each for the four models below
#   scripts/trials/gpt-6.1-terra.sh                         the same for one model (one script per model)
#   scripts/run-trials.sh mirror-hut 5 gpt-6.2-sol gpt-6-luna
#
# Only the missing trials run, so running a script again never takes a model past that number. If the lab
# stops early (a crash), the script starts it again for the trials still missing, up to 3 times per model.
#
# Needs the server running (npm run server) and no other lab running. Each trial resets the case's area,
# so trials do not see each other. Results go to runs/trials/<case>.csv and .jsonl; the summary table is
# printed at the end. Watch live on the dashboard (http://127.0.0.1:8787) or by joining the server.
# Each trial's end state is saved under a short id (t1, t2, ...): look at one with "!load t7" in game.
# The harness and game mode are fixed below; change HARNESS and GAME_MODE for other settings.
# WORLD_SAVES=1 also keeps a copy of the whole world after each trial (about 20 MB each).
# LOG_DIR=trials-<name> logs to runs/trials-<name>/ instead of runs/trials/, to keep a set of trials apart.
# When the model ends its turn with a question, the trial answers once ("I'm not around; use your best
# judgement and finish."); AUTO_REPLY=0 turns that off.
set -euo pipefail
cd "$(dirname "$0")/.."

CASE="${1:-mirror-hut}"
REPEATS="${2:-5}"
shift $(( $# > 2 ? 2 : $# ))
MODELS=("$@")
if [ ${#MODELS[@]} -eq 0 ]; then
  MODELS=(gpt-6.2-sol gpt-6.2-astra gpt-6.1-terra gpt-6-luna)
fi
HARNESS="${HARNESS:-skills}"
GAME_MODE="${GAME_MODE:-survival}"
EXTRA_FLAGS=()
if [ "${WORLD_SAVES:-0}" = "1" ]; then
  EXTRA_FLAGS+=(--world-saves)
fi
if [ "${AUTO_REPLY:-1}" = "0" ]; then
  EXTRA_FLAGS+=(--no-auto-reply)
fi
LOG_FLAGS=()
if [ -n "${LOG_DIR:-}" ]; then
  LOG_FLAGS+=(--log-dir "$LOG_DIR")
fi

for model in "${MODELS[@]}"; do
  echo "=== ${CASE}: ${REPEATS} trials with ${model} (${HARNESS}, ${GAME_MODE}) ==="
  for attempt in 1 2 3; do
    status=0
    node src/cli/main.ts trials "$CASE" --until "$REPEATS" --model "$model" --harness "$HARNESS" \
      --game-mode "$GAME_MODE" "${EXTRA_FLAGS[@]+"${EXTRA_FLAGS[@]}"}" "${LOG_FLAGS[@]+"${LOG_FLAGS[@]}"}" || status=$?
    if [ "$status" -eq 0 ]; then
      break
    fi
    if [ "$status" -eq 130 ]; then
      echo "Interrupted." >&2
      exit 130
    fi
    echo "Trials with ${model} stopped early (attempt ${attempt} of 3); starting again for the missing ones." >&2
  done
done

echo
node src/cli/main.ts trials "$CASE" --summary "${LOG_FLAGS[@]+"${LOG_FLAGS[@]}"}"
