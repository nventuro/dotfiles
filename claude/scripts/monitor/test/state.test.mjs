import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, describe, test } from "node:test";

import {
  buildState,
  checkSnapshot,
  claudeArgs,
  keysToStart,
  loadPrompts,
  parseArgs,
  queueRun,
  recoverRecords,
  requestState,
  researchTargets,
  reviewFingerprint,
  runInvocation,
  runOutcome,
  startRun,
  STOPPED_REASON,
  tildify,
  worktreeBadges,
  worktreeState,
  worktreeTriggers,
} from "../server.mjs";
import {
  check,
  DAY,
  finishedPr,
  openPr,
  REPO,
  request,
  RUNS,
  scenario,
  sha,
  tempDir,
  TEMPLATES,
  thread,
  worktree,
  writePrompts,
} from "./fixtures.mjs";

const ROOT = "/home/u";
const MAIN = "/home/u/checkout";
const NOW = Date.parse("2026-11-06T12:00:00Z");

function wt(pr, fields) {
  return worktree(ROOT, "b", pr, fields);
}

function failingCi() {
  return { result: "fail", checks: [check("e2e", "completed", "failure")] };
}

function kinds(w) {
  return worktreeTriggers(w).map((trigger) => trigger.kind);
}

describe("worktree state", () => {
  const cases = [
    ["done", "for a merged PR", wt(finishedPr(1, "merged"))],
    ["done", "for a closed PR", wt(finishedPr(1, "closed"))],
    [
      "done",
      "for a merged PR that is still a draft",
      wt({ ...finishedPr(1, "merged"), draft: true }),
    ],
    ["local", "without a PR", wt(null)],
    [
      "local",
      "for a draft, even when CI fails",
      wt(openPr(1, { draft: true, ci: failingCi() })),
    ],
    ["needs", "when CI fails", wt(openPr(1, { ci: failingCi() }))],
    [
      "needs",
      "when a reviewer requests changes",
      wt(openPr(1, { reviews: { changes_requested: ["c"] } })),
    ],
    [
      "needs",
      "with an unresolved thread",
      wt(openPr(1, { review_threads: [thread("a", "c")] })),
    ],
    ["needs", "with conflicts", wt(openPr(1, { mergeable: false }))],
    ["ready", "when approved, passing and mergeable", wt(openPr(1))],
    [
      "waiting",
      "while CI is pending",
      wt(openPr(1, { ci: { result: "pending", checks: [] } })),
    ],
    [
      "waiting",
      "without checks",
      wt(openPr(1, { ci: { result: "none", checks: [] } })),
    ],
    [
      "waiting",
      "without an approval",
      wt(openPr(1, { reviews: { approved: [] } })),
    ],
    [
      "waiting",
      "while mergeable is unknown",
      wt(openPr(1, { mergeable: null })),
    ],
    [
      "waiting",
      "with only resolved threads",
      wt(
        openPr(1, {
          reviews: { approved: [] },
          review_threads: [thread("a", "c", { resolved: true })],
        }),
      ),
    ],
  ];
  for (const [state, when, w] of cases) {
    test(`is ${state} ${when}`, () => assert.equal(worktreeState(w), state));
  }
});

describe("worktree triggers", () => {
  test("lists every trigger kind with a one-line detail", () => {
    const w = wt(
      openPr(1, {
        base: "develop",
        mergeable: false,
        ci: failingCi(),
        reviews: { changes_requested: ["carol", "erin"] },
        review_threads: [
          thread("a", "c"),
          thread("b", "c"),
          thread("c", "c", { resolved: true }),
        ],
      }),
    );
    assert.deepEqual(worktreeTriggers(w), [
      { kind: "ci-failure", detail: "CI failing" },
      {
        kind: "review-feedback",
        detail: "changes requested by carol, erin; 2 unresolved threads",
      },
      { kind: "merge-conflict", detail: "conflicts with develop" },
    ]);
  });

  test("count a single thread in the singular", () => {
    const w = wt(openPr(1, { review_threads: [thread("a", "c")] }));
    assert.deepEqual(worktreeTriggers(w), [
      { kind: "review-feedback", detail: "1 unresolved thread" },
    ]);
  });

  test("are none on drafts and PRs that are no longer open", () => {
    assert.deepEqual(
      kinds(wt(openPr(1, { draft: true, ci: failingCi(), mergeable: false }))),
      [],
    );
    assert.deepEqual(kinds(wt(finishedPr(1, "merged"))), []);
    assert.deepEqual(kinds(wt(null)), []);
  });
});

describe("review fingerprint", () => {
  const base = openPr(1, {
    reviews: { changes_requested: ["carol", "erin"] },
    review_threads: [
      thread("a", "c", { id: 1 }),
      thread("b", "c", { id: 2 }),
      thread("c", "c", { id: 3, resolved: true }),
    ],
  });

  test("ignores the order of threads and logins, and resolved threads", () => {
    const shuffled = {
      ...base,
      reviews: { ...base.reviews, changes_requested: ["erin", "carol"] },
      review_threads: [base.review_threads[1], base.review_threads[0]],
    };
    assert.equal(reviewFingerprint(shuffled), reviewFingerprint(base));
  });

  test("changes with the head, the unresolved threads and the reviewers requesting changes", () => {
    const variants = [
      { ...base, head: sha("b") },
      {
        ...base,
        review_threads: [...base.review_threads, thread("d", "c", { id: 4 })],
      },
      { ...base, review_threads: [base.review_threads[0]] },
      { ...base, reviews: { ...base.reviews, changes_requested: ["carol"] } },
    ];
    for (const variant of variants)
      assert.notEqual(reviewFingerprint(variant), reviewFingerprint(base));
  });
});

test("badges count uncommitted files, unpushed commits and commits behind the PR", () => {
  assert.deepEqual(
    worktreeBadges(wt(openPr(1, { ahead: 2, behind: 3 }), { dirty_files: 35 })),
    ["35 uncommitted", "2 unpushed", "3 behind PR"],
  );
  assert.deepEqual(
    worktreeBadges(
      wt(null, { dirty_files: 0, dirty_submodules: ["vendor/lib"] }),
    ),
    [],
  );
});

describe("research targets", () => {
  const snapshot = scenario(ROOT, NOW);
  const targets = researchTargets(snapshot, MAIN, NOW);
  const byKey = Object.fromEntries(
    targets.map((target) => [target.key, target]),
  );

  test("cover every trigger of the worktrees and this repo's review requests, in queueing order", () => {
    assert.deepEqual(
      targets.map((target) => [target.key, target.kind, target.name]),
      [
        ["ci-failure:fix-ci", "ci-failure", "ci-failure #681"],
        [
          "review-feedback:address-review",
          "review-feedback",
          "review-feedback #687",
        ],
        ["merge-conflict:conflicting", "merge-conflict", "merge-conflict #690"],
        ["review-request:700", "review-request", "review-request #700"],
        ["review-request:701", "review-request", "review-request #701"],
      ],
    );
  });

  test("run worktree research in the worktree and review requests in the main checkout", () => {
    assert.equal(byKey["ci-failure:fix-ci"].dir, "/home/u/wt/fix-ci");
    assert.equal(byKey["review-request:700"].dir, MAIN);
  });

  test("fill the placeholders of each kind", () => {
    assert.deepEqual(byKey["ci-failure:fix-ci"].values, {
      repo: REPO,
      number: "681",
      url: `https://github.com/${REPO}/pull/681`,
      title: "PR 681",
      head: sha("c"),
      dir: "/home/u/wt/fix-ci",
      branch: "fix-ci",
      base: "main",
      failing_checks: "- e2e: https://ci.example/e2e",
    });
    assert.deepEqual(byKey["review-feedback:address-review"].values, {
      repo: REPO,
      number: "687",
      url: `https://github.com/${REPO}/pull/687`,
      title: "PR 687",
      head: sha("d"),
      dir: "/home/u/wt/address-review",
      branch: "address-review",
      base: "main",
      unresolved_threads: [
        `- src/a.ts (by carol, outdated): https://github.com/${REPO}/pull/0#discussion_src/a.ts`,
        `- src/b.ts (by erin): https://github.com/${REPO}/pull/0#discussion_src/b.ts`,
      ].join("\n"),
      changes_requested: "carol",
    });
    assert.deepEqual(byKey["merge-conflict:conflicting"].values, {
      repo: REPO,
      number: "690",
      url: `https://github.com/${REPO}/pull/690`,
      title: "PR 690",
      head: sha("a"),
      dir: "/home/u/wt/conflicting",
      branch: "conflicting",
      base: "main",
    });
    assert.deepEqual(byKey["review-request:700"].values, {
      repo: REPO,
      number: "700",
      url: `https://github.com/${REPO}/pull/700`,
      title: "Request 700",
      head: sha("7"),
      dir: MAIN,
      author: "dave",
    });
  });

  test("say none when there are no threads or no change requests", () => {
    const only = {
      repo: REPO,
      review_requests: [],
      worktrees: [wt(openPr(1, { review_threads: [thread("a", "c")] }))],
    };
    assert.equal(
      researchTargets(only, MAIN, NOW)[0].values.changes_requested,
      "none",
    );
    const changes = {
      ...only,
      worktrees: [
        wt(openPr(1, { reviews: { changes_requested: ["x", "y"] } })),
      ],
    };
    assert.equal(
      researchTargets(changes, MAIN, NOW)[0].values.unresolved_threads,
      "none",
    );
    assert.equal(
      researchTargets(changes, MAIN, NOW)[0].values.changes_requested,
      "x, y",
    );
  });

  test("mark review requests recent for 14 days, the last day included", () => {
    const s = {
      repo: REPO,
      worktrees: [],
      review_requests: [request(1, { daysAgo: 14, now: NOW })],
    };
    assert.equal(researchTargets(s, MAIN, NOW)[0].recent, true);
    assert.equal(researchTargets(s, MAIN, NOW + DAY)[0].recent, false);
  });

  test("mark CI research finished once no check on the head is running", () => {
    const withChecks = (checks) => ({
      repo: REPO,
      review_requests: [],
      worktrees: [wt(openPr(1, { ci: { result: "fail", checks } }))],
    });
    const failed = check("e2e", "completed", "failure");
    assert.equal(
      researchTargets(withChecks([failed]), MAIN, NOW)[0].ciFinished,
      true,
    );
    for (const status of ["queued", "in_progress", "missing"]) {
      const running = withChecks([failed, check("lint", status, null)]);
      assert.equal(
        researchTargets(running, MAIN, NOW)[0].ciFinished,
        false,
        status,
      );
    }
  });

  test("fingerprint CI and merge conflict research by the PR head, and review requests by theirs", () => {
    assert.equal(byKey["ci-failure:fix-ci"].fingerprint, sha("c"));
    assert.equal(byKey["merge-conflict:conflicting"].fingerprint, sha("a"));
    assert.equal(byKey["review-request:701"].fingerprint, sha("8"));
  });

  test("list a CI failure's failing checks, as wt-status marks them", () => {
    const marked = {
      repo: REPO,
      review_requests: [],
      worktrees: [
        wt(
          openPr(1, {
            ci: {
              result: "fail",
              checks: [
                check("flaky", "completed", "cancelled", true),
                check("e2e", "completed", "failure"),
                check("lint", "completed", "success"),
              ],
            },
          }),
        ),
      ],
    };
    assert.equal(
      researchTargets(marked, MAIN, NOW)[0].values.failing_checks,
      "- flaky: https://ci.example/flaky\n- e2e: https://ci.example/e2e",
    );
  });
});

describe("starting rules", () => {
  const ci = {
    key: "ci-failure:b",
    kind: "ci-failure",
    fingerprint: "f2",
    ciFinished: true,
  };
  const recent = {
    key: "review-request:1",
    kind: "review-request",
    fingerprint: "h1",
    recent: true,
  };
  const older = {
    key: "review-request:2",
    kind: "review-request",
    fingerprint: "h1",
    recent: false,
  };
  const record = (status, fingerprint) => ({ status, fingerprint });

  test("start worktree research without a record or when its fingerprint changed", () => {
    assert.deepEqual(keysToStart([ci], {}), [ci.key]);
    assert.deepEqual(keysToStart([ci], { [ci.key]: record("done", "f1") }), [
      ci.key,
    ]);
    assert.deepEqual(keysToStart([ci], { [ci.key]: record("failed", "f1") }), [
      ci.key,
    ]);
  });

  test("leave worktree research with the same fingerprint, even failed, and runs in progress", () => {
    for (const status of ["done", "failed", "queued", "running"]) {
      assert.deepEqual(
        keysToStart([ci], { [ci.key]: record(status, "f2") }),
        [],
        status,
      );
    }
    for (const status of ["queued", "running"]) {
      assert.deepEqual(
        keysToStart([ci], { [ci.key]: record(status, "f1") }),
        [],
        status,
      );
    }
  });

  test("leave CI research while a check on the head is still running", () => {
    const running = { ...ci, ciFinished: false };
    assert.deepEqual(keysToStart([running], {}), []);
    assert.deepEqual(
      keysToStart([running], { [ci.key]: record("done", "f1") }),
      [],
    );
  });

  test("start only recent review requests without a record", () => {
    assert.deepEqual(keysToStart([recent, older], {}), [recent.key]);
    assert.deepEqual(
      keysToStart([recent], { [recent.key]: record("done", "h0") }),
      [],
    );
    assert.deepEqual(
      keysToStart([recent], { [recent.key]: record("failed", "h1") }),
      [],
    );
  });
});

test("review request state follows its record's status and head", () => {
  const req = { head: "h2" };
  assert.equal(requestState(req, undefined), "new");
  for (const status of ["queued", "running", "failed"]) {
    assert.equal(requestState(req, { status, head: "h2" }), "new", status);
  }
  assert.equal(requestState(req, { status: "done", head: "h2" }), "researched");
  assert.equal(requestState(req, { status: "done", head: "h1" }), "outdated");
});

describe("records", () => {
  const target = {
    key: "ci-failure:b",
    kind: "ci-failure",
    fingerprint: "f1",
    head: "f1",
    dir: "/w",
    name: "ci-failure #1",
  };

  test("queueing a run moves the earlier ones into previous, newest first", () => {
    const first = {
      ...queueRun(undefined, target, "t1"),
      session_id: "s1",
      status: "failed",
      finished_at: "t2",
    };
    assert.deepEqual(first.previous, []);
    const second = {
      ...queueRun(first, target, "t3"),
      session_id: "s2",
      status: "done",
      finished_at: "t4",
    };
    const third = queueRun(
      second,
      { ...target, fingerprint: "f2", head: "f2" },
      "t5",
    );
    assert.deepEqual(third.previous, [
      { session_id: "s2", status: "done", finished_at: "t4" },
      { session_id: "s1", status: "failed", finished_at: "t2" },
    ]);
    assert.equal(third.status, "queued");
    assert.equal(third.session_id, null);
    assert.equal(third.fingerprint, "f2");
  });

  test("queueing a key whose run is queued or running throws", () => {
    const queued = queueRun(undefined, target, "t1");
    assert.throws(() => queueRun(queued, target, "t2"), /queued/);
  });

  test("a run starts on the target as it stands then", () => {
    const queued = queueRun(undefined, target, "t1");
    const running = startRun(
      queued,
      { ...target, fingerprint: "f9", head: "f9" },
      "s1",
      "t2",
    );
    assert.deepEqual(
      [
        running.status,
        running.session_id,
        running.started_at,
        running.head,
        running.fingerprint,
      ],
      ["running", "s1", "t2", "f9", "f9"],
    );
  });

  test("recovery fails running records and requeues queued ones by queue time", () => {
    const records = {
      a: {
        key: "a",
        status: "running",
        session_id: "s1",
        finished_at: null,
        reason: null,
      },
      b: { key: "b", status: "queued", queued_at: "2026-11-06T10:00:02Z" },
      c: { key: "c", status: "queued", queued_at: "2026-11-06T10:00:01Z" },
      d: { key: "d", status: "done", session_id: "s2" },
    };
    const { records: recovered, queue } = recoverRecords(
      records,
      "2026-11-06T11:00:00Z",
    );
    assert.deepEqual(recovered.a, {
      ...records.a,
      status: "failed",
      reason: STOPPED_REASON,
      finished_at: "2026-11-06T11:00:00Z",
    });
    assert.deepEqual(queue, ["c", "b"]);
    assert.deepEqual(recovered.d, records.d);
  });
});

describe("run outcome", () => {
  const success = {
    type: "result",
    subtype: "success",
    is_error: false,
    result: "final message",
    session_id: "s",
    total_cost_usd: 0.0034,
    num_turns: 1,
  };

  test("is done when claude exits 0 with a result that is not an error", () => {
    assert.deepEqual(
      runOutcome({
        code: 0,
        signal: null,
        stdout: JSON.stringify(success),
        stderr: "",
      }),
      {
        status: "done",
        reason: null,
        result: "final message",
        cost_usd: 0.0034,
      },
    );
  });

  test("fails with the subtype of a result that stopped early", () => {
    const stdout = JSON.stringify({
      ...success,
      subtype: "error_max_budget_usd",
      is_error: true,
      result: undefined,
    });
    assert.deepEqual(
      runOutcome({ code: 1, signal: null, stdout, stderr: "stderr line" }),
      {
        status: "failed",
        reason: "error_max_budget_usd",
        result: null,
        cost_usd: 0.0034,
      },
    );
  });

  test("fails with the result of an error that has a success subtype", () => {
    const stdout = JSON.stringify({
      ...success,
      is_error: true,
      result: "API Error: overloaded",
    });
    assert.equal(
      runOutcome({ code: 1, signal: null, stdout, stderr: "x" }).reason,
      "API Error: overloaded",
    );
  });

  test("fails a non-zero exit even when the result is not an error", () => {
    const outcome = runOutcome({
      code: 1,
      signal: null,
      stdout: JSON.stringify(success),
      stderr: "",
    });
    assert.deepEqual(
      [outcome.status, outcome.reason],
      ["failed", "final message"],
    );
  });

  test("fails with stderr's last non-empty line, then the exit code, when stdout is not JSON", () => {
    assert.equal(
      runOutcome({
        code: 2,
        signal: null,
        stdout: "",
        stderr: "one\n  two  \n\n",
      }).reason,
      "two",
    );
    assert.equal(
      runOutcome({ code: 0, signal: null, stdout: "not json", stderr: "" })
        .reason,
      "exit code 0",
    );
    assert.equal(
      runOutcome({ code: 0, signal: null, stdout: "[1]", stderr: "" }).reason,
      "exit code 0",
    );
    assert.equal(
      runOutcome({ code: null, signal: "SIGTERM", stdout: "", stderr: "" })
        .reason,
      "killed by SIGTERM",
    );
  });
});

describe("claude arguments", () => {
  const base = {
    prompt: "do it",
    sessionId: "u-1",
    name: "ci-failure #1",
    permissionMode: "plan",
  };

  test("leave out the tool lists and budget when there are none", () => {
    assert.deepEqual(
      claudeArgs({
        ...base,
        allowedTools: [],
        disallowedTools: [],
        maxBudgetUsd: null,
      }),
      [
        "-p",
        "do it",
        "--session-id",
        "u-1",
        "--name",
        "ci-failure #1",
        "--output-format",
        "json",
        "--permission-mode",
        "plan",
      ],
    );
  });

  test("pass each tool pattern as its own argument, and the budget", () => {
    const args = claudeArgs({
      ...base,
      allowedTools: ["Read", "Bash(git log:*)"],
      disallowedTools: ["Edit"],
      maxBudgetUsd: "2.5",
    });
    assert.deepEqual(args.slice(10), [
      "--allowedTools",
      "Read",
      "Bash(git log:*)",
      "--disallowedTools",
      "Edit",
      "--max-budget-usd",
      "2.5",
    ]);
  });
});

describe("prompts", () => {
  const roots = [];
  after(() => {
    for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
  });

  function promptsDir(changes) {
    const root = tempDir();
    roots.push(root);
    const dir = path.join(root, "prompts");
    writePrompts(dir, changes);
    return dir;
  }

  test("fill the template and the tool patterns from the target", () => {
    const prompts = loadPrompts(promptsDir());
    const target = researchTargets(scenario(ROOT, NOW), MAIN, NOW).find(
      (t) => t.key === "review-request:700",
    );
    assert.deepEqual(runInvocation(prompts, target), {
      prompt: `review ${REPO}#700 by dave\nurl https://github.com/${REPO}/pull/700\ntitle Request 700\nhead ${sha("7")}\ndir ${MAIN}\n`,
      permissionMode: "plan",
      allowedTools: ["Read", "Bash(gh pr view 700:*)"],
      disallowedTools: ["Edit"],
    });
  });

  test("deny the patterns for every kind along with each kind's own", () => {
    const prompts = loadPrompts(
      promptsDir({ runs: { ...RUNS, disallowedTools: ["Agent", "mcp__*"] } }),
    );
    assert.deepEqual(prompts["review-request"].disallowedTools.sort(), [
      "Agent",
      "Edit",
      "mcp__*",
    ]);
    assert.deepEqual(prompts["ci-failure"].disallowedTools.sort(), [
      "Agent",
      "mcp__*",
    ]);
  });

  test("leave placeholder syntax in filled values alone", () => {
    const prompts = loadPrompts(promptsDir());
    const target = researchTargets(scenario(ROOT, NOW), MAIN, NOW).find(
      (t) => t.key === "review-request:700",
    );
    target.values.title = "{{author}}";
    assert.match(
      runInvocation(prompts, target).prompt,
      /^title \{\{author\}\}$/m,
    );
  });

  const withKind = (kind, settings) => ({
    ...RUNS,
    kinds: { ...RUNS.kinds, [kind]: settings },
  });
  const failures = [
    [
      "a template uses another kind's placeholder",
      { templates: { ...TEMPLATES, "review-request": "{{branch}}" } },
      /review-request\.md uses unknown placeholder \{\{branch\}\}/,
    ],
    [
      "a template uses an unknown placeholder",
      { templates: { ...TEMPLATES, "ci-failure": "{{ head }}" } },
      /ci-failure\.md uses unknown placeholder \{\{ head \}\}/,
    ],
    [
      "a tool pattern uses an unknown placeholder",
      {
        runs: withKind("ci-failure", {
          permissionMode: "plan",
          allowedTools: ["Bash(gh pr view {{pr}}:*)"],
        }),
      },
      /ci-failure\.allowedTools uses unknown placeholder \{\{pr\}\}/,
    ],
    [
      "a deny pattern for every kind uses a placeholder that some kind lacks",
      { runs: { ...RUNS, disallowedTools: ["Bash(git push {{branch}})"] } },
      /runs\.json: disallowedTools uses unknown placeholder \{\{branch\}\}; review-request has/,
    ],
    [
      "a kind has no settings",
      {
        runs: {
          kinds: {
            "ci-failure": RUNS.kinds["ci-failure"],
            "review-feedback": RUNS.kinds["review-feedback"],
            "merge-conflict": RUNS.kinds["merge-conflict"],
          },
        },
      },
      /no settings for kind review-request/,
    ],
    [
      "runs.json has an unknown kind",
      { runs: withKind("ci-fail", RUNS.kinds["ci-failure"]) },
      /unknown kind "ci-fail"/,
    ],
    [
      "runs.json has no kinds",
      { runs: RUNS.kinds },
      /must hold an object with "kinds"/,
    ],
    [
      "runs.json has an unknown field",
      { runs: { ...RUNS, allowedTools: ["Read"] } },
      /runs\.json has unknown field "allowedTools"/,
    ],
    [
      "a permission mode is unknown",
      { runs: withKind("ci-failure", { permissionMode: "yolo" }) },
      /ci-failure\.permissionMode must be one of .* got "yolo"/,
    ],
    [
      "a settings field is unknown",
      {
        runs: withKind("ci-failure", {
          permissionMode: "plan",
          allowedtools: [],
        }),
      },
      /unknown field "allowedtools"/,
    ],
  ];
  for (const [when, changes, message] of failures) {
    test(`fail to load when ${when}`, () =>
      assert.throws(() => loadPrompts(promptsDir(changes)), message));
  }

  test("fail to load when a template is missing", () => {
    const dir = promptsDir();
    fs.rmSync(path.join(dir, "review-feedback.md"));
    assert.throws(
      () => loadPrompts(dir),
      /cannot read the review-feedback prompt template .*review-feedback\.md/,
    );
  });

  test("fail to load when the directory is missing", () => {
    assert.throws(
      () => loadPrompts("/nonexistent/prompts"),
      /cannot read the run settings \/nonexistent\/prompts\/runs\.json/,
    );
  });
});

describe("snapshot check", () => {
  test("accepts the scenario", () => checkSnapshot(scenario(ROOT, NOW)));

  test("rejects a worktree without dirty_submodules", () => {
    const s = scenario(ROOT, NOW);
    delete s.worktrees[1].dirty_submodules;
    assert.throws(
      () => checkSnapshot(s),
      /\/home\/u\/wt\/no-pr" has no "dirty_submodules" list/,
    );
  });

  test("rejects a review request in this repo without a head, but not one in another repo", () => {
    const s = scenario(ROOT, NOW);
    delete s.review_requests[0].head;
    checkSnapshot(s);
    delete s.review_requests[1].head;
    assert.throws(() => checkSnapshot(s), /review request #700 has no "head"/);
  });

  test("rejects an unknown PR state and an open PR without CI", () => {
    const s = scenario(ROOT, NOW);
    s.worktrees[0].pr.state = "gone";
    assert.throws(() => checkSnapshot(s), /unknown state "gone"/);
    const t = scenario(ROOT, NOW);
    t.worktrees[2].pr.ci = null;
    assert.throws(
      () => checkSnapshot(t),
      /fix-ci" has an open PR without "ci"/,
    );
  });

  test("rejects a check that wt-status did not mark failing or not", () => {
    const s = scenario(ROOT, NOW);
    delete s.worktrees[2].pr.ci.checks[1].failing;
    assert.throws(
      () => checkSnapshot(s),
      /fix-ci" has a check without "failing": \{"name":"e2e"/,
    );
  });
});

describe("state", () => {
  const snapshot = scenario(ROOT, NOW);
  const records = {
    "ci-failure:fix-ci": {
      key: "ci-failure:fix-ci",
      kind: "ci-failure",
      fingerprint: sha("c"),
      head: sha("c"),
      dir: "/home/u/wt/fix-ci",
      name: "ci-failure #681",
      session_id: "s-ci",
      status: "done",
      queued_at: "q",
      started_at: "s",
      finished_at: "f",
      reason: null,
      result: "found it",
      cost_usd: 0.1,
      previous: [],
    },
    "review-feedback:address-review": {
      key: "review-feedback:address-review",
      kind: "review-feedback",
      fingerprint: "x",
      head: sha("d"),
      dir: "/home/u/wt/address-review",
      name: "review-feedback #687",
      session_id: "s-fb",
      status: "running",
      queued_at: "q",
      started_at: "s",
      finished_at: null,
      reason: null,
      result: null,
      cost_usd: null,
      previous: [],
    },
    "review-request:700": {
      key: "review-request:700",
      kind: "review-request",
      fingerprint: sha("6"),
      head: sha("6"),
      dir: MAIN,
      name: "review-request #700",
      session_id: "s-rq",
      status: "done",
      queued_at: "q",
      started_at: "s",
      finished_at: "f",
      reason: null,
      result: "r",
      cost_usd: 0.2,
      previous: [],
    },
  };
  const build = (overrides) =>
    buildState({
      snapshot,
      records,
      mainCheckout: MAIN,
      wtRemove: "/home/u/bin/wt-remove",
      home: ROOT,
      now: NOW,
      fetchedAt: "t",
      nextFetchAt: "n",
      fetching: false,
      error: null,
      ...overrides,
    });
  const state = build({});
  const byBranch = Object.fromEntries(
    state.worktrees.map((w) => [w.branch, w]),
  );

  test("lists worktrees in wt-status order, each with its state", () => {
    assert.deepEqual(
      state.worktrees.map((w) => [w.state, w.branch]),
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
  });

  test("gives every trigger and review request the key and name of its research", () => {
    assert.deepEqual(
      state.worktrees.flatMap((w) =>
        w.triggers.map((t) => [t.kind, t.key, t.name]),
      ),
      [
        ["ci-failure", "ci-failure:fix-ci", "ci-failure #681"],
        [
          "review-feedback",
          "review-feedback:address-review",
          "review-feedback #687",
        ],
        ["merge-conflict", "merge-conflict:conflicting", "merge-conflict #690"],
      ],
    );
    assert.deepEqual(
      state.review_requests.map((r) => [r.key, r.name]),
      [
        ["review-request:700", "review-request #700"],
        ["review-request:701", "review-request #701"],
      ],
    );
  });

  test("shows paths with ~ and short heads", () => {
    assert.equal(state.checkout, "~/checkout");
    assert.equal(byBranch["fix-ci"].path, "~/wt/fix-ci");
    assert.equal(byBranch["fix-ci"].head, "1111111");
    assert.equal(byBranch["fix-ci"].pr.head, "ccccccc");
  });

  test("gives a resume command to finished research only", () => {
    const [ci] = byBranch["fix-ci"].triggers;
    assert.equal(
      ci.research.resume_command,
      "cd ~/wt/fix-ci && claude --resume s-ci",
    );
    assert.equal(ci.research.dir, "~/wt/fix-ci");
    assert.equal(
      byBranch["address-review"].triggers[0].research.resume_command,
      null,
    );
    assert.equal(byBranch.conflicting.triggers[0].research, null);
  });

  test("gives a remove command to merged worktrees only", () => {
    assert.equal(
      byBranch["merged-one"].remove_command,
      "cd ~/checkout && ~/bin/wt-remove merged-one",
    );
    assert.equal(byBranch["closed-one"].remove_command, null);
    assert.equal(byBranch["ready-one"].remove_command, null);
  });

  test("marks research of an outdated review request stale", () => {
    assert.deepEqual(
      state.review_requests.map((r) => [
        r.number,
        r.recent,
        r.state,
        r.research?.stale ?? null,
      ]),
      [
        [700, true, "outdated", true],
        [701, false, "new", null],
      ],
    );
  });

  test("marks finished CI research of an earlier head stale", () => {
    const staleness = (record) =>
      build({ records: { [record.key]: record } }).worktrees.find(
        (w) => w.branch === "fix-ci",
      ).triggers[0].research.stale;
    const ci = records["ci-failure:fix-ci"];
    const earlier = { ...ci, fingerprint: sha("b"), head: sha("b") };
    assert.equal(staleness(ci), false);
    assert.equal(staleness(earlier), true);
    assert.equal(staleness({ ...earlier, status: "running" }), false);
  });

  test("counts running and queued research across the repo", () => {
    assert.deepEqual(
      [state.running, state.queued, state.max_running],
      [1, 0, 2],
    );
  });
});

test("tildify writes the home directory as ~ only for paths inside it", () => {
  assert.equal(tildify("/home/u", "/home/u"), "~");
  assert.equal(tildify("/home/u/a/b", "/home/u"), "~/a/b");
  assert.equal(tildify("/home/user2/a", "/home/u"), "/home/user2/a");
});

describe("command line", () => {
  test("has defaults", () => {
    assert.deepEqual(parseArgs(["--state-dir", "state"]), {
      stateDir: path.resolve("state"),
      checkout: process.cwd(),
      port: 7420,
      maxBudgetUsd: null,
    });
  });

  test("reads every option", () => {
    assert.deepEqual(
      parseArgs([
        "--state-dir",
        "/s",
        "-C",
        "/x",
        "--port",
        "8000",
        "--max-budget-usd",
        "1.5",
      ]),
      {
        stateDir: "/s",
        checkout: "/x",
        port: 8000,
        maxBudgetUsd: "1.5",
      },
    );
  });

  test("rejects bad values and unknown flags", () => {
    assert.throws(
      () => parseArgs(["--port", "http"]),
      /--port must be a port number, got "http"/,
    );
    assert.throws(
      () => parseArgs(["--max-budget-usd", "-1"]),
      /--max-budget-usd must be a positive number/,
    );
    assert.throws(() => parseArgs([]), /--state-dir is required; usage:/);
    assert.throws(() => parseArgs(["--verbose", "1"]), /usage:/);
    assert.throws(() => parseArgs(["-C"]), /usage:/);
  });
});
