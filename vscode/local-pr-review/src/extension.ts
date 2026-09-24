import * as vscode from "vscode";
import { GitService } from "./git/gitService";
import { GitFileContentProvider } from "./git/gitFileContentProvider";
import { LocalPrManager } from "./services/localPrManager";
import { StorageService } from "./storage/storageService";
import {
  ChangedFilesProvider,
  FileChangeItem,
  SectionItem,
} from "./views/changedFilesProvider";
import { LocalPrsProvider, LocalPrItem } from "./views/localPrsProvider";
import {
  LocalCommentsProvider,
  CommentNavItem,
} from "./views/localCommentsProvider";
import { ReviewCommentController } from "./comments/commentController";
import { runTriage, runReview } from "./triage/triageController";
import * as os from "os";
import { LocalReviewTool } from "./tools/localReviewTool";
import { ReviewFileDecorationProvider } from "./decorations/fileDecorationProvider";
import { SuggestChangePanel } from "./views/suggestChangePanel";

export async function activate(context: vscode.ExtensionContext) {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceRoot) {
    vscode.window.showInformationMessage(
      "Local PR Review: Open a Git repository folder to use this extension.",
    );
    return;
  }

  // Initialize git service
  const gitService = new GitService(context);

  // Initialize services (will work once git is ready)
  const localPrManager = new LocalPrManager(gitService, workspaceRoot);
  const storageService = new StorageService(localPrManager);

  // Register custom URI scheme for git file content
  const gitFileContentProvider = new GitFileContentProvider(gitService);
  context.subscriptions.push(
    vscode.workspace.registerFileSystemProvider(
      "git-local-review",
      gitFileContentProvider,
      { isReadonly: true, isCaseSensitive: true },
    ),
  );

  // Initialize view providers
  const changedFilesProvider = new ChangedFilesProvider(
    gitService,
    storageService,
    localPrManager,
  );
  const localPrsProvider = new LocalPrsProvider(localPrManager);
  const localCommentsProvider = new LocalCommentsProvider(storageService);

  // Quick-diff gutter for review: a file's "original" is its reviewed snapshot R,
  // so the editor shows change bars vs what you've already reviewed, and the
  // scm/change/title "Mark reviewed" action (below) folds a hunk into R — like
  // git's per-hunk Stage Change, but in our own snapshot (immune to the index).
  const reviewScm = vscode.scm.createSourceControl(
    "localPrReview",
    "Local Review",
    vscode.workspace.workspaceFolders?.[0]?.uri,
  );
  reviewScm.quickDiffProvider = {
    provideOriginalResource(uri) {
      if (uri.scheme !== "file") {
        return undefined;
      }
      const filePath = vscode.workspace.asRelativePath(uri, false);
      if (!changedFilesProvider.getAllFilePaths().includes(filePath)) {
        return undefined;
      }
      // A stable per-path URI whose CONTENT is the current snapshot — so firing
      // the content provider's change event (in refreshNow) makes the gutter
      // recompute after a hunk is marked, without changing the URI.
      return vscode.Uri.parse(
        `git-local-review://authority/${filePath}?snapshot=1`,
      );
    },
  };
  context.subscriptions.push(reviewScm);
  gitFileContentProvider.setSnapshotResolver((p) =>
    changedFilesProvider.getReviewedSnapshotContent(p),
  );
  vscode.commands.executeCommand(
    "setContext",
    "localPrReview.active",
    !!localPrManager.getActiveReview(),
  );

  // The SourceControl exists ONLY to host the quickDiffProvider above — the gutter
  // change-bars vs the reviewed snapshot, and the per-hunk `scm/change/title`
  // "Mark reviewed" action (both keyed off the matching `?snapshot=1` original URI +
  // the `localPrReview.active` context, NOT off resource state). So we register NO
  // resource groups and hide the input box: the provider contributes nothing to the
  // Source Control view. The dedicated "Changed Files" tree is the file list; a second
  // SCM provider mirroring the same files was redundant clutter.
  reviewScm.inputBox.visible = false;

  // Initialize comment controller
  const commentController = new ReviewCommentController(
    storageService,
    context.globalStorageUri,
  );

  // Initialize file decoration provider (shows unresolved comment badges in explorer)
  const fileDecorationProvider = new ReviewFileDecorationProvider(
    storageService,
  );
  context.subscriptions.push(
    vscode.window.registerFileDecorationProvider(fileDecorationProvider),
  );

  // Register Copilot Language Model Tool (optional — requires VS Code 1.93+ and Copilot)
  try {
    const localReviewTool = new LocalReviewTool(
      gitService,
      localPrManager,
      storageService,
    );
    context.subscriptions.push(
      vscode.lm.registerTool("localPrReview_getComments", localReviewTool),
    );
  } catch {
    // Language Model API unavailable — extension works without it
  }

  // Register views

  // Changed files tree view with checkbox support
  const changedFilesTreeView = vscode.window.createTreeView(
    "localPrReview.changedFiles",
    {
      treeDataProvider: changedFilesProvider,
      manageCheckboxStateManually: true,
      showCollapseAll: true,
    },
  );
  changedFilesTreeView.onDidChangeCheckboxState(async (e) => {
    for (const [item, state] of e.items) {
      if (item instanceof FileChangeItem) {
        await changedFilesProvider.setFileReviewed(
          item.fileChange.filePath,
          state === vscode.TreeItemCheckboxState.Checked,
        );
      }
    }
    // Re-render so the toggled file moves into/out of the collapsed Reviewed
    // bucket. fireChange re-builds from cached files (no git re-run) — reviewed
    // state isn't a working-tree change.
    changedFilesProvider.fireChange();
  });

  // Show the "to review" count as a badge on the activity-bar icon. VS Code surfaces
  // a view's badge on its container icon, so this rides on every tree change (refresh,
  // checkbox toggle, hunk mark) since they all fire onDidChangeTreeData.
  const updateBadge = () => {
    const n = changedFilesProvider.toReviewCount();
    changedFilesTreeView.badge =
      n > 0
        ? { value: n, tooltip: `${n} file${n === 1 ? "" : "s"} to review` }
        : undefined;
    // Show a non-default base in the view header so it's never a mystery why the
    // file list looks the way it does (auto-detect shows nothing).
    const override = localPrManager.getBaseOverride();
    changedFilesTreeView.description = override
      ? `base: ${override}`
      : undefined;
  };
  changedFilesProvider.onDidChangeTreeData(() => updateBadge());

  context.subscriptions.push(
    changedFilesTreeView,
    vscode.window.createTreeView("localPrReview.localComments", {
      treeDataProvider: localCommentsProvider,
      showCollapseAll: true,
    }),
  );

  // Initialize git asynchronously (after tree views are registered)
  const initialized = await gitService.initialize();
  if (!initialized) {
    vscode.window.showInformationMessage(
      "Local PR Review: No git repository found. Open a folder with a git repo.",
    );
  }

  // Sync the list of reviewable file paths so comments work on working-tree files
  const syncReviewableFiles = () => {
    commentController.setReviewableFiles(
      changedFilesProvider.getAllFilePaths(),
    );
  };

  // Gate the "Mark hunk reviewed" title-bar/right-click/keybinding action to editors
  // showing a changeset file (incl. the review diff's working pane).
  const updateMarkContext = () => {
    const ed = vscode.window.activeTextEditor;
    let ok = false;
    if (ed) {
      const uri = ed.document.uri;
      if (uri.scheme === "file") {
        ok = changedFilesProvider
          .getAllFilePaths()
          .includes(vscode.workspace.asRelativePath(uri, false));
      } else if (
        uri.scheme === "git-local-review" &&
        new URLSearchParams(uri.query).get("snapshot")
      ) {
        ok = true; // left (reviewed) pane of the review diff
      }
    }
    vscode.commands.executeCommand(
      "setContext",
      "localPrReview.canMarkReviewed",
      ok,
    );
  };

  // Immediate (non-debounced) refresh after a UI-triggered git mutation.
  const refreshNow = async () => {
    await changedFilesProvider.refresh();
    syncReviewableFiles();
    updateMarkContext();
    fileDecorationProvider.refresh();
    gitFileContentProvider.refresh();
    vscode.commands.executeCommand(
      "setContext",
      "localPrReview.active",
      !!localPrManager.getActiveReview(),
    );
  };

  // Re-evaluate which threads have drifted from their anchor snapshot (reads the
  // working files), then refresh the navigator so its "outdated" tags update.
  const refreshOutdated = async () => {
    await commentController.recomputeOutdated();
    localCommentsProvider.refresh();
  };

  // Tracks which review's threads are currently materialized in the comment
  // controller, so a pure mode toggle (same review) doesn't needlessly reload
  // them, while a branch switch / new / externally-created review does.
  let loadedReviewId = localPrManager.getActiveReview()?.id;

  // Ensure a review exists for the current branch and refresh the file tree (always
  // whole-branch vs merge-base). Threads reload only when the active review actually
  // changed (first creation or a branch switch).
  const refreshActiveReview = async () => {
    const currentBranch = await gitService.getCurrentBranch();
    if (!currentBranch) {
      // Git not ready yet, or a detached HEAD mid-operation. Bail rather than
      // key a review on the literal 'HEAD' — that forks a second, empty review
      // and orphans this branch's comments. We retry on the next event.
      return;
    }
    const { review } = await localPrManager.ensureReview(
      currentBranch,
      "branch",
    );
    await changedFilesProvider.refresh();
    syncReviewableFiles();
    fileDecorationProvider.refresh();
    if (review.id !== loadedReviewId) {
      loadedReviewId = review.id;
      await commentController.loadAllThreads(
        gitService,
        review.sourceBranch,
        review.targetBranch,
      );
    }
    await refreshOutdated();
  };

  // Auto-start a review on a fresh worktree so the panel isn't empty next to a
  // Source Control full of changes. If a review for this branch already exists
  // (just not active), ensureReview activates it in its saved mode; a brand-new
  // one defaults to 'uncommitted'. Either way we apply that review's own mode, so
  // this never flips the mode the user picked. Skipped silently if the branch
  // isn't resolvable yet (e.g. detached HEAD mid-operation).
  if (!localPrManager.getActiveReview()) {
    const branch = await gitService.getCurrentBranch();
    if (branch) {
      await localPrManager.ensureReview(branch, "branch");
      await refreshActiveReview();
    }
  }

  // Compute the left/right diff URIs for a changed file. The two sections open
  // complementary halves of base ↔ working (together they cover the whole change):
  //   To Review copy:  reviewed snapshot ↔ working  — what's left to review.
  //   Reviewed copy:   base ↔ reviewed snapshot     — what you've already blessed.
  const computeDiffUris = (item: FileChangeItem) => {
    const filePath = item.fileChange.filePath;
    const workspaceUri = vscode.workspace.workspaceFolders?.[0]?.uri;
    const workingUri = workspaceUri
      ? vscode.Uri.joinPath(workspaceUri, filePath)
      : undefined;
    const gitUri = (ref: string) =>
      vscode.Uri.parse(
        `git-local-review://authority/${filePath}?ref=${encodeURIComponent(ref)}`,
      );
    const base = changedFilesProvider.getBaseRef() || "HEAD";

    // A deleted file has no working-tree side, so both copies collapse to one view:
    // base content on the left, an empty right pane, so it reads as fully removed.
    // Using workingUri as the modified side (as the other branches do) would point
    // VS Code at a path that no longer exists on disk — the "file not found" error.
    if (item.fileChange.status === "deleted") {
      const emptyRight = vscode.Uri.parse(
        `git-local-review://authority/${filePath}?empty=1`,
      );
      return {
        left: gitUri(base),
        right: emptyRight,
        title: `${filePath} (deleted)`,
      };
    }

    // Reviewed copy: base ↔ the blessed snapshot blob. For a fully-reviewed file the
    // snapshot equals working, so this is the whole approved diff; for a partial it's
    // just the blessed part. Falls back to base ↔ working if there's no snapshot blob.
    if (item.reviewedView) {
      const sha = changedFilesProvider.getReviewedSnapshotSha(filePath);
      const right = sha
        ? vscode.Uri.parse(
            `git-local-review://authority/${filePath}?blob=${sha}`,
          )
        : (workingUri ?? gitUri("HEAD"));
      return {
        left: gitUri(base),
        right,
        title: `${filePath} (base ↔ reviewed)`,
      };
    }

    // To Review copy: left = the reviewed snapshot, right = working. We use the SAME
    // `?snapshot=1` uri the QuickDiffProvider returns as the original, so VS Code
    // recognizes the diff as a quick-diff and overlays the `scm/change/title`
    // "Mark reviewed" action on each hunk — the staged/unstaged-style full diff with
    // per-hunk buttons. The snapshot content shrinks the diff as you mark.
    if (workingUri) {
      const left = vscode.Uri.parse(
        `git-local-review://authority/${filePath}?snapshot=1`,
      );
      return {
        left,
        right: workingUri,
        title: `${filePath} (reviewed ↔ working)`,
      };
    }

    // No workspace folder (shouldn't happen): fall back to base ↔ HEAD.
    return {
      left: gitUri(base),
      right: gitUri("HEAD"),
      title: `${filePath} (base ↔ working)`,
    };
  };

  // Scroll a just-opened diff to a comment's line and place the cursor there.
  // The right (modified) side may take a tick to become visible after the diff
  // opens, so we try now and retry once shortly after.
  const revealLineInEditor = (uri: vscode.Uri, line: number) => {
    const target = uri.toString();
    const tryReveal = () => {
      const editor = vscode.window.visibleTextEditors.find(
        (e) => e.document.uri.toString() === target,
      );
      if (!editor) {
        return false;
      }
      const pos = new vscode.Position(line, 0);
      editor.selection = new vscode.Selection(pos, pos);
      editor.revealRange(
        new vscode.Range(pos, pos),
        vscode.TextEditorRevealType.InCenter,
      );
      return true;
    };
    if (!tryReveal()) {
      setTimeout(tryReveal, 120);
    }
  };

  // Open a changed file's diff for the current mode, loading its comment threads.
  // Optionally reveal a specific line (used when jumping from the Comments
  // navigator). Shared by the openDiff and openCommentInDiff commands.
  const openDiffForItem = async (item: FileChangeItem, revealLine?: number) => {
    const filePath = item.fileChange.filePath;

    const { left, right, title } = computeDiffUris(item);

    // Invalidate any stale cached content (the :0 index ref is mutable).
    gitFileContentProvider.refresh();
    await vscode.commands.executeCommand("vscode.diff", left, right, title);

    // Content-position comments across both panes: each lands on whichever pane
    // holds its anchor code (right/newer wins), never at a stored line that doesn't
    // map onto a snapshot/base pane.
    await commentController.placeThreadsInDiff(left, right, filePath);
    if (revealLine !== undefined) {
      revealLineInEditor(right, revealLine);
    }
  };

  // Load active review on startup
  if (initialized) {
    const activeReview = localPrManager.getActiveReview();
    if (activeReview) {
      await changedFilesProvider.refresh();
      syncReviewableFiles();
      await commentController.loadAllThreads(
        gitService,
        activeReview.sourceBranch,
        activeReview.targetBranch,
      );
      await refreshOutdated();
    }
  }

  // Debounced refresh of the file tree. Both modes reflect the working tree, so we
  // refresh on save and on any git state change (staging/unstaging, new commits).
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  const scheduleRefresh = () => {
    if (!localPrManager.getActiveReview()) {
      return;
    }
    if (refreshTimer) {
      clearTimeout(refreshTimer);
    }
    refreshTimer = setTimeout(async () => {
      await changedFilesProvider.refresh();
      syncReviewableFiles();
      fileDecorationProvider.refresh();
      gitFileContentProvider.refresh();
      updateMarkContext();
      // A save/git change may have edited code under a comment — re-check drift.
      await refreshOutdated();
    }, 300);
  };
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument(() => scheduleRefresh()),
    gitService.onDidChangeState(() => scheduleRefresh()),
    vscode.window.onDidChangeActiveTextEditor(() => updateMarkContext()),
    // Also on cursor/click: a diff editor reports no active text editor until you
    // click into a pane, so the active-editor event alone leaves the mark action
    // disabled right after a diff opens. Re-evaluating on selection fixes that.
    vscode.window.onDidChangeTextEditorSelection(() => updateMarkContext()),
    // Re-scan when you return to VS Code or reopen the view. External edits (tools in a
    // terminal, git commands) don't fire onDidSaveTextDocument, so
    // without these the changeset + "to review" badge stay stale until the git
    // extension happens to refresh (usually on focus) — these make it deterministic.
    vscode.window.onDidChangeWindowState((e) => {
      if (e.focused) {
        scheduleRefresh();
      }
    }),
    changedFilesTreeView.onDidChangeVisibility((e) => {
      if (e.visible) {
        scheduleRefresh();
      }
    }),
  );
  updateMarkContext();

  // React to EXTERNAL changes to the comments store — e.g. a tool replying
  // from a terminal. Without this, the in-memory thread instances and
  // the file counters go stale, and the two diff-side copies of a thread
  // diverge (one shows the reply, the other doesn't). Our own writes are
  // skipped via storageService.lastWriteAt so typing a comment doesn't flicker.
  let reloadTimer: ReturnType<typeof setTimeout> | undefined;
  const reloadFromStorage = () => {
    if (reloadTimer) {
      clearTimeout(reloadTimer);
    }
    reloadTimer = setTimeout(async () => {
      if (Date.now() - storageService.lastWriteAt < 1500) {
        return;
      }
      // An external tool may have created or switched
      // the active review in registry.json, which we hold in memory; re-read it
      // so loadComments() targets the right review.
      localPrManager.reloadRegistry();
      const active = localPrManager.getActiveReview();
      if (active && active.id !== loadedReviewId) {
        // A different review just became active externally — do the full
        // startup-style load (rebuild the file tree and all threads) rather
        // than an in-place refresh of the previous review's instances.
        loadedReviewId = active.id;
        await changedFilesProvider.refresh();
        syncReviewableFiles();
        // loadAllThreads preloads avatars internally before building threads.
        await commentController.loadAllThreads(
          gitService,
          active.sourceBranch,
          active.targetBranch,
        );
        await refreshOutdated();
        fileDecorationProvider.refresh();
        return;
      }
      // Pull down any GitHub avatars an external write just referenced, so they're cached before the threads re-render.
      await commentController.preloadAvatars();
      // Update every open thread instance in place (keeps both diff sides,
      // incl. a staged diff's index side, without dispose/recreate).
      commentController.refreshThreadComments();
      syncReviewableFiles();
      // An external write may have changed code or set
      // `applied` — re-check drift so threads flip to Outdated + show the original.
      await refreshOutdated();
      fileDecorationProvider.refresh();
      changedFilesProvider.fireChange();
      gitFileContentProvider.refresh();
    }, 300);
  };
  const commentsWatcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(
      workspaceRoot,
      ".vscode/local-reviews/**/comments.json",
    ),
  );
  context.subscriptions.push(
    commentsWatcher,
    commentsWatcher.onDidChange(reloadFromStorage),
    commentsWatcher.onDidCreate(reloadFromStorage),
    commentsWatcher.onDidDelete(reloadFromStorage),
  );

  // Re-key the active review to the new branch when the user switches branches
  context.subscriptions.push(
    gitService.onDidChangeBranch(async () => {
      const active = localPrManager.getActiveReview();
      if (!active) {
        return;
      }
      await refreshActiveReview();
    }),
  );

  // --- Register commands ---

  // Create review for the current branch
  context.subscriptions.push(
    vscode.commands.registerCommand("localPrReview.createReview", async () => {
      await refreshActiveReview();
    }),
  );

  // Activate review (click on Local PR)
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "localPrReview.activateReview",
      async (item: LocalPrItem) => {
        localPrManager.setActiveReview(item.review.id);
        loadedReviewId = item.review.id;
        await changedFilesProvider.refresh();
        syncReviewableFiles();
        localCommentsProvider.refresh();
        await commentController.loadAllThreads(
          gitService,
          item.review.sourceBranch,
          item.review.targetBranch,
        );
        await refreshOutdated();
      },
    ),
  );

  // Delete review
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "localPrReview.deleteReview",
      async (item: LocalPrItem) => {
        const answer = await vscode.window.showWarningMessage(
          `Delete review "${item.review.targetBranch} -> ${item.review.sourceBranch}"? This will also delete all comments.`,
          { modal: true },
          "Delete",
        );
        if (answer === "Delete") {
          localPrManager.deleteReview(item.review.id);
          changedFilesProvider.clear();
          commentController.setReviewableFiles([]);
          localCommentsProvider.refresh();
          await commentController.loadAllThreads();
        }
      },
    ),
  );

  // Refresh changed files
  context.subscriptions.push(
    vscode.commands.registerCommand("localPrReview.refreshFiles", async () => {
      const active = localPrManager.getActiveReview();
      if (active) {
        await changedFilesProvider.refresh();
        syncReviewableFiles();
      }
    }),
  );

  // Expand all in changed files tree
  context.subscriptions.push(
    vscode.commands.registerCommand("localPrReview.expandAll", async () => {
      const items = changedFilesProvider.getAllExpandableItems();
      for (const item of items) {
        try {
          await changedFilesTreeView.reveal(item, {
            expand: true,
            select: false,
            focus: false,
          });
        } catch {
          // item may not be visible
        }
      }
    }),
  );

  context.subscriptions.push(
    // "Mark reviewed" in the quick-diff gutter change peek (scm/change/title). VS
    // Code passes the document uri, the change list, and the focused index; we
    // fold the hunk at that change's line into the file's reviewed snapshot. We
    // locate it against OUR snapshot by line (not the passed change ranges) so it
    // stays correct even if the peek belongs to git's vs-HEAD quick diff.
    vscode.commands.registerCommand(
      "localPrReview.markChangeReviewed",
      async (uri: vscode.Uri, changes: any[], index: number) => {
        if (!uri || !changes?.[index]) {
          return;
        }
        const filePath = vscode.workspace.asRelativePath(uri, false);
        const line =
          changes[index].modifiedStartLineNumber ??
          changes[index].originalStartLineNumber ??
          1;
        await changedFilesProvider.markHunkAtLine(filePath, line);
        await refreshNow();
      },
    ),
    // "Mark hunk reviewed" acting on the hunk at the cursor in the active editor —
    // the reliable per-hunk control for the side-by-side review diff (title-bar
    // button + right-click + keybinding). VS Code won't let us hang an action on a
    // custom diff's hunks, so we mark the hunk at the cursor line of the working
    // (right) pane instead.
    vscode.commands.registerCommand(
      "localPrReview.markReviewedAtCursor",
      async () => {
        const ed = vscode.window.activeTextEditor;
        if (!ed) {
          return;
        }
        const uri = ed.document.uri;
        const sel = ed.selection;
        let filePath: string;
        let side: "new" | "old";
        if (uri.scheme === "file") {
          filePath = vscode.workspace.asRelativePath(uri, false);
          if (!changedFilesProvider.getAllFilePaths().includes(filePath)) {
            return;
          }
          side = "new";
        } else if (
          uri.scheme === "git-local-review" &&
          new URLSearchParams(uri.query).get("snapshot")
        ) {
          // Left (reviewed) pane of the review diff — needed to reach a pure
          // deletion, whose removed lines exist only here.
          filePath = uri.path.startsWith("/") ? uri.path.slice(1) : uri.path;
          side = "old";
        } else {
          return;
        }
        // Empty selection → the hunk at the cursor; a multi-line selection → every
        // hunk it touches (select-all = the whole file).
        if (sel.isEmpty) {
          await changedFilesProvider.markHunkAtLine(
            filePath,
            sel.active.line + 1,
            side,
          );
        } else {
          await changedFilesProvider.markHunksInRange(
            filePath,
            sel.start.line + 1,
            sel.end.line + 1,
            side,
          );
        }
        await refreshNow();
        // Mark-and-advance: jump the cursor to the next change so you can sweep
        // straight down the file. Only for a single-hunk mark (a range was a
        // deliberate multi-hunk pick). Best-effort — no-op if there's no next.
        if (sel.isEmpty) {
          await vscode.commands.executeCommand(
            "workbench.action.compareEditor.nextChange",
          );
        }
      },
    ),
    // Same shortcut from the Changed Files panel: mark the selected file(s) fully
    // reviewed (= checking their box). Keyed on the tree focus, so it doesn't clash
    // with the editor's per-hunk variant above.
    vscode.commands.registerCommand(
      "localPrReview.markSelectedFileReviewed",
      async () => {
        const items = changedFilesTreeView.selection.filter(
          (i): i is FileChangeItem => i instanceof FileChangeItem,
        );
        if (items.length === 0) {
          return;
        }
        for (const item of items) {
          await changedFilesProvider.setFileReviewed(
            item.fileChange.filePath,
            true,
          );
        }
        await refreshNow();
      },
    ),
    // Clear every reviewed mark in one go (button on the Reviewed section). Modal
    // confirm since re-reviewing files one by one would be tedious to redo.
    vscode.commands.registerCommand("localPrReview.unreviewAll", async () => {
      const n = changedFilesProvider.reviewedCount();
      if (n === 0) {
        return;
      }
      const ok = await vscode.window.showWarningMessage(
        `Unmark all ${n} reviewed file${n === 1 ? "" : "s"}?`,
        { modal: true },
        "Unmark all",
      );
      if (ok !== "Unmark all") {
        return;
      }
      changedFilesProvider.unreviewAll();
      fileDecorationProvider.refresh();
    }),
    // Mark every not-yet-reviewed file reviewed in one go (button on the To Review
    // section). Modal confirm to match its sibling — it sweeps the whole to-review
    // list (reversible via "Unmark all reviewed").
    vscode.commands.registerCommand("localPrReview.reviewAll", async () => {
      const n = changedFilesProvider.toReviewCount();
      if (n === 0) {
        return;
      }
      const ok = await vscode.window.showWarningMessage(
        `Mark all ${n} file${n === 1 ? "" : "s"} as reviewed?`,
        { modal: true },
        "Mark all reviewed",
      );
      if (ok !== "Mark all reviewed") {
        return;
      }
      await changedFilesProvider.reviewAll();
      await refreshNow();
    }),
    // Fully reset one file's review (the $(discard) button on Reviewed-section rows).
    // Drops membership AND the watermark, so a file that went partial after an edit
    // leaves Reviewed and re-reviews from scratch (full base ↔ working diff).
    vscode.commands.registerCommand(
      "localPrReview.markFileNotReviewed",
      async (item: FileChangeItem) => {
        if (!item?.fileChange) {
          return;
        }
        await changedFilesProvider.setFileReviewed(
          item.fileChange.filePath,
          false,
        );
        await refreshNow();
      },
    ),
  );

  // Pick the base this branch is diffed against. Defaults to auto-detect (merge-base
  // vs the train); pointing it at a parent branch fixes the stacked-branch case where
  // the train base would surface the parent's files as "to review".
  context.subscriptions.push(
    vscode.commands.registerCommand("localPrReview.setReviewBase", async () => {
      if (!localPrManager.getActiveReview()) {
        vscode.window.showInformationMessage(
          "Local Review: no active review yet.",
        );
        return;
      }
      const current = localPrManager.getBaseOverride();
      const [branches, currentBranch] = await Promise.all([
        gitService.getBranches(true),
        gitService.getCurrentBranch(),
      ]);
      const AUTO = "$(sparkle) Auto (merge-base vs train)";
      const CUSTOM = "$(edit) Enter a ref manually…";
      const tag = (cond: boolean) => (cond ? "current" : undefined);
      const items: vscode.QuickPickItem[] = [
        { label: AUTO, description: tag(!current) },
        { label: "", kind: vscode.QuickPickItemKind.Separator },
        ...branches
          .filter((b) => b !== currentBranch)
          .map((b) => ({ label: b, description: tag(b === current) })),
        { label: "", kind: vscode.QuickPickItemKind.Separator },
        { label: CUSTOM },
      ];
      const picked = await vscode.window.showQuickPick(items, {
        placeHolder: "Base to diff this branch against",
      });
      if (!picked) {
        return;
      }

      let next: string | undefined;
      if (picked.label === AUTO) {
        next = undefined;
      } else if (picked.label === CUSTOM) {
        const entered = await vscode.window.showInputBox({
          prompt:
            "Base ref (branch, tag, or commit) to diff against — empty to auto-detect",
          value: current ?? "",
        });
        if (entered === undefined) {
          return;
        } // cancelled
        next = entered.trim() || undefined;
      } else {
        next = picked.label;
      }

      localPrManager.setBaseOverride(next);
      await refreshNow();
    }),
  );

  // Open file (working copy)
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "localPrReview.openFile",
      async (item: FileChangeItem) => {
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri;
        if (workspaceRoot) {
          const fileUri = vscode.Uri.joinPath(
            workspaceRoot,
            item.fileChange.filePath,
          );
          await vscode.window.showTextDocument(fileUri);
        }
      },
    ),
  );

  // Open diff
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "localPrReview.openDiff",
      async (item: FileChangeItem) => {
        await openDiffForItem(item);
      },
    ),
    // Clicking a file in the "Local Review" Source Control list (resource state).
    vscode.commands.registerCommand(
      "localPrReview.openReviewDiff",
      async (filePath: string) => {
        const item = changedFilesProvider.findFileItem(filePath);
        if (item) {
          await openDiffForItem(item);
        }
      },
    ),
  );

  // Jump to a comment from the Comments navigator: open the file's diff for the
  // current mode and scroll to the comment, rather than the bare working file.
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "localPrReview.openCommentInDiff",
      async (arg: {
        filePath: string;
        startLine: number;
        before?: boolean;
        anchor?: string;
      }) => {
        const item = changedFilesProvider.findFileItem(arg.filePath);
        if (item) {
          // Reveal the stored line on the right pane first (the fallback), then —
          // since placement is content-addressed across both panes now — if the
          // anchor code sits on a before/left pane, scroll there instead.
          await openDiffForItem(item, arg.startLine);
          if (arg.anchor) {
            const anchor = arg.anchor;
            if (!(await commentController.revealBeforeAnchor(anchor))) {
              setTimeout(() => {
                void commentController.revealBeforeAnchor(anchor);
              }, 200);
            }
          }
          return;
        }
        // Not in the current change set (e.g. committed while in the
        // uncommitted view) — fall back to the working file at the line.
        const workspaceUri = vscode.workspace.workspaceFolders?.[0]?.uri;
        if (workspaceUri) {
          const fileUri = vscode.Uri.joinPath(workspaceUri, arg.filePath);
          const pos = new vscode.Position(arg.startLine, 0);
          await vscode.window.showTextDocument(fileUri, {
            selection: new vscode.Range(pos, pos),
          });
        }
      },
    ),
  );

  // Comment commands
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "localPrReview.addComment",
      (reply: vscode.CommentReply) => {
        try {
          const thread = reply.thread;
          const filePath = extractFilePath(thread.uri);

          if (thread.comments.length === 0) {
            commentController.createThread(
              thread.uri,
              thread.range!,
              reply.text,
              filePath,
              thread,
            );
          } else {
            commentController.addReply(thread, reply.text);
          }
          localCommentsProvider.refresh();
          fileDecorationProvider.refresh();
          changedFilesProvider.fireChange();
        } catch (err: any) {
          vscode.window.showErrorMessage(
            `Failed to add comment: ${err.message}`,
          );
        }
      },
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "localPrReview.saveComment",
      (reply: vscode.CommentReply) => {
        try {
          const thread = reply.thread;
          const filePath = extractFilePath(thread.uri);

          if (thread.comments.length === 0) {
            commentController.createThread(
              thread.uri,
              thread.range!,
              reply.text,
              filePath,
              thread,
            );
          } else {
            commentController.addReply(thread, reply.text);
          }
          localCommentsProvider.refresh();
          fileDecorationProvider.refresh();
          changedFilesProvider.fireChange();
        } catch (err: any) {
          vscode.window.showErrorMessage(
            `Failed to save comment: ${err.message}`,
          );
        }
      },
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "localPrReview.cancelComment",
      (reply: vscode.CommentReply) => {
        if (reply.thread.comments.length === 0) {
          reply.thread.dispose();
        }
      },
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "localPrReview.resolveThread",
      (thread: vscode.CommentThread) => {
        if (thread.state === vscode.CommentThreadState.Unresolved) {
          commentController.resolveThread(thread);
        } else {
          commentController.unresolveThread(thread);
        }
        localCommentsProvider.refresh();
        fileDecorationProvider.refresh();
        changedFilesProvider.fireChange();
      },
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "localPrReview.unresolveThread",
      (thread: vscode.CommentThread) => {
        commentController.unresolveThread(thread);
        localCommentsProvider.refresh();
        fileDecorationProvider.refresh();
        changedFilesProvider.fireChange();
      },
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "localPrReview.acceptThread",
      (thread: vscode.CommentThread) => {
        commentController.acceptThread(thread);
        localCommentsProvider.refresh();
        changedFilesProvider.fireChange();
      },
    ),
  );

  // "Ignore" a proposal: leave a "skipping this" note and resolve it (collapses +
  // excluded from applying). A distinct verb+icon from your own "Resolve".
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "localPrReview.dismissThread",
      (thread: vscode.CommentThread) => {
        commentController.ignoreThread(thread);
        localCommentsProvider.refresh();
        fileDecorationProvider.refresh();
        changedFilesProvider.fireChange();
      },
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "localPrReview.unacceptThread",
      (thread: vscode.CommentThread) => {
        commentController.unacceptThread(thread);
        localCommentsProvider.refresh();
        changedFilesProvider.fireChange();
      },
    ),
  );

  // "Skip always" — mute a not-your-own thread: it leaves the triage queue + the
  // needs-OK count but stays unresolved and untouched on GitHub (e.g. a note you
  // left for reviewers). "Restore" un-mutes it back to the queue.
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "localPrReview.skipAlways",
      (thread: vscode.CommentThread) => {
        commentController.muteThread(thread);
        localCommentsProvider.refresh();
        fileDecorationProvider.refresh();
        changedFilesProvider.fireChange();
      },
    ),
    vscode.commands.registerCommand(
      "localPrReview.restoreThread",
      (thread: vscode.CommentThread) => {
        commentController.unmuteThread(thread);
        localCommentsProvider.refresh();
        fileDecorationProvider.refresh();
        changedFilesProvider.fireChange();
      },
    ),
  );

  // Picker-primary triage: walk the "needs your OK" queue one finding at a time.
  context.subscriptions.push(
    vscode.commands.registerCommand("localPrReview.triage", async () => {
      const refreshViews = () => {
        localCommentsProvider.refresh();
        fileDecorationProvider.refresh();
        changedFilesProvider.fireChange();
      };
      await runTriage(
        storageService,
        commentController,
        refreshViews,
        os.userInfo().username,
      );
    }),
  );

  // Resolve / Reply / Unresolve directly from the Comments navigator — acts by
  // thread id, so it reaches a comment that has NO inline widget (its code was
  // committed/rebased away) and an applied team/codex thread (which otherwise
  // shows only "Undo queue").
  const refreshNavViews = () => {
    localCommentsProvider.refresh();
    fileDecorationProvider.refresh();
    changedFilesProvider.fireChange();
  };
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "localPrReview.resolveComment",
      (item: CommentNavItem) => {
        if (!item?.threadId) {
          return;
        }
        commentController.resolveThreadById(item.threadId);
        refreshNavViews();
      },
    ),
    vscode.commands.registerCommand(
      "localPrReview.unresolveComment",
      (item: CommentNavItem) => {
        if (!item?.threadId) {
          return;
        }
        commentController.unresolveThreadById(item.threadId);
        refreshNavViews();
      },
    ),
    vscode.commands.registerCommand(
      "localPrReview.replyComment",
      async (item: CommentNavItem) => {
        if (!item?.threadId) {
          return;
        }
        const text = await vscode.window.showInputBox({
          prompt: "Reply — private to you + Claude, never posted to GitHub",
          placeHolder: "e.g. done, or: actually also rename the helper",
          ignoreFocusOut: true,
        });
        if (text && text.trim()) {
          commentController.replyToThreadById(item.threadId, text.trim());
          refreshNavViews();
        }
      },
    ),
    vscode.commands.registerCommand(
      "localPrReview.muteComment",
      (item: CommentNavItem) => {
        if (!item?.threadId) {
          return;
        }
        commentController.muteThreadById(item.threadId);
        refreshNavViews();
      },
    ),
    vscode.commands.registerCommand(
      "localPrReview.unmuteComment",
      (item: CommentNavItem) => {
        if (!item?.threadId) {
          return;
        }
        commentController.unmuteThreadById(item.threadId);
        refreshNavViews();
      },
    ),
  );

  // "Review comments": walk every open comment one at a time (Resolve / Reply /
  // Skip) — the keyboard navigation for your own + applied threads, distinct from
  // Triage (which queues not-yours proposals).
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "localPrReview.reviewComments",
      async () => {
        await runReview(
          storageService,
          commentController,
          refreshNavViews,
          os.userInfo().username,
        );
      },
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "localPrReview.editComment",
      (comment: vscode.Comment) => {
        commentController.startEdit(comment);
      },
    ),
    vscode.commands.registerCommand(
      "localPrReview.saveEdit",
      (comment: vscode.Comment) => {
        commentController.saveEdit(comment);
        localCommentsProvider.refresh();
        fileDecorationProvider.refresh();
        changedFilesProvider.fireChange();
      },
    ),
    vscode.commands.registerCommand(
      "localPrReview.cancelEdit",
      (comment: vscode.Comment) => {
        commentController.cancelEdit(comment);
      },
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "localPrReview.deleteComment",
      (comment: vscode.Comment & { thread?: vscode.CommentThread }) => {
        // For comments/comment/title, VS Code may pass comment with parent reference
        // We need to find the thread from our controller
        const thread =
          comment.thread || commentController.findThreadForComment(comment);
        if (!thread) {
          return;
        }

        vscode.window
          .showWarningMessage("Delete this comment?", { modal: true }, "Delete")
          .then((answer) => {
            if (answer === "Delete") {
              commentController.deleteComment(thread, comment);
              localCommentsProvider.refresh();
              fileDecorationProvider.refresh();
              changedFilesProvider.fireChange();
            }
          });
      },
    ),
  );

  // Refresh commands for Local PRs and Local Comments
  context.subscriptions.push(
    vscode.commands.registerCommand("localPrReview.refreshPrs", () => {
      localPrsProvider.refresh();
    }),
    vscode.commands.registerCommand("localPrReview.refreshComments", () => {
      localCommentsProvider.refresh();
    }),
  );

  // Open all changed files in a multi-diff editor
  context.subscriptions.push(
    vscode.commands.registerCommand("localPrReview.openAllDiffs", async () => {
      const allFiles = changedFilesProvider.getAllFileItems();
      if (allFiles.length === 0) {
        vscode.window.showInformationMessage(
          "No changed files to show. Select branches first.",
        );
        return;
      }

      const resources = allFiles.map((item) => {
        const { left, right } = computeDiffUris(item);
        return [left, right, undefined] as [vscode.Uri, vscode.Uri, undefined];
      });

      try {
        await vscode.commands.executeCommand(
          "vscode.changes",
          "Review: branch vs base",
          resources,
        );
      } catch (err: any) {
        const msg = err?.message ?? String(err);
        vscode.window.showErrorMessage(`Multi-diff editor failed: ${msg}`);
      }
    }),
  );

  // Suggest a Change — compose a diff suggestion as an inline comment
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "localPrReview.suggestChange",
      async (reply: vscode.CommentReply) => {
        try {
          const thread = reply.thread;
          const range = thread.range;
          if (!range) {
            vscode.window.showWarningMessage(
              "Please select a line range in the diff to suggest a change.",
            );
            return;
          }
          const doc = await vscode.workspace.openTextDocument(thread.uri);
          const filePath = extractFilePath(thread.uri);

          // Get the full lines covered by the selection
          const normalizedRange = new vscode.Range(
            range.start.line,
            0,
            range.end.line,
            doc.lineAt(range.end.line).text.length,
          );
          const originalCode = doc.getText(normalizedRange);

          const commentBody = await SuggestChangePanel.show(
            context.extensionUri,
            originalCode,
            filePath,
          );

          if (commentBody === undefined) {
            // User cancelled — dispose empty thread
            if (thread.comments.length === 0) {
              thread.dispose();
            }
            return;
          }

          if (thread.comments.length === 0) {
            commentController.createThread(
              thread.uri,
              range,
              commentBody,
              filePath,
            );
            thread.dispose();
          } else {
            commentController.addReply(thread, commentBody);
          }
          localCommentsProvider.refresh();
          fileDecorationProvider.refresh();
          changedFilesProvider.fireChange();
        } catch (err: any) {
          vscode.window.showErrorMessage(
            `Failed to add suggestion: ${err.message}`,
          );
        }
      },
    ),
  );

  // Disposables
  context.subscriptions.push(
    changedFilesProvider,
    localPrsProvider,
    localCommentsProvider,
    commentController,
    gitFileContentProvider,
    fileDecorationProvider,
    { dispose: () => localPrManager.dispose() },
  );
}

function extractFilePath(uri: vscode.Uri): string {
  if (uri.scheme === "file") {
    return vscode.workspace.asRelativePath(uri, false);
  }
  // VS Code's `git:` document (native diff index/HEAD pane): its path is the
  // absolute fs path, so resolve it relative to the workspace.
  if (uri.scheme === "git") {
    return vscode.workspace.asRelativePath(vscode.Uri.file(uri.path), false);
  }
  const path = uri.path;
  return path.startsWith("/") ? path.slice(1) : path;
}

export function deactivate() {}
