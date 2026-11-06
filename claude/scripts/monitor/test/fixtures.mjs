// wt-status snapshots and a harness that runs the server as a process against
// the stub claude and the fake wt-status and wt-remove next to this file.
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
export const SERVER = path.join(TEST_DIR, "..", "server.mjs");
const STUB_CLAUDE = path.join(TEST_DIR, "stub-claude");
const FAKE_WT_STATUS = path.join(TEST_DIR, "fake-wt-status");
export const FAKE_WT_REMOVE = path.join(TEST_DIR, "fake-wt-remove");

export const REPO = "acme/widgets";
export const DAY = 24 * 60 * 60 * 1000;

export function sha(char) {
  return char.repeat(40);
}

export function prUrl(number, repo = REPO) {
  return `https://github.com/${repo}/pull/${number}`;
}

/** A check as wt-status reports it, failing when its conclusion is "failure" unless `failing` says otherwise. */
export function check(
  name,
  status,
  conclusion,
  failing = conclusion === "failure",
) {
  return {
    name,
    status,
    conclusion,
    url: `https://ci.example/${name}`,
    failing,
  };
}

export function thread(
  file,
  author,
  { resolved = false, outdated = false, id = file } = {},
) {
  return {
    resolved,
    outdated,
    path: file,
    author,
    url: `https://github.com/${REPO}/pull/0#discussion_${id}`,
  };
}

/** An open PR that is approved, passes CI and merges cleanly, with `fields` on top. */
export function openPr(number, fields = {}) {
  const { ci, reviews, ...rest } = fields;
  return {
    number,
    url: prUrl(number),
    title: `PR ${number}`,
    base: "main",
    draft: false,
    head: sha("a"),
    state: "open",
    ahead: 0,
    behind: 0,
    mergeable: true,
    ci: {
      result: "pass",
      checks: [check("build", "completed", "success")],
      ...ci,
    },
    reviews: {
      approved: ["bob"],
      changes_requested: [],
      commented: [],
      requested: [],
      requested_teams: [],
      submitted: 1,
      ...reviews,
    },
    comments: 0,
    review_comments: 0,
    review_threads: [],
    ...rest,
  };
}

/** A PR that is no longer open, with the fields wt-status leaves null for one. */
export function finishedPr(number, state) {
  return {
    number,
    url: prUrl(number),
    title: `PR ${number}`,
    base: "main",
    draft: false,
    head: sha("f"),
    state,
    ahead: 0,
    behind: 0,
    mergeable: null,
    ci: null,
    reviews: null,
    comments: null,
    review_comments: null,
    review_threads: null,
  };
}

export function worktree(root, branch, pr, fields = {}) {
  return {
    path: path.join(root, "wt", branch),
    branch,
    head: sha("1"),
    dirty_files: 0,
    dirty_submodules: [],
    pr,
    ...fields,
  };
}

export function request(
  number,
  { daysAgo, head = sha("7"), repo = REPO, now = Date.now() },
) {
  return {
    repo,
    number,
    url: prUrl(number, repo),
    title: `Request ${number}`,
    author: "dave",
    created_at: new Date(now - daysAgo * DAY).toISOString(),
    head,
  };
}

/**
 * A snapshot with a worktree in every state and every trigger kind, with the
 * states interleaved so that the page's order differs from wt-status's, and
 * review requests in this repo (recent and older) and in another repo.
 */
export function scenario(root, now = Date.now()) {
  return {
    repo: REPO,
    worktrees: [
      worktree(root, "merged-one", finishedPr(600, "merged")),
      worktree(root, "no-pr", null, {
        dirty_files: 35,
        dirty_submodules: ["vendor/lib"],
      }),
      worktree(
        root,
        "fix-ci",
        openPr(681, {
          head: sha("c"),
          ci: {
            result: "fail",
            checks: [
              check("build", "completed", "success"),
              check("e2e", "completed", "failure"),
              check("lint", "completed", "skipped"),
            ],
          },
          reviews: { approved: [] },
        }),
      ),
      worktree(root, "ready-one", openPr(642, { ahead: 2, behind: 1 })),
      worktree(root, "stacked", openPr(650, { base: "ready-one" })),
      worktree(
        root,
        "waiting-ci",
        openPr(655, {
          ci: {
            result: "pending",
            checks: [check("build", "in_progress", null)],
          },
          reviews: { approved: [], requested: ["carol"] },
        }),
      ),
      worktree(
        root,
        "address-review",
        openPr(687, {
          head: sha("d"),
          reviews: { approved: [], changes_requested: ["carol"] },
          review_threads: [
            thread("src/a.ts", "carol", { outdated: true }),
            thread("src/b.ts", "erin"),
            thread("src/c.ts", "carol", { resolved: true }),
          ],
        }),
      ),
      worktree(
        root,
        "drafty",
        openPr(660, {
          draft: true,
          ci: {
            result: "fail",
            checks: [check("e2e", "completed", "failure")],
          },
        }),
      ),
      worktree(root, "conflicting", openPr(690, { mergeable: false })),
      worktree(root, "closed-one", finishedPr(610, "closed")),
      worktree(root, "mergeable-unknown", openPr(691, { mergeable: null })),
    ],
    review_requests: [
      request(702, { daysAgo: 1, repo: "acme/other", now }),
      request(700, { daysAgo: 2, now }),
      request(701, { daysAgo: 30, head: sha("8"), now }),
    ],
  };
}

export const TEMPLATES = {
  "review-request":
    "review {{repo}}#{{number}} by {{author}}\nurl {{url}}\ntitle {{title}}\nhead {{head}}\ndir {{dir}}\n",
  "ci-failure":
    "ci {{repo}}#{{number}} {{branch}} -> {{base}}\nurl {{url}}\ntitle {{title}}\nhead {{head}}\ndir {{dir}}\nfailing:\n{{failing_checks}}\n",
  "review-feedback":
    "feedback {{repo}}#{{number}} {{branch}} -> {{base}}\nurl {{url}}\ntitle {{title}}\nhead {{head}}\ndir {{dir}}\nthreads:\n{{unresolved_threads}}\nchanges: {{changes_requested}}\n",
  "merge-conflict":
    "conflicts {{repo}}#{{number}} {{branch}} -> {{base}}\nurl {{url}}\ntitle {{title}}\nhead {{head}}\ndir {{dir}}\n",
};

export const RUNS = {
  kinds: {
    "review-request": {
      permissionMode: "plan",
      allowedTools: ["Read", "Bash(gh pr view {{number}}:*)"],
      disallowedTools: ["Edit"],
    },
    "ci-failure": {
      permissionMode: "acceptEdits",
      allowedTools: ["Bash(git -C {{dir}} status:*)"],
    },
    "review-feedback": {
      permissionMode: "dontAsk",
      disallowedTools: ["Bash(git push:*)"],
    },
    "merge-conflict": {
      permissionMode: "dontAsk",
      allowedTools: ["Bash(git fetch origin {{base}})"],
    },
  },
};

export function writePrompts(dir, { templates = TEMPLATES, runs = RUNS } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  for (const [kind, text] of Object.entries(templates)) {
    fs.writeFileSync(path.join(dir, `${kind}.md`), text);
  }
  fs.writeFileSync(path.join(dir, "runs.json"), JSON.stringify(runs));
}

export function tempDir() {
  return fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "monitor-test-")),
  );
}

/** Polls `fn` until it returns a truthy value, which it returns. */
export async function waitFor(fn, what, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(25);
  }
}

/**
 * A temp dir that serves as HOME, with a git checkout, the fake wt-status's
 * snapshot, the fake wt-remove's dir, fixture prompts, a state dir and the stub
 * claude's dir, and runs servers on it.
 */
export class Harness {
  constructor() {
    this.root = tempDir();
    this.checkout = path.join(this.root, "checkout");
    this.stateDir = path.join(this.root, "state");
    this.promptsDir = path.join(this.root, "prompts");
    this.stubDir = path.join(this.root, "stub");
    this.wtDir = path.join(this.root, "fake-wt-status");
    this.wtRemoveDir = path.join(this.root, "fake-wt-remove");
    for (const dir of [
      this.checkout,
      this.stubDir,
      this.wtDir,
      this.wtRemoveDir,
    ])
      fs.mkdirSync(dir, { recursive: true });
    execFileSync("git", ["init", "-q", this.checkout]);
    writePrompts(this.promptsDir);
    this.servers = [];
  }

  writeSnapshot(snapshot) {
    for (const wt of snapshot.worktrees)
      fs.mkdirSync(wt.path, { recursive: true });
    fs.writeFileSync(
      path.join(this.wtDir, "snapshot.json"),
      JSON.stringify(snapshot),
    );
  }

  /** Makes the fake wt-status fail with `stderr` and exit code `code`, or succeed again with null. */
  failWtStatus(failure) {
    const file = path.join(this.wtDir, "fail.json");
    if (failure === null) fs.rmSync(file, { force: true });
    else fs.writeFileSync(file, JSON.stringify(failure));
  }

  holdWtStatus(hold) {
    const file = path.join(this.wtDir, "hold");
    if (hold) fs.writeFileSync(file, "");
    else fs.rmSync(file, { force: true });
  }

  wtStatusCalls() {
    const log = path.join(this.wtDir, "calls.log");
    if (!fs.existsSync(log)) return [];
    return fs
      .readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
  }

  /** Makes the fake wt-remove fail on `branch` with `stderr`. */
  failWtRemove(branch, stderr) {
    const dir = path.join(this.wtRemoveDir, "fail");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, branch), stderr);
  }

  holdWtRemove(hold) {
    const file = path.join(this.wtRemoveDir, "hold");
    if (hold) fs.writeFileSync(file, "");
    else fs.rmSync(file, { force: true });
  }

  /** The fake wt-remove's invocations, oldest first, each { branch, cwd }. */
  wtRemoveCalls() {
    const log = path.join(this.wtRemoveDir, "calls.log");
    if (!fs.existsSync(log)) return [];
    return fs
      .readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
  }

  behave(behaviors) {
    fs.writeFileSync(
      path.join(this.stubDir, "behavior.json"),
      JSON.stringify(behaviors),
    );
  }

  /** The stub claude's invocations, oldest first, each { session_id, name, argv, cwd, env }. */
  calls() {
    const dir = path.join(this.stubDir, "calls");
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .map((file) => {
        const call = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
        const name = call.argv[call.argv.indexOf("--name") + 1];
        return { session_id: path.basename(file, ".json"), name, ...call };
      })
      .sort((a, b) => a.started_at.localeCompare(b.started_at));
  }

  callsNamed(name) {
    return this.calls().filter((call) => call.name === name);
  }

  /** Lets every held invocation named `name` (every one, without a name) finish. */
  release(name) {
    fs.mkdirSync(path.join(this.stubDir, "release"), { recursive: true });
    for (const call of name === undefined
      ? this.calls()
      : this.callsNamed(name)) {
      fs.writeFileSync(path.join(this.stubDir, "release", call.session_id), "");
    }
  }

  terminated(sessionId) {
    return fs.existsSync(path.join(this.stubDir, "terminated", sessionId));
  }

  records() {
    return JSON.parse(
      fs.readFileSync(path.join(this.stateDir, "research.json"), "utf8"),
    );
  }

  writeRecords(records) {
    fs.mkdirSync(this.stateDir, { recursive: true });
    fs.writeFileSync(
      path.join(this.stateDir, "research.json"),
      JSON.stringify(records),
    );
  }

  env(extra = {}) {
    const base = Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) => !key.startsWith("CI_") && !key.startsWith("MONITOR_"),
      ),
    );
    return {
      ...base,
      HOME: this.root,
      STUB_CLAUDE_DIR: this.stubDir,
      FAKE_WT_STATUS_DIR: this.wtDir,
      FAKE_WT_REMOVE_DIR: this.wtRemoveDir,
      MONITOR_PROMPTS_DIR: this.promptsDir,
      ...extra,
      // Never a real claude, wt-status or wt-remove: they spend tokens and API
      // quota, and wt-remove deletes worktrees and branches.
      MONITOR_CLAUDE: STUB_CLAUDE,
      MONITOR_WT_STATUS: FAKE_WT_STATUS,
      MONITOR_WT_REMOVE: FAKE_WT_REMOVE,
    };
  }

  spawnServer(args, env) {
    const proc = spawn(
      process.execPath,
      [SERVER, "--state-dir", this.stateDir, "-C", this.checkout, ...args],
      {
        env: this.env(env),
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const output = { stdout: "", stderr: "" };
    proc.stdout.on("data", (chunk) => (output.stdout += chunk));
    proc.stderr.on("data", (chunk) => (output.stderr += chunk));
    const exited = new Promise((resolve) =>
      proc.on("exit", (code, signal) => resolve({ code, signal, ...output })),
    );
    return { proc, output, exited };
  }

  /** Starts a server and resolves once it printed its URL line. */
  async start({ args = ["--port", "0"], env = {} } = {}) {
    const { proc, output, exited } = this.spawnServer(args, env);
    let exit = null;
    exited.then((result) => (exit = result));
    const match = await waitFor(() => {
      if (exit !== null)
        throw new Error(`the server exited with ${exit.code}: ${exit.stderr}`);
      return output.stdout.match(
        /^monitor for (\S+): (http:\/\/127\.0\.0\.1:(\d+)\/#token=(\S+))$/m,
      );
    }, "the server's URL line");
    const server = {
      proc,
      output,
      exited,
      repo: match[1],
      url: match[2],
      port: Number(match[3]),
      token: match[4],
    };
    this.servers.push(server);
    return server;
  }

  /** Runs a server that is expected to fail to start, resolving to its exit. */
  async startFailing({ args = ["--port", "0"], env = {} } = {}) {
    const { proc, exited } = this.spawnServer(args, env);
    const timer = setTimeout(() => proc.kill("SIGKILL"), 10_000);
    const result = await exited;
    clearTimeout(timer);
    return result;
  }

  async stop(server, signal = "SIGTERM") {
    if (server.proc.exitCode === null && server.proc.signalCode === null)
      server.proc.kill(signal);
    return server.exited;
  }

  async close() {
    for (const server of this.servers) await this.stop(server);
    this.release();
    fs.rmSync(this.root, { recursive: true, force: true });
  }
}

/** An HTTP request to the server, resolving to { status, body } with a JSON body parsed. */
export function api(
  server,
  method,
  urlPath,
  { body, token = server.token, host } = {},
) {
  return new Promise((resolve, reject) => {
    const headers = { Host: host ?? `127.0.0.1:${server.port}` };
    if (token !== null) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const req = http.request(
      { host: "127.0.0.1", port: server.port, method, path: urlPath, headers },
      (res) => {
        let text = "";
        res.on("data", (chunk) => (text += chunk));
        res.on("end", () => {
          const json = (res.headers["content-type"] ?? "").startsWith(
            "application/json",
          );
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: json ? JSON.parse(text) : text,
          });
        });
      },
    );
    req.on("error", reject);
    if (body !== undefined)
      req.write(typeof body === "string" ? body : JSON.stringify(body));
    req.end();
  });
}
