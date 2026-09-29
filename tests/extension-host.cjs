// Invoke run() from a VS Code Extension Host test in an isolated profile.
const path = require('node:path');

const PUBLIC_COMMANDS = [
  'gitpeek.fileHistory',
  'gitpeek.showCommitGraph',
  'gitpeek.stash',
  'gitpeek.blameCurrentLine',
  'gitpeek.selectionOrigins',
  'gitpeek.compareWithBase',
  'gitpeek.showBranchChanges',
  'gitpeek.reviewChanges',
  'gitpeek.generateCommitMessage',
  'gitpeek.refresh',
];
const REPOSITORY_SCAN_TIMEOUT_MS = 10_000;

module.exports.run = async function run(options = {}) {
  const vscode = options.vscode || require('vscode');
  const extension = vscode.extensions.getExtension('gitpeek.gitpeek');
  if (!extension) throw new Error('GitPeek extension gitpeek.gitpeek is not installed in this Extension Host.');
  await extension.activate();
  if (!extension.isActive) throw new Error('GitPeek did not become active.');

  const commands = new Set(await vscode.commands.getCommands(true));
  const missingCommands = PUBLIC_COMMANDS.filter((command) => !commands.has(command));
  if (missingCommands.length) throw new Error(`GitPeek commands are missing: ${missingCommands.join(', ')}`);

  const gitExtension = vscode.extensions.getExtension('vscode.git');
  if (!gitExtension) throw new Error('The built-in Git extension is unavailable.');
  const gitExports = gitExtension.isActive ? gitExtension.exports : await gitExtension.activate();
  const api = gitExports.getAPI(1);
  const workspaceRoots = (vscode.workspace.workspaceFolders || []).map((folder) => folder.uri.fsPath);
  if (!workspaceRoots.length) throw new Error('Open a Git workspace before running the Extension Host probe.');

  const expectedRoots = options.expectedRoots || [];
  const requiredRoots = expectedRoots.length ? expectedRoots : workspaceRoots;
  const matchesRoot = (root, repository) => expectedRoots.length
    ? samePath(root, repository.rootUri.fsPath)
    : isWithin(root, repository.rootUri.fsPath) || isWithin(repository.rootUri.fsPath, root);
  const started = Date.now();
  let matches = [];
  do {
    matches = api.repositories.filter((repository) => requiredRoots.some((root) => matchesRoot(root, repository)));
    if (requiredRoots.every((root) => matches.some((repository) => matchesRoot(root, repository)))) break;
    if (Date.now() - started >= REPOSITORY_SCAN_TIMEOUT_MS) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  } while (true);

  const missingRoots = requiredRoots.filter((root) => !matches.some((repository) => matchesRoot(root, repository)));
  if (missingRoots.length) throw new Error(`Git API v1 did not scan these Git workspace roots within ${REPOSITORY_SCAN_TIMEOUT_MS} ms: ${missingRoots.join(', ')}`);
  const missingInputs = matches.filter((repository) => !repository.inputBox || typeof repository.inputBox.value !== 'string');
  if (missingInputs.length) {
    throw new Error(`Git API v1 has no SCM inputBox for: ${missingInputs.map((repo) => repo.rootUri.fsPath).join(', ')}`);
  }
  for (const repository of matches) {
    const original = repository.inputBox.value;
    const marker = `gitpeek-host-probe-${Date.now()}`;
    try {
      repository.inputBox.value = marker;
      if (repository.inputBox.value !== marker) throw new Error(`SCM inputBox write failed for ${repository.rootUri.fsPath}`);
    } finally {
      repository.inputBox.value = original;
    }
  }
  if (workspaceRoots.length === 1 && vscode.TabInputWebview) {
    await vscode.commands.executeCommand('gitpeek.showCommitGraph');
    const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    if (!(input instanceof vscode.TabInputWebview) || input.viewType !== 'gitpeek.commitGraph') {
      throw new Error('GitPeek Commit Graph did not open in an editor tab.');
    }
  }

  const summary = {
    extensionActivated: extension.isActive,
    publicCommands: PUBLIC_COMMANDS.length,
    gitApiVersion: 1,
    repositories: matches.map((repository) => ({ root: repository.rootUri.fsPath, inputBoxWriteVerified: true })),
  };
  console.log(`[GitPeek Host Probe] PASS — activated; ${summary.publicCommands} commands registered; Git API v1 SCM write and restore verified for ${matches.length} workspace repository(s).`);
  return summary;
};

function samePath(left, right) {
  const normalize = (value) => {
    const resolved = path.resolve(value).replace(/[\\/]+$/, '').replaceAll('\\', '/');
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  return normalize(left) === normalize(right);
}

function isWithin(parent, candidate) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}
