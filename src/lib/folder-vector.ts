import { platform } from "@/lib/platform";
import { collectMarkdownFilesWithReport } from "@/lib/files";
import { getFilePathOptions, getWorkspacePath } from "@/lib/workspace";
import { checkEmbeddingModelAvailable, processMarkdownFile } from "@/lib/rag";
import { getKnowledgeSettings } from '@/lib/knowledge-settings'

export type FolderVectorMode = 'missing' | 'recalculate';

interface CalculateFolderVectorsOptions {
  folderPath: string;
  mode: FolderVectorMode;
  checkFileVectorIndexed?: (filePath: string) => Promise<boolean>;
  setVectorCalcStatus?: (path: string, status: 'idle' | 'calculating' | 'completed') => void;
  onProgress?: (progress: {
    total: number;
    processed: number;
    failed: number;
    currentFile: string;
  }) => void;
}

interface CalculateFolderVectorsResult {
  total: number;
  success: number;
  failed: number;
  skipped: number;
  /** Subfolders that could not be read during collection (F-08). */
  unreadableDirs: number;
  embeddingModelAvailable: boolean;
  semanticSearchEnabled: boolean;
}

export async function calculateFolderVectors({
  folderPath,
  mode,
  checkFileVectorIndexed,
  setVectorCalcStatus,
  onProgress,
}: CalculateFolderVectorsOptions): Promise<CalculateFolderVectorsResult> {
  const initialWorkspace = await getWorkspacePath();
  const workspaceIsCurrent = async () => {
    const current = await getWorkspacePath();
    return current.path === initialWorkspace.path && current.isCustom === initialWorkspace.isCustom;
  };
  const assertWorkspace = async () => {
    if (!await workspaceIsCurrent()) throw new Error('WIKI_CONTEXT_CHANGED');
  };
  if (!(await getKnowledgeSettings()).semanticSearchEnabled) {
    return { total: 0, success: 0, failed: 0, skipped: 0, unreadableDirs: 0, embeddingModelAvailable: true, semanticSearchEnabled: false }
  }
  const { files: markdownFiles, failedDirs } = await collectMarkdownFilesWithReport(folderPath);
  await assertWorkspace();

  if (markdownFiles.length === 0) {
    return {
      total: 0,
      success: 0,
      failed: 0,
      skipped: 0,
      unreadableDirs: failedDirs.length,
      embeddingModelAvailable: true,
      semanticSearchEnabled: true,
    };
  }

  const embeddingModelAvailable = await checkEmbeddingModelAvailable();
  await assertWorkspace();
  if (!embeddingModelAvailable) {
    return {
      total: markdownFiles.length,
      success: 0,
      failed: 0,
      skipped: 0,
      unreadableDirs: failedDirs.length,
      embeddingModelAvailable: false,
      semanticSearchEnabled: true,
    };
  }

  let success = 0;
  let failed = 0;
  let skipped = 0;
  let processed = 0;
  let semanticSearchEnabled = true;

  for (const file of markdownFiles) {
    await assertWorkspace();
    if (!(await getKnowledgeSettings()).semanticSearchEnabled) {
      semanticSearchEnabled = false;
      break;
    }
    try {
      const hasVector = checkFileVectorIndexed
        ? await checkFileVectorIndexed(file.path)
        : false;
      await assertWorkspace();

      if (mode === 'missing' && hasVector) {
        skipped++;
        continue;
      }

      setVectorCalcStatus?.(file.path, 'calculating');

      const pathOptions = await getFilePathOptions(file.path);
      await assertWorkspace();
      const fileExists = pathOptions.baseDir
        ? await platform.fs.exists(pathOptions.path, { baseDir: pathOptions.baseDir })
        : await platform.fs.exists(pathOptions.path);
      await assertWorkspace();

      if (!fileExists) {
        setVectorCalcStatus?.(file.path, 'idle');
        failed++;
        continue;
      }

      const content = pathOptions.baseDir
        ? await platform.fs.readTextFile(pathOptions.path, { baseDir: pathOptions.baseDir })
        : await platform.fs.readTextFile(pathOptions.path);
      await assertWorkspace();

      const successResult = await processMarkdownFile(file.path, content);
      await assertWorkspace();
      if (!successResult) {
        setVectorCalcStatus?.(file.path, 'idle');
        failed++;
      } else {
        setVectorCalcStatus?.(file.path, 'completed');
        success++;
      }
    } catch (error) {
      await assertWorkspace();
      console.error(`计算文件 ${file.name} 向量失败:`, error);
      setVectorCalcStatus?.(file.path, 'idle');
      failed++;
    } finally {
      processed++;
      if (await workspaceIsCurrent()) onProgress?.({
        total: markdownFiles.length,
        processed,
        failed,
        currentFile: file.name,
      });
    }
  }

  return {
    total: markdownFiles.length,
    success,
    failed,
    skipped,
    unreadableDirs: failedDirs.length,
    embeddingModelAvailable: true,
    semanticSearchEnabled,
  };
}
