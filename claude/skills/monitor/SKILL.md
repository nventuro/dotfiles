---
name: monitor
description: Start, find or stop the monitor webapp for the current repo — a local page that shows where each worktree's PR stands and which PRs request the user's review, starts headless research sessions on what needs the user, and hands each one over as a `claude --resume` command. Use when the user says "/monitor".
argument-hint: "[--port <n>] [--max-budget-usd <n>] | stop"
allowed-tools: [Bash]
disallowed-tools: [Edit, Write, NotebookEdit]
disable-model-invocation: true
---

# Monitor

Make sure the monitor webapp is running for the repo of the current directory,
and give the user its URL. The server covers only that repo: its worktrees and
the review requests in it.

## 1. Find the server's state directory

```bash
repo=$(bash -c 'source ~/.claude/scripts/wt-lib.sh && github_repo . origin')
state_dir="$HOME/.claude/monitor/${repo%%/*}__${repo#*/}"
```

If this fails, report its error and stop: the current directory is not a
checkout of a GitHub repo.

## 2. Reuse or stop a running server

If `$state_dir/server.json` exists and the `pid` in it is alive (`kill -0`),
a server is already running:

- with the argument `stop`: `kill` that pid, wait up to 10 s for
  `server.json` to disappear, and report that it stopped. Research sessions it
  was running end with it, and can still be resumed.
- otherwise: report its `url` and end. Arguments other than `stop` do not
  apply to a running server; say so if any were given.

A `server.json` whose pid is dead is left over from a crash: delete it, so that
step 3 does not mistake it for the new server's, and continue. With `stop` and no live server, report that none is running and end.

## 3. Start it

Start it detached, so it keeps running after this session ends, passing the
skill's arguments through, and wait up to 30 s for `$state_dir/server.json` to
appear. Run both in one Bash call, since `$!` does not carry over to the next:

```bash
mkdir -p "$state_dir"
setsid -w nohup node ~/.claude/scripts/monitor/server.mjs --state-dir "$state_dir" \
  -C "$PWD" <arguments> >>"$state_dir/server.log" 2>&1 </dev/null &
pid=$!
for _ in $(seq 60); do
  [ -f "$state_dir/server.json" ] && break
  kill -0 "$pid" 2>/dev/null || break
  sleep 0.5
done
```

`-w` keeps `$!` alive for as long as the server runs. Without it, setsid forks
whenever it starts as a process group leader, which is what a background job is
under job control, and `$!` exits at once.

If `server.json` is still missing after the loop, the server exited or never
became ready: report the last lines of `$state_dir/server.log` and stop.

## 4. Report

Give the user:

1. the `url` from `server.json`. It carries the access token after `#`, so
   the whole URL is needed;
2. that from another machine they reach it by forwarding the port in the URL,
   since the server listens on 127.0.0.1 only;
3. that it starts research sessions on its own when a PR needs them, and that
   each one spends tokens;
4. that `/monitor stop` stops it.
