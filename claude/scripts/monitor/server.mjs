// Serve a page, on 127.0.0.1 only, with the state of one GitHub repo's
// worktrees (their branches' PRs) and of the open PRs in that repo that request
// a review from gh's account. What needs the user on one of those PRs, and a
// new review request, each start a headless Claude research session
// (`claude -p`), which the page hands over as a `claude --resume` command. The
// page can also remove the worktrees of merged PRs, with wt-remove.
//
//   node server.mjs --state-dir <dir> [-C <checkout>] [--port <n>] [--max-budget-usd <n>]
//
//   --state-dir <dir>     where the research records, each session's output and
//                         server.json are kept
//   -C <checkout>         any checkout of the repo (default: the current directory)
//   --port <n>            the port to listen on (default: 7420)
//   --max-budget-usd <n>  passed to every research session; without it there is
//                         no cap
//
// It prints `monitor for <owner>/<name>: <url>`, where the URL carries the
// token that every /api request needs, and writes the same URL, its pid and
// port to <state dir>/server.json while it runs. It refuses to start while
// another monitor runs on the same state dir. On SIGINT or SIGTERM it sends
// SIGTERM to the research sessions still running; the next start marks them
// failed, and they can still be resumed.
//
// The state of the worktrees and PRs comes from wt-status, run at start, every
// minute and when the page asks for a refresh. Research records are kept in
// <state dir>/research.json and each session's output in <state dir>/runs/.
//
// Environment, for tests: MONITOR_CLAUDE (the claude binary),
// MONITOR_WT_STATUS, MONITOR_WT_REMOVE, MONITOR_POLL_SECONDS and
// MONITOR_PROMPTS_DIR (the prompt templates and runs.json).
import { spawn } from "node:child_process";
import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SERVER_DIR = path.dirname(fileURLToPath(import.meta.url));

export const MAX_RUNNING = 2;
export const STOPPED_REASON = "the monitor stopped during the run";
export const GONE_REASON = "its trigger was gone when the run was due to start";
export const PERMISSION_MODES = [
  "acceptEdits",
  "auto",
  "bypassPermissions",
  "manual",
  "dontAsk",
  "plan",
];
const COMMON_PLACEHOLDERS = ["repo", "number", "url", "title", "head", "dir"];
export const PLACEHOLDERS = {
  "review-request": [...COMMON_PLACEHOLDERS, "author"],
  "ci-failure": [...COMMON_PLACEHOLDERS, "branch", "base", "failing_checks"],
  "review-feedback": [
    ...COMMON_PLACEHOLDERS,
    "branch",
    "base",
    "unresolved_threads",
    "changes_requested",
  ],
  "merge-conflict": [...COMMON_PLACEHOLDERS, "branch", "base"],
};
export const KINDS = Object.keys(PLACEHOLDERS);
const RECORD_STATUSES = ["queued", "running", "done", "failed"];
export const RECENT_DAYS = 14;
const RECENT_MS = RECENT_DAYS * 24 * 60 * 60 * 1000;
const PLACEHOLDER = /\{\{([^{}]*)\}\}/g;
const USAGE =
  "usage: server.mjs --state-dir <dir> [-C <checkout>] [--port <n>] [--max-budget-usd <n>]";

function must(condition, message) {
  if (!condition) throw new Error(message);
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The last line of `text` that is not blank, trimmed, or null when there is none. */
export function lastLine(text) {
  return (
    text
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .at(-1) ?? null
  );
}

/** `file` with the home directory `home` written as `~`. */
export function tildify(file, home) {
  if (file === home) return "~";
  return file.startsWith(`${home}/`) ? `~${file.slice(home.length)}` : file;
}

function short(sha) {
  return sha.slice(0, 7);
}

/**
 * The server's command line options, as { stateDir and checkout (absolute),
 * port, maxBudgetUsd (the flag's text, or null) }. Throws on anything else.
 */
export function parseArgs(argv) {
  const options = {
    stateDir: null,
    checkout: ".",
    port: 7420,
    maxBudgetUsd: null,
  };
  for (let i = 0; i < argv.length; i += 2) {
    const [flag, value] = [argv[i], argv[i + 1]];
    must(value !== undefined, USAGE);
    switch (flag) {
      case "--state-dir":
        options.stateDir = value;
        break;
      case "-C":
        options.checkout = value;
        break;
      case "--port":
        must(
          /^\d+$/.test(value) && Number(value) <= 65535,
          `--port must be a port number, got ${JSON.stringify(value)}`,
        );
        options.port = Number(value);
        break;
      case "--max-budget-usd":
        must(
          /^\d+(\.\d+)?$/.test(value) && Number(value) > 0,
          `--max-budget-usd must be a positive number, got ${JSON.stringify(value)}`,
        );
        options.maxBudgetUsd = value;
        break;
      default:
        throw new Error(USAGE);
    }
  }
  must(options.stateDir !== null, `--state-dir is required; ${USAGE}`);
  options.stateDir = path.resolve(options.stateDir);
  options.checkout = path.resolve(options.checkout);
  return options;
}

/** The commands and settings that tests override through the environment, with their defaults. */
export function envConfig(env) {
  const pollSeconds = env.MONITOR_POLL_SECONDS
    ? Number(env.MONITOR_POLL_SECONDS)
    : 60;
  must(
    pollSeconds > 0,
    `MONITOR_POLL_SECONDS must be a positive number, got ${JSON.stringify(env.MONITOR_POLL_SECONDS)}`,
  );
  return {
    claude: env.MONITOR_CLAUDE || "claude",
    wtStatus: env.MONITOR_WT_STATUS || path.join(SERVER_DIR, "..", "wt-status"),
    wtRemove: env.MONITOR_WT_REMOVE || path.join(SERVER_DIR, "..", "wt-remove"),
    pollSeconds,
    promptsDir: env.MONITOR_PROMPTS_DIR || path.join(SERVER_DIR, "prompts"),
  };
}

/** `text` with each `{{name}}` replaced by `values[name]`; throws on a name without a value. */
export function fillPlaceholders(text, values) {
  return text.replace(PLACEHOLDER, (match, name) => {
    must(Object.hasOwn(values, name), `no value for placeholder ${match}`);
    return values[name];
  });
}

function checkPlaceholders(text, kind, where) {
  for (const [match, name] of text.matchAll(PLACEHOLDER)) {
    must(
      PLACEHOLDERS[kind].includes(name),
      `${where} uses unknown placeholder ${match}; ${kind} has ${PLACEHOLDERS[kind].map((n) => `{{${n}}}`).join(", ")}`,
    );
  }
}

function patternList(value, where) {
  const patterns = value ?? [];
  must(
    Array.isArray(patterns) &&
      patterns.every((pattern) => typeof pattern === "string"),
    `${where} must be a list of strings, got ${JSON.stringify(value)}`,
  );
  return patterns;
}

/**
 * The prompt template and `claude -p` permission settings of each research
 * kind, from `<dir>/<kind>.md` and `<dir>/runs.json`, as
 * { <kind>: { template, permissionMode, allowedTools, disallowedTools } }.
 * runs.json holds { disallowedTools, kinds: { <kind>: { permissionMode,
 * allowedTools, disallowedTools } } }, where the top-level disallowedTools
 * apply to every kind. Throws when a kind, its template or its permission mode
 * is missing, or a template or tool pattern uses a placeholder its kind does
 * not have.
 */
export function loadPrompts(dir) {
  const runsPath = path.join(dir, "runs.json");
  let runs;
  try {
    runs = JSON.parse(fs.readFileSync(runsPath, "utf8"));
  } catch (error) {
    throw new Error(
      `cannot read the run settings ${runsPath}: ${error.message}`,
    );
  }
  must(
    isPlainObject(runs) && isPlainObject(runs.kinds),
    `${runsPath} must hold an object with "kinds", keyed by research kind`,
  );
  for (const field of Object.keys(runs)) {
    must(
      ["disallowedTools", "kinds"].includes(field),
      `${runsPath} has unknown field ${JSON.stringify(field)}`,
    );
  }
  const everyKind = patternList(
    runs.disallowedTools,
    `${runsPath}: disallowedTools`,
  );
  for (const kind of Object.keys(runs.kinds)) {
    must(
      KINDS.includes(kind),
      `${runsPath} has unknown kind ${JSON.stringify(kind)}; the kinds are ${KINDS.join(", ")}`,
    );
  }
  const prompts = {};
  for (const kind of KINDS) {
    const settings = runs.kinds[kind];
    must(
      isPlainObject(settings),
      `${runsPath} has no settings for kind ${kind}`,
    );
    for (const field of Object.keys(settings)) {
      must(
        ["permissionMode", "allowedTools", "disallowedTools"].includes(field),
        `${runsPath}: ${kind} has unknown field ${JSON.stringify(field)}`,
      );
    }
    must(
      PERMISSION_MODES.includes(settings.permissionMode),
      `${runsPath}: ${kind}.permissionMode must be one of ${PERMISSION_MODES.join(", ")}, got ${JSON.stringify(settings.permissionMode)}`,
    );
    for (const pattern of everyKind)
      checkPlaceholders(pattern, kind, `${runsPath}: disallowedTools`);
    const tools = {};
    for (const field of ["allowedTools", "disallowedTools"]) {
      const where = `${runsPath}: ${kind}.${field}`;
      const patterns = patternList(settings[field], where);
      for (const pattern of patterns) checkPlaceholders(pattern, kind, where);
      tools[field] = patterns;
    }
    const templatePath = path.join(dir, `${kind}.md`);
    let template;
    try {
      template = fs.readFileSync(templatePath, "utf8");
    } catch (error) {
      throw new Error(
        `cannot read the ${kind} prompt template ${templatePath}: ${error.message}`,
      );
    }
    checkPlaceholders(template, kind, templatePath);
    prompts[kind] = {
      template,
      permissionMode: settings.permissionMode,
      allowedTools: tools.allowedTools,
      disallowedTools: [...everyKind, ...tools.disallowedTools],
    };
  }
  return prompts;
}

/**
 * Throws unless `snapshot` has the shape of wt-status's output that the state
 * model reads, naming the first field that does not.
 */
export function checkSnapshot(snapshot) {
  must(
    isPlainObject(snapshot),
    `wt-status output is not an object: ${JSON.stringify(snapshot)}`,
  );
  must(
    typeof snapshot.repo === "string" && /^[^/]+\/[^/]+$/.test(snapshot.repo),
    `wt-status output has no "repo" of the form <owner>/<name>: ${JSON.stringify(snapshot.repo)}`,
  );
  must(
    Array.isArray(snapshot.worktrees),
    'wt-status output has no "worktrees" list',
  );
  must(
    Array.isArray(snapshot.review_requests),
    'wt-status output has no "review_requests" list',
  );
  for (const wt of snapshot.worktrees) {
    const where = `wt-status worktree ${JSON.stringify(wt?.path)}`;
    must(
      isPlainObject(wt) &&
        typeof wt.path === "string" &&
        typeof wt.head === "string",
      `${where} has no "path" or "head"`,
    );
    must(
      Number.isInteger(wt.dirty_files),
      `${where} has no "dirty_files" count`,
    );
    must(
      Array.isArray(wt.dirty_submodules),
      `${where} has no "dirty_submodules" list`,
    );
    const pr = wt.pr;
    if (pr === null) continue;
    must(typeof wt.branch === "string", `${where} has a PR but no branch`);
    must(
      ["open", "closed", "merged"].includes(pr?.state),
      `${where} has a PR with unknown state ${JSON.stringify(pr?.state)}`,
    );
    if (pr.state !== "open") continue;
    must(
      isPlainObject(pr.ci) && Array.isArray(pr.ci.checks),
      `${where} has an open PR without "ci"`,
    );
    for (const check of pr.ci.checks) {
      must(
        typeof check?.failing === "boolean",
        `${where} has a check without "failing": ${JSON.stringify(check)}`,
      );
    }
    must(
      isPlainObject(pr.reviews) &&
        Array.isArray(pr.reviews.approved) &&
        Array.isArray(pr.reviews.changes_requested),
      `${where} has an open PR without "reviews"`,
    );
    must(
      Array.isArray(pr.review_threads),
      `${where} has an open PR without "review_threads"`,
    );
  }
  for (const request of snapshot.review_requests) {
    if (request?.repo !== snapshot.repo) continue;
    const where = `wt-status review request #${request.number}`;
    must(Number.isInteger(request.number), `${where} has no PR number`);
    must(
      typeof request.head === "string" && request.head !== "",
      `${where} has no "head"`,
    );
    must(
      !Number.isNaN(Date.parse(request.created_at)),
      `${where} has an unreadable "created_at": ${JSON.stringify(request.created_at)}`,
    );
  }
}

function unresolvedThreads(pr) {
  return pr.review_threads.filter((thread) => !thread.resolved);
}

function isOpenForReview(pr) {
  return pr !== null && pr.state === "open" && !pr.draft;
}

/**
 * What needs the user on a worktree's PR, as [{ kind, detail }], with kind the
 * research kind that looks into it and detail a one-line summary. Only an
 * open, non-draft PR has triggers.
 */
export function worktreeTriggers(wt) {
  const pr = wt.pr;
  if (!isOpenForReview(pr)) return [];
  const triggers = [];
  if (pr.ci.result === "fail")
    triggers.push({ kind: "ci-failure", detail: "CI failing" });
  const changes = pr.reviews.changes_requested;
  const unresolved = unresolvedThreads(pr);
  if (changes.length > 0 || unresolved.length > 0) {
    const parts = [];
    if (changes.length > 0)
      parts.push(`changes requested by ${changes.join(", ")}`);
    if (unresolved.length > 0)
      parts.push(
        `${unresolved.length} unresolved thread${unresolved.length === 1 ? "" : "s"}`,
      );
    triggers.push({ kind: "review-feedback", detail: parts.join("; ") });
  }
  if (pr.mergeable === false)
    triggers.push({
      kind: "merge-conflict",
      detail: `conflicts with ${pr.base}`,
    });
  return triggers;
}

/** The worktree's state: "done", "local", "needs", "ready" or "waiting". */
export function worktreeState(wt) {
  const pr = wt.pr;
  if (pr !== null && (pr.state === "merged" || pr.state === "closed"))
    return "done";
  if (pr === null || pr.draft) return "local";
  if (worktreeTriggers(wt).length > 0) return "needs";
  if (
    pr.reviews.approved.length > 0 &&
    pr.ci.result === "pass" &&
    pr.mergeable === true
  )
    return "ready";
  return "waiting";
}

/** The worktree's local-change badges, such as "35 uncommitted". */
export function worktreeBadges(wt) {
  const badges = [];
  if (wt.dirty_files > 0) badges.push(`${wt.dirty_files} uncommitted`);
  if (wt.pr !== null && wt.pr.ahead > 0) badges.push(`${wt.pr.ahead} unpushed`);
  if (wt.pr !== null && wt.pr.behind > 0)
    badges.push(`${wt.pr.behind} behind PR`);
  return badges;
}

/**
 * Identifies the review feedback on an open PR: it changes when the head
 * moves, a thread is resolved or opened, or the reviewers requesting changes
 * change.
 */
export function reviewFingerprint(pr) {
  const threads = unresolvedThreads(pr)
    .map((thread) => thread.url)
    .sort();
  const logins = [...pr.reviews.changes_requested].sort();
  return createHash("sha1")
    .update(JSON.stringify([pr.head, threads, logins]))
    .digest("hex");
}

/** Whether a review request created at ISO time `createdAt` is at most RECENT_DAYS days old at `now` (ms). */
export function isRecent(createdAt, now) {
  return now - Date.parse(createdAt) <= RECENT_MS;
}

/** The snapshot's review requests in its own repo, newest first. */
export function repoReviewRequests(snapshot) {
  return snapshot.review_requests
    .filter((request) => request.repo === snapshot.repo)
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
}

/** The key of research of `kind` on `subject`: a worktree's branch, or a review request's PR number. */
function researchKey(kind, subject) {
  return `${kind}:${subject}`;
}

function researchName(kind, number) {
  return `${kind} #${number}`;
}

/**
 * Everything in the snapshot that research can run on, in the order automatic
 * starts queue them (each worktree's triggers, in wt-status's worktree order,
 * then review requests newest first), as [{ key, kind, fingerprint, head, dir,
 * name, recent, ciFinished, values }], where `values` fills the kind's
 * placeholders, `recent` is null except for review requests, and `ciFinished`,
 * whether every check on the head has finished, is null except for CI research.
 */
export function researchTargets(snapshot, mainCheckout, now) {
  const { repo } = snapshot;
  const targets = [];
  for (const wt of snapshot.worktrees) {
    const triggers = worktreeTriggers(wt);
    if (triggers.length === 0) continue;
    const pr = wt.pr;
    const values = {
      repo,
      number: String(pr.number),
      url: pr.url,
      title: pr.title,
      head: pr.head,
      dir: wt.path,
      branch: wt.branch,
      base: pr.base,
    };
    for (const trigger of triggers) {
      const target = {
        key: researchKey(trigger.kind, wt.branch),
        kind: trigger.kind,
        name: researchName(trigger.kind, pr.number),
        head: pr.head,
        dir: wt.path,
        recent: null,
        ciFinished: null,
      };
      switch (trigger.kind) {
        case "ci-failure":
          targets.push({
            ...target,
            fingerprint: pr.head,
            ciFinished: pr.ci.checks.every(
              (check) => check.status === "completed",
            ),
            values: {
              ...values,
              failing_checks: pr.ci.checks
                .filter((check) => check.failing)
                .map((check) => `- ${check.name}: ${check.url}`)
                .join("\n"),
            },
          });
          break;
        case "review-feedback": {
          const threads = unresolvedThreads(pr).map(
            (thread) =>
              `- ${thread.path} (by ${thread.author}${thread.outdated ? ", outdated" : ""}): ${thread.url}`,
          );
          const changes = pr.reviews.changes_requested;
          targets.push({
            ...target,
            fingerprint: reviewFingerprint(pr),
            values: {
              ...values,
              unresolved_threads:
                threads.length > 0 ? threads.join("\n") : "none",
              changes_requested:
                changes.length > 0 ? changes.join(", ") : "none",
            },
          });
          break;
        }
        case "merge-conflict":
          targets.push({
            ...target,
            // The base moves far more often than the conflict changes, so
            // only a new head runs the research again.
            fingerprint: pr.head,
            values,
          });
          break;
        default:
          throw new Error(
            `worktree ${wt.path} has unknown trigger kind ${JSON.stringify(trigger.kind)}`,
          );
      }
    }
  }
  for (const request of repoReviewRequests(snapshot)) {
    targets.push({
      key: researchKey("review-request", request.number),
      kind: "review-request",
      name: researchName("review-request", request.number),
      fingerprint: request.head,
      head: request.head,
      dir: mainCheckout,
      recent: isRecent(request.created_at, now),
      ciFinished: null,
      values: {
        repo,
        number: String(request.number),
        url: request.url,
        title: request.title,
        head: request.head,
        dir: mainCheckout,
        author: request.author,
      },
    });
  }
  return targets;
}

function isBusy(record) {
  return record.status === "queued" || record.status === "running";
}

/** The review request's state, "new", "researched" or "outdated", given its research record or undefined. */
export function requestState(request, record) {
  if (record === undefined || record.status !== "done") return "new";
  return record.head === request.head ? "researched" : "outdated";
}

/** The keys of the targets whose research the starting rules start now, in queueing order. */
export function keysToStart(targets, records) {
  return targets
    .filter((target) => {
      const record = records[target.key];
      if (target.kind === "review-request")
        return target.recent && record === undefined;
      // A run on the head is not repeated, so one started while checks still
      // run would never see the failures that come after it.
      if (target.kind === "ci-failure" && !target.ciFinished) return false;
      return (
        record === undefined ||
        (record.fingerprint !== target.fingerprint && !isBusy(record))
      );
    })
    .map((target) => target.key);
}

/**
 * A queued run of `target`, replacing `record` (undefined when the key has
 * none), which moves into `previous`. `now` is an ISO time.
 */
export function queueRun(record, target, now) {
  must(
    record === undefined || !isBusy(record),
    `cannot queue ${target.key}: its run is ${record?.status}`,
  );
  return {
    key: target.key,
    kind: target.kind,
    fingerprint: target.fingerprint,
    head: target.head,
    dir: target.dir,
    name: target.name,
    session_id: null,
    status: "queued",
    queued_at: now,
    started_at: null,
    finished_at: null,
    reason: null,
    result: null,
    cost_usd: null,
    previous:
      record === undefined
        ? []
        : [
            {
              session_id: record.session_id,
              status: record.status,
              finished_at: record.finished_at,
            },
            ...record.previous,
          ],
  };
}

/**
 * The queued `record` as running session `sessionId`, looking at `target` as
 * it stands when the run starts.
 */
export function startRun(record, target, sessionId, now) {
  must(
    record.status === "queued",
    `cannot start ${record.key}: its run is ${record.status}`,
  );
  return {
    ...record,
    kind: target.kind,
    fingerprint: target.fingerprint,
    head: target.head,
    dir: target.dir,
    name: target.name,
    session_id: sessionId,
    status: "running",
    started_at: now,
  };
}

/** `record` finished with `outcome` ({ status, reason, result, cost_usd }) at ISO time `now`. */
export function finishRun(record, outcome, now) {
  return { ...record, ...outcome, finished_at: now };
}

/**
 * The records as a new server start takes them over: runs left running are
 * failed, and the queued ones are returned in `queue` by their queue time.
 */
export function recoverRecords(records, now) {
  const recovered = {};
  for (const [key, record] of Object.entries(records)) {
    recovered[key] =
      record.status === "running"
        ? finishRun(record, { status: "failed", reason: STOPPED_REASON }, now)
        : record;
  }
  const queue = Object.values(recovered)
    .filter((record) => record.status === "queued")
    .sort((a, b) => Date.parse(a.queued_at) - Date.parse(b.queued_at))
    .map((record) => record.key);
  return { records: recovered, queue };
}

function exitDescription(code, signal) {
  return code === null ? `killed by ${signal}` : `exit code ${code}`;
}

/**
 * How a `claude -p --output-format json` run ended, as { status: "done" |
 * "failed", reason, result, cost_usd }, from its exit code (or signal when
 * killed), stdout and stderr.
 */
export function runOutcome({ code, signal, stdout, stderr }) {
  let json = null;
  try {
    const parsed = JSON.parse(stdout);
    if (isPlainObject(parsed)) json = parsed;
  } catch {
    // An unparsable stdout fails the run below.
  }
  const result = typeof json?.result === "string" ? json.result : null;
  const cost_usd =
    typeof json?.total_cost_usd === "number" ? json.total_cost_usd : null;
  if (code === 0 && json?.is_error === false)
    return { status: "done", reason: null, result, cost_usd };
  const subtype =
    typeof json?.subtype === "string" && json.subtype !== "success"
      ? json.subtype
      : null;
  const reason =
    subtype || result || lastLine(stderr) || exitDescription(code, signal);
  return { status: "failed", reason, result, cost_usd };
}

/** The prompt and permission settings of a run of `target`, with its placeholders filled. */
export function runInvocation(prompts, target) {
  const settings = prompts[target.kind];
  must(settings !== undefined, `no prompt settings for kind ${target.kind}`);
  const fill = (text) => fillPlaceholders(text, target.values);
  return {
    prompt: fill(settings.template),
    permissionMode: settings.permissionMode,
    allowedTools: settings.allowedTools.map(fill),
    disallowedTools: settings.disallowedTools.map(fill),
  };
}

/** The arguments of a `claude -p` research session. */
export function claudeArgs({
  prompt,
  sessionId,
  name,
  permissionMode,
  allowedTools,
  disallowedTools,
  maxBudgetUsd,
}) {
  const args = [
    "-p",
    prompt,
    "--session-id",
    sessionId,
    "--name",
    name,
    "--output-format",
    "json",
    "--permission-mode",
    permissionMode,
  ];
  if (allowedTools.length > 0) args.push("--allowedTools", ...allowedTools);
  if (disallowedTools.length > 0)
    args.push("--disallowedTools", ...disallowedTools);
  if (maxBudgetUsd !== null) args.push("--max-budget-usd", maxBudgetUsd);
  return args;
}

/**
 * The page's view of a research record; `stale` marks finished research whose
 * target's fingerprint has changed since it ran.
 */
export function researchView(record, home, stale) {
  const dir = tildify(record.dir, home);
  const finished = record.status === "done" || record.status === "failed";
  return {
    key: record.key,
    kind: record.kind,
    status: record.status,
    name: record.name,
    session_id: record.session_id,
    dir,
    queued_at: record.queued_at,
    started_at: record.started_at,
    finished_at: record.finished_at,
    reason: record.reason,
    result: record.result,
    cost_usd: record.cost_usd,
    resume_command:
      finished && record.session_id
        ? `cd ${dir} && claude --resume ${record.session_id}`
        : null,
    stale,
  };
}

function prView(pr) {
  const threads = pr.review_threads ?? [];
  const unresolved = threads.filter((thread) => !thread.resolved);
  return {
    number: pr.number,
    url: pr.url,
    title: pr.title,
    base: pr.base,
    draft: pr.draft,
    state: pr.state,
    head: short(pr.head),
    ahead: pr.ahead,
    behind: pr.behind,
    mergeable: pr.mergeable,
    ci_result: pr.ci?.result ?? null,
    checks: (pr.ci?.checks ?? []).map(
      ({ name, conclusion, status, url, failing }) => ({
        name,
        conclusion,
        status,
        url,
        failing,
      }),
    ),
    approved: pr.reviews?.approved ?? [],
    changes_requested: pr.reviews?.changes_requested ?? [],
    commented: pr.reviews?.commented ?? [],
    requested: pr.reviews?.requested ?? [],
    threads_total: threads.length,
    threads_unresolved: unresolved.length,
    unresolved_threads: unresolved.map(
      ({ path: file, author, url, outdated }) => ({
        path: file,
        author,
        url,
        outdated,
      }),
    ),
  };
}

/** The body of GET /api/state, with `wtRemove` the wt-remove command the page offers to copy. */
export function buildState({
  snapshot,
  records,
  mainCheckout,
  wtRemove,
  home,
  now,
  fetchedAt,
  nextFetchAt,
  fetching,
  error,
}) {
  const checkout = tildify(mainCheckout, home);
  const targets = new Map(
    researchTargets(snapshot, mainCheckout, now).map((target) => [
      target.key,
      target,
    ]),
  );
  const research = (key) => {
    const record = records[key];
    if (record === undefined) return null;
    const stale =
      !isBusy(record) && record.fingerprint !== targets.get(key).fingerprint;
    return researchView(record, home, stale);
  };
  const worktrees = snapshot.worktrees.map((wt) => ({
    branch: wt.branch,
    path: tildify(wt.path, home),
    head: short(wt.head),
    dirty_files: wt.dirty_files,
    dirty_submodules: wt.dirty_submodules,
    state: worktreeState(wt),
    badges: worktreeBadges(wt),
    pr: wt.pr === null ? null : prView(wt.pr),
    triggers: worktreeTriggers(wt).map(({ kind, detail }) => {
      const { key, name } = targets.get(researchKey(kind, wt.branch));
      return { kind, detail, key, name, research: research(key) };
    }),
    remove_command:
      wt.pr?.state === "merged"
        ? `cd ${checkout} && ${tildify(wtRemove, home)} ${wt.branch}`
        : null,
  }));
  const reviewRequests = repoReviewRequests(snapshot).map((request) => {
    const { key, name, recent } = targets.get(
      researchKey("review-request", request.number),
    );
    return {
      key,
      name,
      number: request.number,
      url: request.url,
      title: request.title,
      author: request.author,
      created_at: request.created_at,
      head: short(request.head),
      recent,
      state: requestState(request, records[key]),
      research: research(key),
    };
  });
  const statuses = Object.values(records).map((record) => record.status);
  return {
    repo: snapshot.repo,
    checkout,
    fetched_at: fetchedAt,
    next_fetch_at: nextFetchAt,
    fetching,
    error,
    running: statuses.filter((status) => status === "running").length,
    queued: statuses.filter((status) => status === "queued").length,
    max_running: MAX_RUNNING,
    recent_days: RECENT_DAYS,
    worktrees,
    review_requests: reviewRequests,
  };
}

/** Runs a command to completion; rejects only when it cannot be started. */
function runCommand(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      ...options,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code, signal) =>
      resolve({
        code,
        signal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      }),
    );
  });
}

function readIfPresent(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return "";
    throw error;
  }
}

function writeAtomically(file, text, mode) {
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, text, { mode });
  fs.renameSync(temp, file);
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

/**
 * The monitor of one repo: polls wt-status, keeps the research records and
 * runs them, and serves the page and its API.
 */
export class Monitor {
  constructor({ stateDir, checkout, port, maxBudgetUsd, env }) {
    Object.assign(this, envConfig(env));
    this.stateDir = stateDir;
    this.checkout = checkout;
    this.port = port;
    this.maxBudgetUsd = maxBudgetUsd;
    this.env = env;
    this.token = randomBytes(24).toString("base64url");
    this.records = {};
    this.queue = [];
    this.children = new Map();
    this.snapshot = null;
    this.fetchedAt = null;
    this.nextFetchAt = null;
    this.error = null;
    this.inflight = null;
    this.removing = null;
    this.timer = null;
  }

  /**
   * Starts serving, after the first wt-status run succeeds, and returns the
   * page's URL. Throws on bad prompts, a taken port, a failed first wt-status
   * run, or another monitor running on the same state dir.
   */
  async start() {
    this.prompts = loadPrompts(this.promptsDir);
    fs.mkdirSync(this.runsDir, { recursive: true });
    this.checkNoOtherMonitor();
    this.mainCheckout = await this.findMainCheckout();
    await this.listen();
    let snapshot;
    try {
      snapshot = await this.fetchSnapshot();
    } catch (error) {
      throw new Error(
        `${this.wtStatus} -C ${this.checkout} failed: ${error.message}`,
      );
    }
    this.repo = snapshot.repo;
    this.loadRecords();
    this.accept(snapshot);
    this.schedule();
    const url = `http://127.0.0.1:${this.port}/#token=${this.token}`;
    const info = {
      pid: process.pid,
      port: this.port,
      url,
      started_at: new Date().toISOString(),
    };
    writeAtomically(
      this.serverFile,
      `${JSON.stringify(info, null, 2)}\n`,
      0o600,
    );
    return url;
  }

  /** Sends SIGTERM to the running research sessions and removes server.json if it is still this process's. */
  shutdown() {
    for (const child of this.children.values()) child.kill("SIGTERM");
    let info;
    try {
      info = JSON.parse(fs.readFileSync(this.serverFile, "utf8"));
    } catch {
      return;
    }
    if (info.pid === process.pid) fs.rmSync(this.serverFile, { force: true });
  }

  async findMainCheckout() {
    const out = await runCommand(
      "git",
      ["-C", this.checkout, "worktree", "list", "--porcelain"],
      { env: this.env },
    );
    must(
      out.code === 0,
      `git -C ${this.checkout} worktree list failed: ${lastLine(out.stderr) ?? exitDescription(out.code, out.signal)}`,
    );
    const main = out.stdout.split("\n")[0].match(/^worktree (.+)$/)?.[1];
    must(
      main !== undefined,
      `git -C ${this.checkout} worktree list printed no worktree line: ${JSON.stringify(out.stdout)}`,
    );
    return main;
  }

  listen() {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => this.handle(req, res));
      this.server.once("error", (error) =>
        reject(
          error.code === "EADDRINUSE"
            ? new Error(`port ${this.port} on 127.0.0.1 is already in use`)
            : error,
        ),
      );
      this.server.listen(this.port, "127.0.0.1", () => {
        this.port = this.server.address().port;
        resolve();
      });
    });
  }

  checkNoOtherMonitor() {
    let info;
    try {
      info = JSON.parse(fs.readFileSync(this.serverFile, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw new Error(`cannot read ${this.serverFile}: ${error.message}`);
    }
    // Two monitors on one state dir would each run the same research.
    must(
      !(
        Number.isInteger(info.pid) &&
        info.pid !== process.pid &&
        isAlive(info.pid)
      ),
      `a monitor is already running on ${this.stateDir}: pid ${info.pid}, ${info.url}`,
    );
  }

  get recordsFile() {
    return path.join(this.stateDir, "research.json");
  }

  get serverFile() {
    return path.join(this.stateDir, "server.json");
  }

  get runsDir() {
    return path.join(this.stateDir, "runs");
  }

  loadRecords() {
    let records = {};
    const text = readIfPresent(this.recordsFile);
    if (text !== "") {
      try {
        records = JSON.parse(text);
      } catch (error) {
        throw new Error(`cannot parse ${this.recordsFile}: ${error.message}`);
      }
      must(
        isPlainObject(records),
        `${this.recordsFile} must hold an object keyed by research key`,
      );
      for (const [key, record] of Object.entries(records)) {
        must(
          isPlainObject(record) &&
            record.key === key &&
            RECORD_STATUSES.includes(record.status),
          `${this.recordsFile} has a malformed record under ${key}: ${JSON.stringify(record)}`,
        );
      }
    }
    const recovered = recoverRecords(records, new Date().toISOString());
    this.records = recovered.records;
    this.queue = recovered.queue;
    this.save();
  }

  save() {
    writeAtomically(
      this.recordsFile,
      `${JSON.stringify(this.records, null, 2)}\n`,
      0o644,
    );
  }

  /** The current snapshot from wt-status; throws with the error the page shows. */
  async fetchSnapshot() {
    let out;
    try {
      out = await runCommand(this.wtStatus, ["-C", this.checkout], {
        env: this.env,
      });
    } catch (error) {
      throw new Error(`cannot run ${this.wtStatus}: ${error.message}`);
    }
    if (out.code !== 0) {
      const line = lastLine(out.stderr);
      const exit = exitDescription(out.code, out.signal);
      throw new Error(line === null ? exit : `${line} (${exit})`);
    }
    let snapshot;
    try {
      snapshot = JSON.parse(out.stdout);
    } catch (error) {
      throw new Error(`wt-status printed invalid JSON: ${error.message}`);
    }
    checkSnapshot(snapshot);
    must(
      this.repo === undefined || snapshot.repo === this.repo,
      `wt-status reported repo ${snapshot.repo}, but this monitor serves ${this.repo}`,
    );
    return snapshot;
  }

  /**
   * Runs wt-status unless a run is in flight, whose result it then shares, and
   * resolves to { ok: true } or { error }. While worktrees are being removed,
   * the run waits until they are gone.
   */
  poll() {
    // wt-status fails on a worktree that disappears while it runs.
    if (this.removing !== null) return this.removing.then(() => this.poll());
    if (this.inflight !== null) return this.inflight;
    clearTimeout(this.timer);
    this.nextFetchAt = null;
    this.inflight = this.fetchSnapshot()
      .then(
        (snapshot) => {
          this.error = null;
          this.accept(snapshot);
          return { ok: true };
        },
        (error) => {
          this.error = error.message;
          return { error: error.message };
        },
      )
      .finally(() => {
        this.inflight = null;
        this.schedule();
      });
    return this.inflight;
  }

  schedule() {
    clearTimeout(this.timer);
    const delay = this.pollSeconds * 1000;
    this.nextFetchAt = new Date(Date.now() + delay).toISOString();
    this.timer = setTimeout(() => this.poll(), delay);
  }

  accept(snapshot) {
    this.snapshot = snapshot;
    this.fetchedAt = new Date().toISOString();
    this.startDue();
  }

  targets() {
    return researchTargets(this.snapshot, this.mainCheckout, Date.now());
  }

  /** Queues what the starting rules start, then fills free run slots. */
  startDue() {
    const targets = this.targets();
    const now = new Date().toISOString();
    for (const key of keysToStart(targets, this.records)) {
      this.records[key] = queueRun(
        this.records[key],
        targets.find((target) => target.key === key),
        now,
      );
      this.queue.push(key);
    }
    this.save();
    this.pump();
  }

  /** Starts (or retries, or re-runs) research on `key`, as { status, error? }. */
  requestResearch(key) {
    const target = this.targets().find((candidate) => candidate.key === key);
    if (target === undefined)
      return {
        status: 404,
        error: `no current trigger or review request has key ${key}`,
      };
    const record = this.records[key];
    if (record !== undefined && isBusy(record))
      return { status: 409, error: `${key} is already ${record.status}` };
    this.records[key] = queueRun(record, target, new Date().toISOString());
    this.queue.push(key);
    this.save();
    this.pump();
    return { status: 200 };
  }

  /**
   * Removes the worktrees of merged PRs and deletes their branches, then runs
   * wt-status, as { status, error? } or { status: 200, removed: [branch],
   * failed: [{ branch, error }] }. A worktree that wt-remove refuses, or that
   * research is running in, is left as it is and listed in `failed`.
   */
  async removeMerged() {
    if (this.removing !== null)
      return {
        status: 409,
        error: "the merged worktrees are already being removed",
      };
    this.removing = this.removeEachMerged().finally(() => {
      this.removing = null;
    });
    const result = await this.removing;
    await this.poll();
    return { status: 200, ...result };
  }

  async removeEachMerged() {
    // A wt-status run already under way may still list a worktree that goes.
    if (this.inflight !== null) await this.inflight;
    const removed = [];
    const failed = [];
    for (const wt of this.snapshot.worktrees) {
      if (wt.pr?.state !== "merged") continue;
      const busy = Object.values(this.records).find(
        (record) => isBusy(record) && record.dir === wt.path,
      );
      if (busy !== undefined) {
        failed.push({
          branch: wt.branch,
          error: `research ${busy.name} is ${busy.status} in ${tildify(wt.path, os.homedir())}`,
        });
        continue;
      }
      let out;
      try {
        out = await runCommand(this.wtRemove, [wt.branch], {
          cwd: this.mainCheckout,
          env: this.env,
        });
      } catch (error) {
        failed.push({
          branch: wt.branch,
          error: `cannot run ${this.wtRemove}: ${error.message}`,
        });
        continue;
      }
      if (out.code === 0) removed.push(wt.branch);
      else
        failed.push({
          branch: wt.branch,
          error: out.stderr.trim() || exitDescription(out.code, out.signal),
        });
    }
    return { removed, failed };
  }

  pump() {
    while (this.children.size < MAX_RUNNING && this.queue.length > 0) {
      const key = this.queue.shift();
      const record = this.records[key];
      const target = this.targets().find((candidate) => candidate.key === key);
      if (target === undefined) {
        this.records[key] = finishRun(
          record,
          {
            status: "failed",
            reason: GONE_REASON,
            result: null,
            cost_usd: null,
          },
          new Date().toISOString(),
        );
        this.save();
        continue;
      }
      this.spawnRun(record, target);
    }
  }

  spawnRun(queued, target) {
    const sessionId = randomUUID();
    const args = claudeArgs({
      ...runInvocation(this.prompts, target),
      sessionId,
      name: target.name,
      maxBudgetUsd: this.maxBudgetUsd,
    });
    const record = startRun(
      queued,
      target,
      sessionId,
      new Date().toISOString(),
    );
    this.records[record.key] = record;
    this.save();
    const stdoutFile = path.join(this.runsDir, `${sessionId}.stdout`);
    const stderrFile = path.join(this.runsDir, `${sessionId}.stderr`);
    // The session writes straight to the files, so its output survives this
    // process.
    const stdout = fs.openSync(stdoutFile, "w");
    const stderr = fs.openSync(stderrFile, "w");
    let child;
    try {
      child = spawn(this.claude, args, {
        cwd: record.dir,
        env: this.env,
        stdio: ["ignore", stdout, stderr],
      });
    } finally {
      fs.closeSync(stdout);
      fs.closeSync(stderr);
    }
    this.children.set(record.key, child);
    let finished = false;
    const finish = (outcome) => {
      if (finished) return;
      finished = true;
      this.children.delete(record.key);
      this.records[record.key] = finishRun(
        this.records[record.key],
        outcome,
        new Date().toISOString(),
      );
      // A head that moved while the run looked at the old one is due again now.
      this.startDue();
    };
    child.on("error", (error) =>
      finish({
        status: "failed",
        reason: `cannot run ${this.claude} in ${record.dir}: ${error.message}`,
        result: null,
        cost_usd: null,
      }),
    );
    child.on("exit", (code, signal) =>
      finish(
        runOutcome({
          code,
          signal,
          stdout: readIfPresent(stdoutFile),
          stderr: readIfPresent(stderrFile),
        }),
      ),
    );
  }

  state() {
    return buildState({
      snapshot: this.snapshot,
      records: this.records,
      mainCheckout: this.mainCheckout,
      wtRemove: this.wtRemove,
      home: os.homedir(),
      now: Date.now(),
      fetchedAt: this.fetchedAt,
      nextFetchAt: this.nextFetchAt,
      fetching: this.inflight !== null,
      error: this.error,
    });
  }

  authorized(req) {
    const expected = Buffer.from(`Bearer ${this.token}`);
    const given = Buffer.from(req.headers.authorization ?? "");
    return given.length === expected.length && timingSafeEqual(given, expected);
  }

  async handle(req, res) {
    const send = (status, body) => {
      res.writeHead(status, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      });
      res.end(JSON.stringify(body));
    };
    try {
      const hosts = [`127.0.0.1:${this.port}`, `localhost:${this.port}`];
      if (!hosts.includes(req.headers.host)) {
        return send(403, {
          error: `Host ${JSON.stringify(req.headers.host)} is not ${hosts.join(" or ")}`,
        });
      }
      const route = `${req.method} ${new URL(req.url, "http://127.0.0.1").pathname}`;
      if (route === "GET /") {
        const index = path.join(SERVER_DIR, "index.html");
        const html = fs.readFileSync(index);
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
        });
        return res.end(html);
      }
      if (!this.authorized(req))
        return send(401, { error: "missing or wrong token" });
      switch (route) {
        case "GET /api/state":
          return send(200, this.state());
        case "POST /api/refresh": {
          const result = await this.poll();
          return result.ok
            ? send(200, { ok: true })
            : send(502, { error: result.error });
        }
        case "POST /api/remove-merged": {
          const { status, error, ...result } = await this.removeMerged();
          return status === 200 ? send(200, result) : send(status, { error });
        }
        case "POST /api/research": {
          let key;
          try {
            key = JSON.parse(await readBody(req)).key;
          } catch {
            // Reported below as a bad body.
          }
          if (typeof key !== "string")
            return send(400, {
              error: 'the body must be {"key": "<research key>"}',
            });
          const { status, error } = this.requestResearch(key);
          return status === 200
            ? send(200, { ok: true })
            : send(status, { error });
        }
        default:
          return send(404, { error: `no route ${route}` });
      }
    } catch (error) {
      return send(500, { error: error.message });
    }
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/** Runs the server from the command line; exits 1 with the error on a failed start. */
export async function main(argv = process.argv.slice(2), env = process.env) {
  let monitor = null;
  process.on("exit", () => monitor?.shutdown());
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => process.exit(128 + os.constants.signals[signal]));
  }
  try {
    monitor = new Monitor({ ...parseArgs(argv), env });
    const url = await monitor.start();
    console.log(`monitor for ${monitor.repo}: ${url}`);
  } catch (error) {
    console.error(`monitor: ${error.message}`);
    process.exit(1);
  }
}

if (
  process.argv[1] !== undefined &&
  fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await main();
}
