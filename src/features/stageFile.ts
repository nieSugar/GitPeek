import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { GitService } from '../git/GitService';
import type { Repository } from '../git/types';
import { loadReviewSnapshot, type ReviewFile } from './reviewChangesData';

export async function updateFilesStage(git: GitService, repo: Repository, selected: readonly ReviewFile[], stage: boolean,
  verifyCurrent: () => void | Promise<void> = () => {}): Promise<void> {
  if (!Array.isArray(selected) || !selected.length) throw new Error('请先选择要暂存或取消暂存的文件。');
  const items = Array.from(selected, item => {
    if (!item || typeof item.path !== 'string' || !item.path || item.path.includes('\0')
      || item.oldPath !== undefined && (typeof item.oldPath !== 'string' || !item.oldPath || item.oldPath.includes('\0'))
      || !['staged', 'unstaged', 'untracked'].includes(item.section)
      || typeof item.status !== 'string' || !/^[AMDRCTUXB]$/.test(item.status) || typeof stage !== 'boolean') {
      throw new Error('所选文件信息无效，请刷新更改列表。');
    }
    if (stage === (item.section === 'staged')) throw new Error('文件分组已变化，请刷新更改列表。');
    return { path: item.path, oldPath: item.oldPath, status: item.status, section: item.section };
  });
  const snapshot = await loadReviewSnapshot(git, repo);
  const paths = [...new Set(items.flatMap(item => {
    const file = snapshot.groups.find(group => group.section === item.section)?.files.find(file => file.path === item.path);
    if (!file || file.oldPath !== item.oldPath || file.status !== item.status) throw new Error(`文件状态已变化：${item.path}，请刷新后重试。`);
    return [file.path, ...(file.oldPath ? [file.oldPath] : [])];
  }))];
  for (const filePath of paths) {
    const rel = relative(repo.root, resolve(repo.root, filePath));
    if (isAbsolute(filePath) || !rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('文件路径不在仓库中。');
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

export async function updateFileStage(git: GitService, repo: Repository, selected: ReviewFile, stage: boolean,
  verifyCurrent: () => void | Promise<void> = () => {}): Promise<void> {
  await updateFilesStage(git, repo, [selected], stage, verifyCurrent);
}
