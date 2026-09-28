import type { GitService } from '../git/GitService';
import type { Repository } from '../git/types';

const TYPES = ['feat', 'fix', 'refactor', 'perf', 'docs', 'test', 'style', 'chore'] as const;
type CommitType = typeof TYPES[number];

export interface CommitCandidate {
  label: string;
  description: string;
}

interface StagedPath {
  status: string;
  path: string;
}

export interface GitScmRepository {
  rootUri: { fsPath: string };
  inputBox: { value: string };
}

export function findGitRepositoryByRoot<T extends GitScmRepository>(repositories: readonly T[], root: string): T | undefined {
  return repositories.find((repository) => samePath(repository.rootUri.fsPath, root));
}

export function generateCommitCandidates(
  staged: string,
  conventional: boolean,
  defaultType: string,
): CommitCandidate[] {
  const entries = staged.split('\0').filter(Boolean);
  const changes: StagedPath[] = [];
  for (let i = 0; i < entries.length;) {
    const status = entries[i++];
    if (/^[RC]/.test(status)) i++;
    if (i < entries.length) changes.push({ status, path: entries[i++] });
  }
  if (!changes.length) return [];

  const segments = changes.map(({ path }) => path.split('/'));
  const names = segments.map((parts) => commitWord(parts.at(-1) ?? ''));
  const directories = segments.map((parts) => parts.slice(0, -1));
  let commonDirectory = '';
  for (let index = 0; directories.every((parts) => parts[index] && parts[index] === directories[0][index]); index++) {
    commonDirectory = directories[0][index];
  }
  const scope = conventionalScope(commitWord(commonDirectory));
  const target = (names.length === 1 ? names[0] : commitWord(commonDirectory) || `${names.length} files`) || 'staged files';
  const statuses = changes.map(({ status }) => status[0]);
  const verb = statuses.every((status) => status === 'A') ? 'add'
    : statuses.every((status) => status === 'D') ? 'remove'
      : statuses.every((status) => status === 'R') ? 'rename'
        : 'update';
  const subject = `${verb} ${target || 'staged files'}`;
  if (!conventional) {
    return [`Update ${target}`, `Change ${target}`, `Improve ${target}`]
      .map((label) => ({ label, description: 'Commit message' }));
  }
  const preferredType = TYPES.includes(defaultType as CommitType) ? defaultType : 'chore';
  const ordered = [preferredType, ...TYPES].filter((type, index, all) =>
    TYPES.includes(type as CommitType) && all.indexOf(type) === index,
  );
  return ordered.map((type) => ({
    label: `${type}${scope ? `(${scope})` : ''}: ${subject}`.trim(),
    description: `Conventional Commit · ${type}`,
  }));
}

export async function generateCommitMessage(git: GitService, repo: Repository): Promise<void> {
  const vscode = await import('vscode');
  const gitExtension = vscode.extensions.getExtension<{ getAPI(version: number): {
    repositories: Array<{ rootUri: { fsPath: string }; inputBox: { value: string } }>;
  } }>('vscode.git');
  if (!gitExtension) {
    void vscode.window.showErrorMessage('GitPeek: The built-in Git extension is unavailable.');
    return;
  }

  const api = gitExtension.isActive ? gitExtension.exports.getAPI(1) : (await gitExtension.activate()).getAPI(1);
  const repository = findGitRepositoryByRoot(api.repositories, repo.root);
  if (!repository) {
    void vscode.window.showErrorMessage('GitPeek: Could not find this repository in the built-in Git extension.');
    return;
  }

  let staged: string;
  try {
    staged = await git.run(repo, ['diff', '--cached', '--name-status', '-z']);
  } catch (error) {
    void vscode.window.showErrorMessage(`GitPeek: Could not read staged files: ${String(error)}`);
    return;
  }
  if (!staged.trim()) {
    void vscode.window.showInformationMessage('GitPeek: Stage files before generating a commit message.');
    return;
  }

  const config = vscode.workspace.getConfiguration('gitpeek.commit');
  const conventional = config.get<boolean>('conventional', true);
  const defaultType = config.get<string>('defaultType', 'chore');
  const candidates = generateCommitCandidates(staged, conventional, defaultType);
  if (!candidates.length) {
    void vscode.window.showInformationMessage('GitPeek: Stage files before generating a commit message.');
    return;
  }
  const selected = await vscode.window.showQuickPick(candidates, {
    placeHolder: 'Choose a commit message for the staged files',
    title: `GitPeek: Generate Commit Message · ${repo.root}`,
  });
  if (!selected) return;

  if (repository.inputBox.value.trim()) {
    const replace = await vscode.window.showWarningMessage(
      'The SCM commit message already contains a draft. Replace it?',
      { modal: true },
      'Replace',
    );
    if (replace !== 'Replace') return;
  }
  repository.inputBox.value = selected.label;
}

function commitWord(value: string): string {
  const clean = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  const extension = clean.lastIndexOf('.');
  return extension > 0 ? clean.slice(0, extension) : clean;
}

function conventionalScope(value: string): string {
  return value.replace(/[^\p{L}\p{N}._-]+/gu, '-').replace(/^-+|-+$/g, '');
}

function samePath(left: string, right: string): boolean {
  const normalize = (path: string) => {
    const normalized = path.replace(/[\\/]+$/, '').replaceAll('\\', '/');
    return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
  };
  return normalize(left) === normalize(right);
}
