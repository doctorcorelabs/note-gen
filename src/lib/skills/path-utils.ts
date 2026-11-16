import { platform } from '@/lib/platform'
import { getFilePathOptions } from '@/lib/workspace'
import type { SkillScope } from './types'

export async function resolveSkillDirectory(skillDir: string, scope: SkillScope): Promise<string> {
  if (scope === 'global') {
    const appDataPath = await platform.path.appDataDir()
    return `${appDataPath}/${skillDir}`
  }

  const options = await getFilePathOptions(skillDir)
  if (options.baseDir) {
    const appDataPath = await platform.path.appDataDir()
    return `${appDataPath}/${options.path}`
  }
  return options.path
}
