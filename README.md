# GitPeek

**GitPeek is a lightweight, context-first Git extension for VS Code.** Understand the code you are looking at without navigating complex Git interfaces. See who changed a line, inspect file history, understand branch changes, trace selected code to its commits, and review your work before committing.

GitPeek 是一个轻量、Context-first 的 VS Code Git 插件。不必切换到复杂的 Git 页面，也能查看当前代码的修改来源、文件历史、分支差异和提交前改动。

## Features

- **Current Line Blame** — See the author, date, and commit summary for the line at the cursor.
- **File History** — Browse a file's recent commits, including rename history, with Load More pagination.
- **Commit Details and Diff** — Inspect changed files and open text diffs in VS Code. Binary files are represented by metadata; their contents are not rendered as text.
- **Branch vs Base** — Review ahead/behind counts, branch commits, changed files, and diffs against a base branch.
- **Selection Origins** — Group selected lines by commit and count their lines. Uncommitted lines appear separately and do not open commit history.
- **Review Changes** — Review staged, unstaged, and untracked files, line counts, and reminders for items such as `console.log`, `debugger`, `TODO`, `FIXME`, `.env`, and `*.pem`.
- **Smart Commit Message** — Generate commit message candidates from staged file names and statuses, then choose one for the repository's SCM input. It does not use AI or inspect the full diff to infer intent.

The GitPeek sidebar contains Repository, Changes, Branch Changes, and File History views. File-specific commands use the repository containing the active file. Smart Commit matches the built-in Git SCM repository by root, which supports multi-root workspaces.

## Commands

Open the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`) to run:

| Command | Purpose |
| --- | --- |
| `GitPeek: File History` | Show history for the active file |
| `GitPeek: Blame Current Line` | Refresh blame for the current line |
| `GitPeek: Selection Origins` | Show commits behind the selected lines |
| `GitPeek: Compare with Base` | Compare the current branch with its base |
| `GitPeek: Show Branch Changes` | Review branch commits and changed files |
| `GitPeek: Review Changes` | Inspect staged, unstaged, and untracked changes |
| `GitPeek: Generate Commit Message` | Generate candidates from staged files |
| `GitPeek: Refresh` | Refresh GitPeek views and cached data |

File History and Compare with Base are also available from the editor title bar. Selection Origins is available from the editor context menu when text is selected.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `gitpeek.enabled` | `true` | Enable GitPeek features. |
| `gitpeek.blame.enabled` | `true` | Enable current-line blame. |
| `gitpeek.blame.delay` | `300` | Delay before resolving current-line blame, in milliseconds. |
| `gitpeek.history.limit` | `20` | Initial number of file history entries. |
| `gitpeek.baseBranch` | `"auto"` | Base branch for comparisons, or a branch name. |
| `gitpeek.commit.conventional` | `true` | Format Smart Commit candidates as Conventional Commits. |
| `gitpeek.commit.defaultType` | `"chore"` | Preferred type: `feat`, `fix`, `refactor`, `perf`, `docs`, `test`, `style`, or `chore`. |

## Requirements

- VS Code **1.96.0 or later**.
- A system Git installation available on `PATH`.
- The built-in VS Code Git extension enabled for SCM integration.

## Build and install a local VSIX

From the repository root, install the development dependencies and build the package:

```sh
npm install
npm run check
npm test
npm run package
```

Install the generated VSIX in VS Code:

```sh
code --install-extension gitpeek-0.1.0.vsix
```

You can also use **Extensions: Install from VSIX...** in VS Code and select the generated file.

## Scope and limitations

GitPeek focuses on code context. Git Graph, pull request and GitHub integrations, AI chat, stash management, and interactive rebase are outside the v0.1.0 MVP. Smart Commit suggests wording from staged paths and statuses, so review the message before committing. Binary diffs show metadata rather than file contents.
