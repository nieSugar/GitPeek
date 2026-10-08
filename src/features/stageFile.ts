import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { GitService } from '../git/GitService';
import type { Repository } from '../git/types';
import { loadReviewSnapshot, type ReviewFile } from './reviewChangesData';

export async function updateFileStage(git: GitService, repo: Repository, selected: ReviewFile, stage: boolean,
  verifyCurrent: () => void | Promise<void> = () => {}): Promise<void> {
  if (stage === (selected.section === 'staged')) throw new Error('文件分组已变化，请刷新更改列表。');
  const snapshot = await loadReviewSnapshot(git, repo);
  const file = snapshot.groups.find(group => group.section === selected.section)?.files.find(file => file.path === selected.path);
  if (!file || file.oldPath !== selected.oldPath || file.status !== selected.status) throw new Error('文件状态已变化，请刷新后重试。');
  const paths = [...new Set([file.path, ...(file.oldPath ? [file.oldPath] : [])])];
  for (const filePath of paths) {
    const rel = relative(repo.root, resolve(repo.root, filePath));
    if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('文件路径不在仓库中。');
  }
  const literals = paths.map(file => `:(literal)${file}`);
  if (await git.run(repo, ['ls-files', '--unmerged', '-z', '--', ...literals])) throw new Error('此文件存在未解决的冲突，请先在源代码管理中解决。');
  if (stage) {
    await verifyCurrent();
    await git.run(repo, ['add', '--', ...literals]);
  }
  else {
    let head = '';
    try { head = (await git.run(repo, ['rev-parse', '--verify', '--quiet', 'HEAD'])).trim(); }
    catch (error) { if ((error as Error & { cause?: { code?: number } }).cause?.code !== 1) throw error; }
    await verifyCurrent();
    if (head) await git.run(repo, ['reset', head, '--', ...literals]);
    else await git.run(repo, ['rm', '--cached', '-f', '--', ...literals]);
  }
}
