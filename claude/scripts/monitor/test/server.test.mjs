import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

import { STOPPED_REASON } from "../server.mjs";
import {
  api,
  check,
  FAKE_WT_REMOVE,
  finishedPr,
  Harness,
  openPr,
  REPO,
  request,
  scenario,
  sha,
  SERVER,
  thread,
  waitFor,
  worktree,
} from "./fixtures.mjs";

function harness(t) {
  const h = new Harness();
  t.after(() => h.close());
  return h;
}

async function state(server) {
  const res = await api(server, "GET", "/api/state");
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body;
}

function research(h, key) {
  return h.records()[key];
}

function waitForStatus(h, key, status) {
  return waitFor(
    () => research(h, key)?.status === status && research(h, key),
    `${key} to be ${status}`,
  );
}

function byBranch(s) {
  return Object.fromEntries(s.worktrees.map((w) => [w.branch, w]));
}

function ciOnly(root, fields = {}) {
  return {
    repo: REPO,
    worktrees: [
      worktree(
        root,
        "fix-ci",
        openPr(681, {
          ci: {
            result: "fail",
            checks: [check("e2e", "completed", "failure")],
          },
          ...fields,
        }),
      ),
    ],
    review_requests: [],
  };
}

test("serves every worktree's state and this repo's review requests, and researches what needs it", async (t) => {
  const h = harness(t);
  h.writeSnapshot(scenario(h.root));
  const server = await h.start();
  assert.equal(server.repo, REPO);
  for (const key of [
    "ci-failure:fix-ci",
    "review-feedback:address-review",
    "merge-conflict:conflicting",
    "review-request:700",
  ]) {
    await waitForStatus(h, key, "done");
  }
  const s = await state(server);

  assert.deepEqual(
    [
      s.repo,
      s.checkout,
      s.fetching,
      s.error,
      s.running,
      s.queued,
      s.max_running,
    ],
    [REPO, "~/checkout", false, null, 0, 0, 2],
  );
  assert.ok(
    Date.parse(s.fetched_at) <= Date.now() &&
      Date.parse(s.next_fetch_at) > Date.now(),
  );
  assert.deepEqual(
    s.worktrees.map((w) => [w.state, w.branch]),
    [
      ["done", "merged-one"],
      ["local", "no-pr"],
      ["needs", "fix-ci"],
      ["ready", "ready-one"],
      ["ready", "stacked"],
      ["waiting", "waiting-ci"],
      ["needs", "address-review"],
      ["local", "drafty"],
      ["needs", "conflicting"],
      ["done", "closed-one"],
      ["waiting", "mergeable-unknown"],
    ],
  );

  const w = byBranch(s);
  assert.deepEqual(
    [
      w["no-pr"].path,
      w["no-pr"].dirty_files,
      w["no-pr"].dirty_submodules,
      w["no-pr"].badges,
      w["no-pr"].pr,
    ],
    ["~/wt/no-pr", 35, ["vendor/lib"], ["35 uncommitted"], null],
  );
  assert.deepEqual(w["ready-one"].badges, ["2 unpushed", "1 behind PR"]);
  assert.equal(w.stacked.pr.base, "ready-one");

  const ciSession = h.callsNamed("ci-failure #681")[0].session_id;
  assert.deepEqual(w["fix-ci"].triggers, [
    {
      kind: "ci-failure",
      detail: "CI failing",
      key: "ci-failure:fix-ci",
      name: "ci-failure #681",
      research: {
        key: "ci-failure:fix-ci",
        kind: "ci-failure",
        status: "done",
        name: "ci-failure #681",
        session_id: ciSession,
        dir: "~/wt/fix-ci",
        queued_at: research(h, "ci-failure:fix-ci").queued_at,
        started_at: research(h, "ci-failure:fix-ci").started_at,
        finished_at: research(h, "ci-failure:fix-ci").finished_at,
        reason: null,
        result: "stub result for ci-failure #681",
        cost_usd: 0.0034,
        resume_command: `cd ~/wt/fix-ci && claude --resume ${ciSession}`,
        stale: false,
      },
    },
  ]);
  assert.deepEqual(
    w["fix-ci"].pr.checks.map((c) => [
      c.name,
      c.status,
      c.conclusion,
      c.failing,
    ]),
    [
      ["build", "completed", "success", false],
      ["e2e", "completed", "failure", true],
      ["lint", "completed", "skipped", false],
    ],
  );

  const review = w["address-review"];
  assert.deepEqual(
    [
      review.triggers[0].kind,
      review.triggers[0].detail,
      review.triggers[0].research.status,
    ],
    [
      "review-feedback",
      "changes requested by carol; 2 unresolved threads",
      "done",
    ],
  );
  assert.deepEqual(
    [
      review.pr.threads_total,
      review.pr.threads_unresolved,
      review.pr.changes_requested,
    ],
    [3, 2, ["carol"]],
  );
  assert.deepEqual(review.pr.unresolved_threads, [
    {
      path: "src/a.ts",
      author: "carol",
      url: `https://github.com/${REPO}/pull/0#discussion_src/a.ts`,
      outdated: true,
    },
    {
      path: "src/b.ts",
      author: "erin",
      url: `https://github.com/${REPO}/pull/0#discussion_src/b.ts`,
      outdated: false,
    },
  ]);
  const [conflicts] = w.conflicting.triggers;
  assert.deepEqual(
    [
      conflicts.kind,
      conflicts.detail,
      conflicts.key,
      conflicts.research.kind,
      conflicts.research.status,
    ],
    [
      "merge-conflict",
      "conflicts with main",
      "merge-conflict:conflicting",
      "merge-conflict",
      "done",
    ],
  );
  assert.deepEqual(w.drafty.triggers, []);

  assert.equal(
    w["merged-one"].remove_command,
    `cd ~/checkout && ${FAKE_WT_REMOVE} merged-one`,
  );
  assert.deepEqual(
    s.worktrees.filter((x) => x.remove_command !== null).map((x) => x.branch),
    ["merged-one"],
  );
  assert.deepEqual(
    [
      w["closed-one"].pr.state,
      w["closed-one"].pr.ci_result,
      w["closed-one"].pr.checks,
      w["closed-one"].pr.approved,
    ],
    ["closed", null, [], []],
  );

  assert.deepEqual(
    s.review_requests.map((r) => [
      r.number,
      r.recent,
      r.state,
      r.head,
      r.research?.status ?? null,
    ]),
    [
      [700, true, "researched", "7777777", "done"],
      [701, false, "new", "8888888", null],
    ],
  );
  assert.deepEqual(
    h
      .calls()
      .map((call) => call.name)
      .sort(),
    [
      "ci-failure #681",
      "merge-conflict #690",
      "review-feedback #687",
      "review-request #700",
    ],
  );
  for (const call of h.calls())
    assert.ok(!call.argv.includes("--max-budget-usd"), call.name);
});

test("spawns claude with the filled prompt and tools, the budget, the research's directory and the environment", async (t) => {
  const h = harness(t);
  h.writeSnapshot(scenario(h.root));
  await h.start({
    args: ["--port", "0", "--max-budget-usd", "1.5"],
    env: { CI_USERNAME: "ci-user", CI_PASSWORD: "ci-pass" },
  });
  await waitFor(() => h.calls().length === 4, "four runs");
  const [ci] = h.callsNamed("ci-failure #681");
  const [feedback] = h.callsNamed("review-feedback #687");
  const [conflicts] = h.callsNamed("merge-conflict #690");
  const [review] = h.callsNamed("review-request #700");
  const common = (id) => ["--session-id", id];
  const pull = (n) => `https://github.com/${REPO}/pull/${n}`;

  assert.deepEqual(ci.argv, [
    "-p",
    `ci ${REPO}#681 fix-ci -> main\nurl ${pull(681)}\ntitle PR 681\nhead ${sha("c")}\ndir ${h.root}/wt/fix-ci\nfailing:\n- e2e: https://ci.example/e2e\n`,
    ...common(ci.session_id),
    "--name",
    "ci-failure #681",
    "--output-format",
    "json",
    "--permission-mode",
    "acceptEdits",
    "--allowedTools",
    `Bash(git -C ${h.root}/wt/fix-ci status:*)`,
    "--max-budget-usd",
    "1.5",
  ]);
  assert.deepEqual(feedback.argv, [
    "-p",
    `feedback ${REPO}#687 address-review -> main\nurl ${pull(687)}\ntitle PR 687\nhead ${sha("d")}\ndir ${h.root}/wt/address-review\nthreads:\n` +
      `- src/a.ts (by carol, outdated): ${pull(0)}#discussion_src/a.ts\n- src/b.ts (by erin): ${pull(0)}#discussion_src/b.ts\nchanges: carol\n`,
    ...common(feedback.session_id),
    "--name",
    "review-feedback #687",
    "--output-format",
    "json",
    "--permission-mode",
    "dontAsk",
    "--disallowedTools",
    "Bash(git push:*)",
    "--max-budget-usd",
    "1.5",
  ]);
  assert.deepEqual(conflicts.argv, [
    "-p",
    `conflicts ${REPO}#690 conflicting -> main\nurl ${pull(690)}\ntitle PR 690\nhead ${sha("a")}\ndir ${h.root}/wt/conflicting\n`,
    ...common(conflicts.session_id),
    "--name",
    "merge-conflict #690",
    "--output-format",
    "json",
    "--permission-mode",
    "dontAsk",
    "--allowedTools",
    "Bash(git fetch origin main)",
    "--max-budget-usd",
    "1.5",
  ]);
  assert.deepEqual(review.argv, [
    "-p",
    `review ${REPO}#700 by dave\nurl ${pull(700)}\ntitle Request 700\nhead ${sha("7")}\ndir ${h.checkout}\n`,
    ...common(review.session_id),
    "--name",
    "review-request #700",
    "--output-format",
    "json",
    "--permission-mode",
    "plan",
    "--allowedTools",
    "Read",
    "Bash(gh pr view 700:*)",
    "--disallowedTools",
    "Edit",
    "--max-budget-usd",
    "1.5",
  ]);
  assert.deepEqual(
    [ci.cwd, feedback.cwd, conflicts.cwd, review.cwd],
    [
      path.join(h.root, "wt/fix-ci"),
      path.join(h.root, "wt/address-review"),
      path.join(h.root, "wt/conflicting"),
      h.checkout,
    ],
  );
  for (const call of [ci, feedback, conflicts, review]) {
    assert.deepEqual(
      call.env,
      { CI_USERNAME: "ci-user", CI_PASSWORD: "ci-pass" },
      call.name,
    );
  }

  const done = await waitForStatus(h, "ci-failure:fix-ci", "done");
  const stdout = fs.readFileSync(
    path.join(h.stateDir, "runs", `${done.session_id}.stdout`),
    "utf8",
  );
  assert.equal(JSON.parse(stdout).result, "stub result for ci-failure #681");
  assert.ok(
    fs.existsSync(path.join(h.stateDir, "runs", `${done.session_id}.stderr`)),
  );
});

test("starts new research when the head moves or the review feedback changes, keeping the old run in previous", async (t) => {
  const h = harness(t);
  const threads = [thread("src/a.ts", "carol")];
  const snapshot = (head, reviewThreads) => {
    const s = ciOnly(h.root, { head, review_threads: reviewThreads });
    return s;
  };
  h.writeSnapshot(snapshot(sha("c"), threads));
  const server = await h.start();
  const firstCi = await waitForStatus(h, "ci-failure:fix-ci", "done");
  const firstReview = await waitForStatus(h, "review-feedback:fix-ci", "done");

  assert.deepEqual((await api(server, "POST", "/api/refresh")).body, {
    ok: true,
  });
  await sleep(200);
  assert.equal(h.calls().length, 2, "an unchanged snapshot starts nothing");

  h.writeSnapshot(snapshot(sha("c"), [...threads, thread("src/b.ts", "erin")]));
  await api(server, "POST", "/api/refresh");
  await waitFor(
    () => h.callsNamed("review-feedback #681").length === 2,
    "a second feedback run",
  );
  const secondReview = await waitForStatus(h, "review-feedback:fix-ci", "done");
  assert.deepEqual(secondReview.previous, [
    {
      session_id: firstReview.session_id,
      status: "done",
      finished_at: firstReview.finished_at,
    },
  ]);
  assert.equal(
    h.callsNamed("ci-failure #681").length,
    1,
    "the CI fingerprint did not change",
  );

  h.writeSnapshot(snapshot(sha("e"), [...threads, thread("src/b.ts", "erin")]));
  await api(server, "POST", "/api/refresh");
  await waitFor(
    () => h.callsNamed("ci-failure #681").length === 2,
    "a second CI run",
  );
  const secondCi = await waitForStatus(h, "ci-failure:fix-ci", "done");
  assert.deepEqual(secondCi.previous, [
    {
      session_id: firstCi.session_id,
      status: "done",
      finished_at: firstCi.finished_at,
    },
  ]);
  assert.equal(secondCi.head, sha("e"));
  assert.match(
    h.callsNamed("ci-failure #681")[1].argv[1],
    new RegExp(`^head ${sha("e")}$`, "m"),
  );
  await waitFor(
    () => h.callsNamed("review-feedback #681").length === 3,
    "a third feedback run, for the new head",
  );
});

test("starts CI research only once every check on the head has finished", async (t) => {
  const h = harness(t);
  const failed = check("e2e", "completed", "failure");
  const ci = (lint) =>
    ciOnly(h.root, { ci: { result: "fail", checks: [failed, lint] } });
  h.writeSnapshot(ci(check("lint", "in_progress", null)));
  const server = await h.start();
  await sleep(200);
  assert.equal(h.calls().length, 0, "a check is still running");

  h.writeSnapshot(ci(check("lint", "completed", "failure")));
  await api(server, "POST", "/api/refresh");
  await waitForStatus(h, "ci-failure:fix-ci", "done");
  assert.match(
    h.callsNamed("ci-failure #681")[0].argv[1],
    /^- lint: https:\/\/ci\.example\/lint$/m,
  );
});

test("fails runs that error, does not retry them automatically, and retries one on request", async (t) => {
  const h = harness(t);
  h.behave({
    "ci-failure #681": { outcome: "exit" },
    "review-feedback #687": { outcome: "is_error" },
    "review-request #700": { outcome: "garbage" },
  });
  h.writeSnapshot(scenario(h.root));
  const server = await h.start();
  const ci = await waitForStatus(h, "ci-failure:fix-ci", "failed");
  const feedback = await waitForStatus(
    h,
    "review-feedback:address-review",
    "failed",
  );
  const review = await waitForStatus(h, "review-request:700", "failed");
  assert.deepEqual(
    [ci.reason, feedback.reason, feedback.cost_usd, review.reason],
    ["stub-claude: boom", "error_max_budget_usd", 0.5, "exit code 0"],
  );

  const s = await state(server);
  const view = byBranch(s)["fix-ci"].triggers[0].research;
  assert.deepEqual(
    [view.status, view.reason, view.resume_command],
    [
      "failed",
      "stub-claude: boom",
      `cd ~/wt/fix-ci && claude --resume ${ci.session_id}`,
    ],
  );
  assert.equal(
    s.review_requests[0].state,
    "new",
    "a failed review request is still new",
  );

  await api(server, "POST", "/api/refresh");
  await sleep(200);
  assert.equal(h.calls().length, 4, "a refresh retries nothing");

  h.behave({});
  assert.deepEqual(
    (
      await api(server, "POST", "/api/research", {
        body: { key: "ci-failure:fix-ci" },
      })
    ).body,
    { ok: true },
  );
  await waitFor(
    () => h.callsNamed("ci-failure #681").length === 2,
    "the retry",
  );
  const retried = await waitForStatus(h, "ci-failure:fix-ci", "done");
  assert.deepEqual(retried.previous, [
    {
      session_id: ci.session_id,
      status: "failed",
      finished_at: ci.finished_at,
    },
  ]);
});

test("researches recent review requests on arrival, and older ones and outdated ones only on request", async (t) => {
  const h = harness(t);
  const requests = (head700) => ({
    repo: REPO,
    worktrees: [],
    review_requests: [
      request(702, { daysAgo: 1, repo: "acme/other" }),
      request(700, { daysAgo: 2, head: head700 }),
      request(701, { daysAgo: 30, head: sha("8") }),
    ],
  });
  h.writeSnapshot(requests(sha("7")));
  const server = await h.start();
  const first = await waitForStatus(h, "review-request:700", "done");
  await sleep(200);
  assert.deepEqual(
    h.calls().map((call) => call.name),
    ["review-request #700"],
  );
  assert.deepEqual(
    (await state(server)).review_requests.map((r) => [
      r.number,
      r.recent,
      r.state,
      r.research?.status ?? null,
    ]),
    [
      [700, true, "researched", "done"],
      [701, false, "new", null],
    ],
  );

  const other = await api(server, "POST", "/api/research", {
    body: { key: "review-request:702" },
  });
  assert.deepEqual(
    [other.status, other.body],
    [
      404,
      {
        error:
          "no current trigger or review request has key review-request:702",
      },
    ],
  );
  assert.equal(
    (
      await api(server, "POST", "/api/research", {
        body: { key: "review-request:701" },
      })
    ).status,
    200,
  );
  await waitForStatus(h, "review-request:701", "done");
  assert.equal((await state(server)).review_requests[1].state, "researched");

  h.writeSnapshot(requests(sha("9")));
  await api(server, "POST", "/api/refresh");
  const outdated = (await state(server)).review_requests[0];
  assert.deepEqual(
    [
      outdated.state,
      outdated.head,
      outdated.research.status,
      outdated.research.stale,
    ],
    ["outdated", "9999999", "done", true],
  );
  await sleep(200);
  assert.equal(
    h.callsNamed("review-request #700").length,
    1,
    "an outdated request is not re-run automatically",
  );

  assert.equal(
    (
      await api(server, "POST", "/api/research", {
        body: { key: "review-request:700" },
      })
    ).status,
    200,
  );
  const rerun = await waitFor(
    () =>
      research(h, "review-request:700").previous.length === 1 &&
      research(h, "review-request:700").status === "done" &&
      research(h, "review-request:700"),
    "the re-run",
  );
  assert.equal(rerun.head, sha("9"));
  assert.deepEqual(rerun.previous, [
    {
      session_id: first.session_id,
      status: "done",
      finished_at: first.finished_at,
    },
  ]);
  assert.match(
    h.callsNamed("review-request #700")[1].argv[1],
    new RegExp(`^head ${sha("9")}$`, "m"),
  );
  const researched = (await state(server)).review_requests[0];
  assert.deepEqual(
    [researched.state, researched.research.stale],
    ["researched", false],
  );
});

test("runs at most two sessions at once and starts queued ones in order", async (t) => {
  const h = harness(t);
  h.behave({ "*": { hold: true } });
  h.writeSnapshot(scenario(h.root));
  const server = await h.start();
  await waitFor(() => h.calls().length === 2, "two runs");
  await sleep(200);
  assert.deepEqual(
    h
      .calls()
      .map((call) => call.name)
      .sort(),
    ["ci-failure #681", "review-feedback #687"],
  );
  let s = await state(server);
  assert.deepEqual([s.running, s.queued], [2, 2]);
  assert.deepEqual(
    [
      s.review_requests[0].research.status,
      s.review_requests[0].research.session_id,
      s.review_requests[0].research.resume_command,
    ],
    ["queued", null, null],
  );

  assert.equal(
    (
      await api(server, "POST", "/api/research", {
        body: { key: "review-request:701" },
      })
    ).status,
    200,
  );
  const queued = await api(server, "POST", "/api/research", {
    body: { key: "review-request:701" },
  });
  assert.deepEqual(
    [queued.status, queued.body],
    [409, { error: "review-request:701 is already queued" }],
  );
  const running = await api(server, "POST", "/api/research", {
    body: { key: "ci-failure:fix-ci" },
  });
  assert.deepEqual(
    [running.status, running.body],
    [409, { error: "ci-failure:fix-ci is already running" }],
  );
  s = await state(server);
  assert.deepEqual([s.running, s.queued], [2, 3]);

  h.release("ci-failure #681");
  await waitFor(
    () => h.callsNamed("merge-conflict #690").length === 1,
    "the first queued run",
  );
  await sleep(200);
  assert.equal(h.callsNamed("review-request #700").length, 0);
  s = await state(server);
  assert.deepEqual([s.running, s.queued], [2, 2]);

  h.release("review-feedback #687");
  await waitFor(
    () => h.callsNamed("review-request #700").length === 1,
    "the second queued run",
  );
  h.release("merge-conflict #690");
  await waitFor(
    () => h.callsNamed("review-request #701").length === 1,
    "the run queued on request",
  );
  h.release();
  await waitForStatus(h, "review-request:701", "done");
  await waitForStatus(h, "review-request:700", "done");
  s = await state(server);
  assert.deepEqual([s.running, s.queued], [0, 0]);
});

test("answers POST /api/research with 404 for keys without a current trigger and 400 for a bad body", async (t) => {
  const h = harness(t);
  h.writeSnapshot(scenario(h.root));
  const server = await h.start();
  for (const key of [
    "ci-failure:conflicting",
    "merge-conflict:ready-one",
    "review-feedback:ready-one",
    "ci-failure:drafty",
    "ci-failure:merged-one",
    "review-request:702",
    "review-request:9999",
  ]) {
    const res = await api(server, "POST", "/api/research", { body: { key } });
    assert.deepEqual(
      [res.status, res.body],
      [404, { error: `no current trigger or review request has key ${key}` }],
    );
  }
  for (const body of ["not json", "{}", '{"key": 7}']) {
    const res = await api(server, "POST", "/api/research", { body });
    assert.deepEqual(
      [res.status, res.body],
      [400, { error: 'the body must be {"key": "<research key>"}' }],
      body,
    );
  }
});

test("requires the token on the API and a local Host everywhere", async (t) => {
  const h = harness(t);
  h.writeSnapshot(scenario(h.root));
  const server = await h.start();
  for (const token of [null, "wrong"]) {
    for (const [method, urlPath] of [
      ["GET", "/api/state"],
      ["POST", "/api/refresh"],
      ["POST", "/api/research"],
    ]) {
      const res = await api(server, method, urlPath, { token });
      assert.deepEqual(
        [res.status, res.body],
        [401, { error: "missing or wrong token" }],
        `${method} ${urlPath}`,
      );
    }
  }
  const foreign = await api(server, "GET", "/api/state", {
    host: `evil.example:${server.port}`,
  });
  assert.equal(foreign.status, 403);
  assert.equal(
    (
      await api(server, "GET", "/", {
        token: null,
        host: `evil.example:${server.port}`,
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await api(server, "GET", "/api/state", {
        host: `127.0.0.1:${server.port + 1}`,
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await api(server, "GET", "/api/state", {
        host: `localhost:${server.port}`,
      })
    ).status,
    200,
  );
  assert.equal((await api(server, "GET", "/api/nothing")).status, 404);

  const page = await api(server, "GET", "/", { token: null });
  const index = path.join(path.dirname(SERVER), "index.html");
  assert.deepEqual(
    [page.status, page.body],
    [200, fs.readFileSync(index, "utf8")],
  );
  assert.match(page.headers["content-type"], /^text\/html/);
});

test("shares one wt-status run between refreshes made while it is in flight", async (t) => {
  const h = harness(t);
  h.writeSnapshot(scenario(h.root));
  const server = await h.start();
  const before = h.wtStatusCalls().length;
  assert.deepEqual(h.wtStatusCalls()[0], ["-C", h.checkout]);

  h.holdWtStatus(true);
  const first = api(server, "POST", "/api/refresh");
  await waitFor(
    () => h.wtStatusCalls().length === before + 1,
    "the refresh's wt-status run",
  );
  const second = api(server, "POST", "/api/refresh");
  const during = await state(server);
  assert.deepEqual([during.fetching, during.next_fetch_at], [true, null]);
  await sleep(200);
  h.holdWtStatus(false);
  assert.deepEqual(
    [(await first).body, (await second).body],
    [{ ok: true }, { ok: true }],
  );
  assert.equal(h.wtStatusCalls().length, before + 1);
  assert.equal((await state(server)).fetching, false);
});

test("keeps the last snapshot and reports the error when wt-status fails", async (t) => {
  const h = harness(t);
  h.writeSnapshot(scenario(h.root));
  const server = await h.start();
  for (const key of [
    "ci-failure:fix-ci",
    "review-feedback:address-review",
    "review-request:700",
  ]) {
    await waitForStatus(h, key, "done");
  }
  const good = await state(server);

  h.failWtStatus({
    stderr:
      "fetching PRs\nwt-status: GitHub API request failed: repos/acme/widgets/pulls\n\n",
    code: 3,
  });
  const res = await api(server, "POST", "/api/refresh");
  const error =
    "wt-status: GitHub API request failed: repos/acme/widgets/pulls (exit code 3)";
  assert.deepEqual([res.status, res.body], [502, { error }]);
  const failed = await state(server);
  assert.deepEqual(
    [
      failed.error,
      failed.fetched_at,
      failed.worktrees,
      failed.review_requests.map((r) => r.number),
    ],
    [
      error,
      good.fetched_at,
      good.worktrees,
      good.review_requests.map((r) => r.number),
    ],
  );

  h.failWtStatus(null);
  fs.writeFileSync(path.join(h.wtDir, "snapshot.json"), "not json");
  const invalid = await api(server, "POST", "/api/refresh");
  assert.equal(invalid.status, 502);
  assert.match(invalid.body.error, /^wt-status printed invalid JSON: /);

  h.writeSnapshot(scenario(h.root));
  assert.deepEqual((await api(server, "POST", "/api/refresh")).body, {
    ok: true,
  });
  const recovered = await state(server);
  assert.equal(recovered.error, null);
  assert.ok(recovered.fetched_at > good.fetched_at);
});

test("runs wt-status every MONITOR_POLL_SECONDS", async (t) => {
  const h = harness(t);
  h.writeSnapshot(scenario(h.root));
  await h.start({ env: { MONITOR_POLL_SECONDS: "0.2" } });
  await waitFor(
    () => h.wtStatusCalls().length >= 3,
    "two scheduled wt-status runs",
  );
});

test("removes the worktrees of merged PRs from the main checkout and reports the ones wt-remove refuses", async (t) => {
  const h = harness(t);
  const s = scenario(h.root);
  s.worktrees.push(worktree(h.root, "merged-dirty", finishedPr(601, "merged")));
  h.writeSnapshot(s);
  h.failWtRemove(
    "merged-dirty",
    "wt-remove: /wt/merged-dirty has uncommitted or untracked files:\n M a.ts\n",
  );
  const server = await h.start();

  const res = await api(server, "POST", "/api/remove-merged");
  assert.deepEqual(
    [res.status, res.body],
    [
      200,
      {
        removed: ["merged-one"],
        failed: [
          {
            branch: "merged-dirty",
            error:
              "wt-remove: /wt/merged-dirty has uncommitted or untracked files:\n M a.ts",
          },
        ],
      },
    ],
  );
  assert.deepEqual(h.wtRemoveCalls(), [
    { branch: "merged-one", cwd: h.checkout },
    { branch: "merged-dirty", cwd: h.checkout },
  ]);
  assert.deepEqual(
    (await state(server)).worktrees
      .filter((w) => w.state === "done")
      .map((w) => w.branch),
    ["closed-one", "merged-dirty"],
  );
});

test("leaves a merged worktree that research is still running in", async (t) => {
  const h = harness(t);
  h.behave({ "*": { hold: true } });
  h.writeSnapshot(ciOnly(h.root));
  const server = await h.start();
  await waitForStatus(h, "ci-failure:fix-ci", "running");

  h.writeSnapshot({
    ...ciOnly(h.root),
    worktrees: [worktree(h.root, "fix-ci", finishedPr(681, "merged"))],
  });
  await api(server, "POST", "/api/refresh");
  assert.deepEqual((await api(server, "POST", "/api/remove-merged")).body, {
    removed: [],
    failed: [
      {
        branch: "fix-ci",
        error: "research ci-failure #681 is running in ~/wt/fix-ci",
      },
    ],
  });
  assert.deepEqual(h.wtRemoveCalls(), []);
  h.release();
});

test("holds wt-status runs while worktrees are being removed, and refuses a second removal meanwhile", async (t) => {
  const h = harness(t);
  h.writeSnapshot(scenario(h.root));
  const server = await h.start();
  const before = h.wtStatusCalls().length;

  h.holdWtRemove(true);
  const removal = api(server, "POST", "/api/remove-merged");
  await waitFor(() => h.wtRemoveCalls().length === 1, "the wt-remove run");
  const second = await api(server, "POST", "/api/remove-merged");
  assert.deepEqual(
    [second.status, second.body],
    [409, { error: "the merged worktrees are already being removed" }],
  );
  const refresh = api(server, "POST", "/api/refresh");
  await sleep(200);
  assert.equal(h.wtStatusCalls().length, before, "no run during the removal");

  h.holdWtRemove(false);
  assert.deepEqual((await removal).body, {
    removed: ["merged-one"],
    failed: [],
  });
  assert.deepEqual((await refresh).body, { ok: true });
  assert.equal(h.wtStatusCalls().length, before + 1);
});

test("on start, fails research left running and runs research left queued", async (t) => {
  const h = harness(t);
  h.writeSnapshot(scenario(h.root));
  const record = (key, kind, name, dir, fingerprint, fields) => ({
    key,
    kind,
    fingerprint,
    head: sha("c"),
    dir,
    name,
    session_id: null,
    status: "queued",
    queued_at: "2026-11-06T10:00:00.000Z",
    started_at: null,
    finished_at: null,
    reason: null,
    result: null,
    cost_usd: null,
    previous: [],
    ...fields,
  });
  h.writeRecords({
    "ci-failure:fix-ci": record(
      "ci-failure:fix-ci",
      "ci-failure",
      "ci-failure #681",
      path.join(h.root, "wt/fix-ci"),
      sha("c"),
      {
        status: "running",
        session_id: "11111111-1111-4111-8111-111111111111",
        started_at: "2026-11-06T10:00:01.000Z",
      },
    ),
    "review-request:700": record(
      "review-request:700",
      "review-request",
      "review-request #700",
      h.checkout,
      sha("7"),
      { head: sha("7") },
    ),
    "review-request:701": record(
      "review-request:701",
      "review-request",
      "review-request #701",
      h.checkout,
      sha("8"),
      {
        head: sha("8"),
        queued_at: "2026-11-06T10:00:02.000Z",
      },
    ),
  });
  const server = await h.start();

  const stopped = research(h, "ci-failure:fix-ci");
  assert.deepEqual(
    [stopped.status, stopped.reason, stopped.session_id],
    ["failed", STOPPED_REASON, "11111111-1111-4111-8111-111111111111"],
  );
  assert.ok(stopped.finished_at !== null);
  const view = byBranch(await state(server))["fix-ci"].triggers[0].research;
  assert.equal(
    view.resume_command,
    "cd ~/wt/fix-ci && claude --resume 11111111-1111-4111-8111-111111111111",
  );

  await waitForStatus(h, "review-request:700", "done");
  await waitForStatus(h, "review-request:701", "done");
  const requeued = research(h, "review-request:700");
  assert.deepEqual(
    [requeued.queued_at, requeued.previous],
    ["2026-11-06T10:00:00.000Z", []],
  );
  await sleep(200);
  assert.deepEqual(
    h
      .calls()
      .map((call) => call.name)
      .sort(),
    [
      "merge-conflict #690",
      "review-feedback #687",
      "review-request #700",
      "review-request #701",
    ],
    "the stopped CI run, with an unchanged fingerprint, is not retried",
  );
});

test("writes server.json while running, and on SIGTERM terminates running research and removes it", async (t) => {
  const h = harness(t);
  h.behave({ "*": { hold: true } });
  h.writeSnapshot(ciOnly(h.root));
  const server = await h.start();
  const file = path.join(h.stateDir, "server.json");
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const info = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.deepEqual(
    [info.pid, info.port, info.url],
    [server.proc.pid, server.port, server.url],
  );
  assert.ok(Date.parse(info.started_at) <= Date.now());

  const second = await h.startFailing();
  assert.equal(second.code, 1);
  assert.ok(
    second.stderr.startsWith(
      `monitor: a monitor is already running on ${h.stateDir}: pid ${server.proc.pid}, ${server.url}`,
    ),
    second.stderr,
  );
  assert.equal(
    h.wtStatusCalls().length,
    1,
    "a refused start runs no wt-status",
  );
  assert.ok(
    fs.existsSync(file),
    "a refused start leaves the running server's file",
  );

  const [run] = await waitFor(
    () =>
      h.callsNamed("ci-failure #681").length === 1 &&
      h.callsNamed("ci-failure #681"),
    "the CI run",
  );
  const exit = await h.stop(server, "SIGTERM");
  assert.equal(exit.code, 143);
  assert.ok(!fs.existsSync(file));
  await waitFor(() => h.terminated(run.session_id), "the run to get SIGTERM");

  h.behave({});
  await h.start();
  const stopped = research(h, "ci-failure:fix-ci");
  assert.deepEqual(
    [stopped.status, stopped.reason, stopped.session_id],
    ["failed", STOPPED_REASON, run.session_id],
  );
});

test("leaves server.json alone on exit when another server wrote it", async (t) => {
  const h = harness(t);
  h.writeSnapshot(ciOnly(h.root));
  const server = await h.start();
  const file = path.join(h.stateDir, "server.json");
  const other = {
    pid: server.proc.pid + 100000,
    port: 1,
    url: "x",
    started_at: "y",
  };
  fs.writeFileSync(file, JSON.stringify(other));
  await h.stop(server, "SIGINT");
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), other);
});

test("fails to start on prompts with an unknown placeholder, before running anything", async (t) => {
  const h = harness(t);
  h.writeSnapshot(scenario(h.root));
  fs.writeFileSync(path.join(h.promptsDir, "ci-failure.md"), "fix {{bogus}}\n");
  const exit = await h.startFailing();
  assert.equal(exit.code, 1);
  assert.equal(
    exit.stderr,
    `monitor: ${h.promptsDir}/ci-failure.md uses unknown placeholder {{bogus}}; ci-failure has {{repo}}, {{number}}, {{url}}, {{title}}, {{head}}, {{dir}}, {{branch}}, {{base}}, {{failing_checks}}\n`,
  );
  assert.deepEqual([h.wtStatusCalls(), h.calls()], [[], []]);

  const missing = await h.startFailing({
    env: { MONITOR_PROMPTS_DIR: path.join(h.root, "nowhere") },
  });
  assert.equal(missing.code, 1);
  assert.match(
    missing.stderr,
    /^monitor: cannot read the run settings .*nowhere\/runs\.json/,
  );
});

test("fails to start when the port is taken or the first wt-status run fails", async (t) => {
  const h = harness(t);
  h.writeSnapshot(scenario(h.root));
  const blocker = net.createServer();
  await new Promise((resolve) => blocker.listen(0, "127.0.0.1", resolve));
  t.after(() => blocker.close());
  const port = blocker.address().port;
  const taken = await h.startFailing({ args: ["--port", String(port)] });
  assert.deepEqual(
    [taken.code, taken.stderr],
    [1, `monitor: port ${port} on 127.0.0.1 is already in use\n`],
  );

  h.failWtStatus({
    stderr: "wt-status: remote origin is not a GitHub repository: x\n",
    code: 1,
  });
  const failed = await h.startFailing();
  assert.equal(failed.code, 1);
  assert.match(
    failed.stderr,
    /failed: wt-status: remote origin is not a GitHub repository: x \(exit code 1\)\n$/,
  );
  assert.deepEqual(h.calls(), []);
});
