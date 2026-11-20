#!/usr/bin/env bash
# 5 trials of mirror-hut with gpt-6.2-astra (skills harness, survival mode), then the summary table.
# Change the defaults with environment variables, for example: REPEATS=3 CASE=mirror-shed HARNESS=code GAME_MODE=creative
# WORLD_SAVES=1 also keeps a copy of the whole world after each trial. See scripts/run-trials.sh.
exec "$(dirname "$0")/../run-trials.sh" "${CASE:-mirror-hut}" "${REPEATS:-5}" gpt-6.2-astra
