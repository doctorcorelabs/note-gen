'use client'
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogFooter,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
  ResponsiveDialogTrigger,
} from "@/components/responsive-dialog"
import { ResponsiveSelect } from "@/components/responsive-select"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { extractTitle } from "@/lib/markdown"
import { getFilePathOptions, getWorkspacePath, getGenericPathOptions } from "@/lib/workspace"
import useTagStore from "@/stores/tag"
import { platform, BaseDirectory } from "@/lib/platform"
import { isAlreadyExistsLike } from "@/app/core/main/editor/markdown/revision-conflict"
import { SquarePen, TriangleAlert } from "lucide-react"
import { useEffect, useState } from "react"
import { useRouter } from 'next/navigation'
import { Chat } from "@/db/chats"
import { useTranslations } from "next-intl"
import { toast } from "@/hooks/use-toast"
import { useUserErrorMessage } from "@/lib/use-user-error-message"
import useArticleStore from "@/stores/article"
import { useIsMobile } from "@/hooks/use-mobile"

type CheckedState = boolean | "indeterminate"

export function NoteOutput({chat}: {chat: Chat}) {
  const { deleteTag, currentTagId } = useTagStore()
  const { loadFileTree } = useArticleStore()
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('')
  const [path, setPath] = useState('/')
  const [folders, setFolders] = useState<string[]>([])
  const [isRemove, setIsRemove] = useState<CheckedState>(true)
  const t = useTranslations('record.chat')
  const userErrorMessage = useUserErrorMessage()
  const router = useRouter()
  const isMobile = useIsMobile()

  async function handleTransform() {
    const content = chat?.content || ''
    // 统一处理：将空格替换下划线，确保本地和远程文件名一致
    const sanitizedTitle = title.replace(/\s+/g, '_')

    // DA-12-11 (DATA2D-2, AD-798): createNew so a colliding name never
    // overwrites an existing note. On collision, fall back to the next
    // available path (`name (1).md`, `name (2).md`, ...) instead of
    // blanking the file that is already there.
    const dot = sanitizedTitle.lastIndexOf('.')
    const stem = dot > 0 ? sanitizedTitle.slice(0, dot) : sanitizedTitle
    const ext = dot > 0 ? sanitizedTitle.slice(dot) : ''
    let finalTitle = sanitizedTitle
    for (let attempt = 0; attempt < 100; attempt++) {
      finalTitle = attempt === 0 ? sanitizedTitle : `${stem} (${attempt})${ext}`
      const writePath = `${path}/${finalTitle}`
      // Use workspace functions instead of directly using BaseDirectory.AppData
      const pathOptions = await getFilePathOptions(writePath)
      try {
        if (pathOptions.baseDir) {
          await platform.fs.writeTextFile(pathOptions.path, content, { baseDir: pathOptions.baseDir, createNew: true })
        } else {
          // Handle custom workspace (direct path, no baseDir)
          await platform.fs.writeTextFile(pathOptions.path, content, { createNew: true })
        }
        break
      } catch (error) {
        if (!isAlreadyExistsLike(error) || attempt === 99) {
          throw error
        }
      }
    }

    const store = await platform.store.load('store.json');
    await store.set('activeFilePath', finalTitle)
    if (isRemove) {
      // DA-2 (TAG-02): await the destructive delete and report
      // failure; the note is already saved, so a failed delete
      // must not cancel navigation, but it must not be silent.
      try {
        await deleteTag(currentTagId)
      } catch (error) {
        const message = userErrorMessage(error)
        if (message) {
          toast({ description: message, variant: 'destructive' })
        }
      }
    }
    setOpen(false)
    await loadFileTree()
    router.push(isMobile ? '/mobile/writing' : '/core/article')
  }

  async function readArticleDir() {
    const workspace = await getWorkspacePath()
    let folders = []
    
    if (workspace.isCustom) {
      const pathOptions = await getGenericPathOptions('', '')
      const dirs = (await platform.fs.readDir(pathOptions.path)).filter(dir => dir.isDirectory).map(dir => `/${dir.name}`)
      folders = dirs
    } else {
      const dirs = (await platform.fs.readDir('article', { baseDir: BaseDirectory.AppData })).filter(dir => dir.isDirectory).map(dir => `/${dir.name}`)
      folders = dirs
    }
    
    setFolders(folders)
  }

  useEffect(() => {
    setIsRemove(chat?.tagId !== 1)
    setTitle(extractTitle(chat?.content || '') + '.md')
    readArticleDir()
  }, [chat])

  return (
    <ResponsiveDialog open={open} onOpenChange={setOpen}>
      <ResponsiveDialogTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className="[&_svg:not([class*='size-'])]:size-3.5"
          aria-label={t('note.convert')}
        >
          <SquarePen />
        </Button>
      </ResponsiveDialogTrigger>
      <ResponsiveDialogContent className="sm:max-w-[525px]">
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>{t('note.convert')}</ResponsiveDialogTitle>
          <ResponsiveDialogDescription>
            {t('note.description')}
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>
        <div className="mt-2 flex flex-col gap-2 px-4 sm:px-0">
          <Label>{t('note.filename')}</Label>
          <div className="flex flex-col gap-2 sm:flex-row">
            <ResponsiveSelect
              title={t('note.selectFolder')}
              value={path}
              onValueChange={setPath}
              className="sm:w-[180px]"
              placeholder={t('note.selectFolder')}
              options={[
                { value: '/', label: t('note.rootDirectory') },
                ...folders.map(folder => ({ value: folder, label: folder })),
              ]}
            />
            <Input className="border-none" value={title} onChange={(e) => setTitle(e.target.value)} />
          </div>
          <div className="flex items-center space-x-2 mt-2">
            <Checkbox disabled={chat?.tagId === 1} id="terms" checked={isRemove} onCheckedChange={value => setIsRemove(value)} />
            <label
              htmlFor="terms"
              className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
            >
              {t('note.deleteTag')}
            </label>
          </div>
        </div>
        <ResponsiveDialogFooter>
          <div className="flex flex-col items-stretch gap-2 pt-2 sm:flex-row sm:items-center sm:justify-end">
            <p className="text-xs text-zinc-400 flex items-center gap-1"><TriangleAlert className="size-4" />{t('note.warning')}</p>
            <Button type="submit" onClick={handleTransform}>{t('note.convert_button')}</Button>
          </div>
        </ResponsiveDialogFooter>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  )
}
