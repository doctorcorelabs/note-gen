'use client'

import { useState } from 'react'
import { platform } from '@/lib/platform'
import { useTranslations } from 'next-intl'
import { ChevronDown, FileArchive, FolderInput, FolderOpen, Upload } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ResponsiveActionMenu } from '@/components/responsive-action-menu'
import { Spinner } from '@/components/ui/spinner'
import { useToast } from '@/hooks/use-toast'
import { getWorkspacePath } from '@/lib/workspace'

type SkillScope = 'global' | 'project'
type SkillSourceKind = 'directory' | 'zip'

interface SkillInstallActionsProps {
  scope: SkillScope
  onInstalled: () => Promise<void> | void
  showFileActions?: boolean
}

async function getSkillsDirectory(scope: SkillScope): Promise<string> {
  if (scope === 'global') {
    return platform.path.join(await platform.path.appDataDir(), 'skills')
  }

  const workspace = await getWorkspacePath()
  return workspace.isCustom
    ? platform.path.join(workspace.path, 'skills')
    : platform.path.join(await platform.path.appDataDir(), 'article', 'skills')
}

export function SkillInstallActions({
  scope,
  onInstalled,
  showFileActions = true,
}: SkillInstallActionsProps) {
  const t = useTranslations('settings.skills')
  const { toast } = useToast()
  const [isImporting, setIsImporting] = useState(false)

  const handleOpenDirectory = async () => {
    try {
      const skillsDirectory = await getSkillsDirectory(scope)
      await platform.fs.mkdir(skillsDirectory, { recursive: true })
      await platform.opener.openPath(skillsDirectory)
    } catch (error) {
      console.error('Failed to open Skills directory:', error)
      toast({
        title: t('openDirectoryError'),
        description: error instanceof Error ? error.message : String(error),
        variant: 'destructive',
      })
    }
  }

  const handleImport = async (sourceKind: SkillSourceKind) => {
    try {
      const sourcePath = await platform.dialog.open(sourceKind === 'directory'
        ? {
            title: t('selectSkillFolder'),
            directory: true,
            multiple: false,
          }
        : {
            title: t('selectSkillZip'),
            filters: [{ name: 'ZIP', extensions: ['zip'] }],
            multiple: false,
          })

      if (!sourcePath || Array.isArray(sourcePath)) return

      setIsImporting(true)
      const workspace = scope === 'project' ? await getWorkspacePath() : null
      const skillName = await platform.invoke.invoke<string>('import_skill', {
        sourcePath,
        sourceKind,
        scope,
        workspaceRoot: workspace?.isCustom ? workspace.path : null,
      })

      await onInstalled()
      toast({
        title: t('importSuccess'),
        description: t('importedSkill', { name: skillName }),
      })
    } catch (error) {
      console.error('Import Skill failed:', error)
      toast({
        title: t('importError'),
        description: error instanceof Error ? error.message : String(error),
        variant: 'destructive',
      })
    } finally {
      setIsImporting(false)
    }
  }

  return (
    <div className="flex flex-wrap items-center justify-end gap-2">
      {showFileActions ? (
        <Button variant="outline" size="sm" onClick={handleOpenDirectory}>
          <FolderOpen data-icon="inline-start" />
          {t('openSkillsFolder')}
        </Button>
      ) : null}
      <ResponsiveActionMenu
        title={t('installSkill')}
        trigger={
          <Button variant="outline" size="sm" disabled={isImporting}>
            {isImporting ? (
              <Spinner data-icon="inline-start" />
            ) : (
              <Upload data-icon="inline-start" />
            )}
            {isImporting ? t('importing') : t('installSkill')}
            <ChevronDown data-icon="inline-end" />
          </Button>
        }
        items={[
          ...(showFileActions ? [{
            key: 'directory',
            label: t('installFromFolder'),
            icon: <FolderInput />,
            onSelect: () => handleImport('directory'),
          }] : []),
          {
            key: 'zip',
            label: t('installFromZip'),
            icon: <FileArchive />,
            onSelect: () => handleImport('zip'),
          },
        ]}
      />
    </div>
  )
}
