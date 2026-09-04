#!/bin/bash

# Single jq pass: extract every field we need, one per line, into an array.
mapfile -t F < <(jq -r '
    .model.display_name // .model.id // "unknown",
    (.effort.level // "normal"),
    (.context_window.context_window_size // 200000),
    (.context_window.current_usage.input_tokens // 0),
    (.context_window.current_usage.cache_creation_input_tokens // 0),
    (.context_window.current_usage.cache_read_input_tokens // 0),
    ([.todos[]? | select(.status != "deleted")] | length),
    ([.todos[]? | select(.status == "completed")] | length),
    (.rate_limits.five_hour.used_percentage // ""),
    (.rate_limits.five_hour.resets_at // ""),
    (.cwd // "")
')
model=${F[0]}      effort_raw=${F[1]}
ctx_max=${F[2]}    ctx_in=${F[3]}    ctx_cc=${F[4]}    ctx_cr=${F[5]}
total_tasks=${F[6]} completed=${F[7]}
rate_pct=${F[8]}   rate_reset=${F[9]}
cwd=${F[10]}

case "$effort_raw" in
    xhigh) effort="xhigh" ;;
    high)  effort="high"  ;;
    low)   effort="low"   ;;
    *)     effort="med"   ;;
esac

# Model: keep just the family name (fable/opus/sonnet/haiku), drop version
model_lc="${model,,}"
case "$model_lc" in
    *fable*)  model_name="fable"  ;;
    *opus*)   model_name="opus"   ;;
    *sonnet*) model_name="sonnet" ;;
    *haiku*)  model_name="haiku"  ;;
    *)        model_name="$model_lc" ;;
esac

# Context: % used
context_used=$(( ctx_in + ctx_cc + ctx_cr ))
if [ "$ctx_max" -gt 0 ]; then
    percent_used=$(( context_used * 100 / ctx_max ))
else
    percent_used=0
fi

# Tasks
if [ "${total_tasks:-0}" -gt 0 ] 2>/dev/null; then
    tasks=" | tasks:${completed}/${total_tasks}"
else
    tasks=""
fi

# 5-hour rate limit window
if [ -n "$rate_pct" ] && [ -n "$rate_reset" ]; then
    rate_used=$(awk -v p="$rate_pct" 'BEGIN { printf "%d", p + 0.5 }')
    secs_left=$(( rate_reset - $(date +%s) ))
    if [ "$secs_left" -le 0 ]; then
        reset_in="now"
    else
        h=$(( secs_left / 3600 ))
        m=$(( (secs_left % 3600) / 60 ))
        if [ "$h" -gt 0 ]; then
            reset_in="${h}h ${m}m"
        else
            reset_in="${m}m"
        fi
    fi
    rate=" | usage: ${rate_used}% (resets in ${reset_in})"
else
    rate=""
fi

# Folder: ~ at home, otherwise ~/<top-level dir> (the project)
if [ "$cwd" = "$HOME" ]; then
    folder="~"
elif [[ "$cwd" == "$HOME"/* ]]; then
    rest=${cwd#$HOME/}
    folder="~/${rest%%/*}"
else
    folder="$cwd"
fi

# Git branch (cheap, no fork to rev-parse if not in a repo)
git_branch=$(git symbolic-ref --quiet --short HEAD 2>/dev/null \
             || git rev-parse --short HEAD 2>/dev/null \
             || echo "no repo")

echo "${model_name} ${effort} | context: ${percent_used}%${tasks}${rate} | ${folder} | ${git_branch}"
