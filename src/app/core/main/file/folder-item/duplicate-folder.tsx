import { ContextMenuItem, ContextMenuShortcut } from "@/components/ui/enhanced-context-menu";
import { DirTree } from "@/stores/article";
import { computedParentPath } from "@/lib/path";
import { Copy } from "lucide-react"
import { Kbd } from "@/components/ui/kbd"
import { platform } from "@/lib/platform";
import { duplicateFolderTree } from "./duplicate-folder-tree";
import { toast } from "@/hooks/use-toast";
import { useTranslations } from "next-intl";

interface DuplicateFolderProps {
  item: DirTree;
  shortcut?: string;
}

export function DuplicateFolder({ item, shortcut }: DuplicateFolderProps) {
  const t = useTranslations('article.file');
  const path = computedParentPath(item);

  async function handleDuplicateFolder() {
    try {
      const { generateCopyFoldername } = await import('@/lib/default-filename')
      const { getFilePathOptions, getWorkspacePath } = await import('@/lib/workspace')
      const workspace = await getWorkspacePath()

      // 获取父目录路径
      const parentPath = path.includes('/') ? path.split('/').slice(0, -1).join('/') : ''

      // 生成唯一的文件夹名称（带 _copy 后缀）
      const targetName = await generateCopyFoldername(parentPath, item.name)
      const targetPath = parentPath ? `${parentPath}/${targetName}` : targetName

      // 获取源路径和目标路径的选项
      const targetPathOptions = await getFilePathOptions(targetPath)

      // 创建目标文件夹
      if (workspace.isCustom) {
        await platform.fs.mkdir(targetPathOptions.path)
      } else {
        await platform.fs.mkdir(targetPathOptions.path, { baseDir: targetPathOptions.baseDir })
      }

      // DA-2 (F-03): byte-faithful copy on workspace-relative
      // paths with per-entry path options; failures are counted
      // and reported instead of hidden behind a success toast.
      const copyResult = await duplicateFolderTree(
        {
          readDir: (dirPath, options) => platform.fs.readDir(dirPath, options),
          mkdir: (dirPath, options) => platform.fs.mkdir(dirPath, options),
          copyFile: (fromPath, toPath, options) => platform.fs.copyFile(fromPath, toPath, options),
          getFilePathOptions,
        },
        path,
        targetPath,
      )

      // 刷新文件树
      const useArticleStore = (await import('@/stores/article')).default
      useArticleStore.getState().loadFileTree()

      if (copyResult.failed.length > 0) {
        toast({
          title: t('folderCopiedPartial', { targetName, count: copyResult.failed.length }),
          description: copyResult.failed.join(', '),
          variant: 'destructive',
        })
      } else {
        toast({ title: t('folderCopiedAs', { targetName }) })
      }
    } catch (error) {
      console.error('Duplicate folder failed:', error)
      toast({ title: t('copyFolderFailed'), variant: 'destructive' })
    }
  }

  return (
    <ContextMenuItem inset onClick={handleDuplicateFolder} menuType="file">
      <Copy className="mr-2 h-4 w-4" />
      Duplicate
      {shortcut && (
        <ContextMenuShortcut menuType="file">
          <Kbd>{shortcut}</Kbd>
        </ContextMenuShortcut>
      )}
    </ContextMenuItem>
  );
}
