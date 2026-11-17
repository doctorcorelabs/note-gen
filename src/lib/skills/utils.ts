/**
 * Skills 相关工具函数
 *
 * 用于处理 Skills 文件夹的特殊逻辑
 * 遵循 Agent Skills 官方规范: https://agentskills.io/specification
 */

import {
  SKILLS_DIR_NAME,
  SCRIPTS_DIR_NAME,
  REFERENCES_DIR_NAME,
  ASSETS_DIR_NAME,
  SKILL_FILE_NAME,
} from './types'

/**
 * 检查文件夹是否是 Skills 文件夹
 */
export function isSkillsFolder(folderName: string): boolean {
  return folderName === SKILLS_DIR_NAME
}

/**
 * 检查路径是否在 Skills 文件夹内
 */
export function isInSkillsFolder(path: string): boolean {
  const normalizedPath = path.replace(/\\/g, '/')
  return (
    normalizedPath.includes(`/${SKILLS_DIR_NAME}/`) ||
    normalizedPath.startsWith(`${SKILLS_DIR_NAME}/`)
  )
}

/**
 * 检查路径是否在 Skill 子目录中 (scripts/, references/, assets/)
 */
export function isInSkillSubdirectory(path: string): {
  inSkill: boolean
  skillId: string | null
  subdirectory: 'scripts' | 'references' | 'assets' | null
} {
  const normalizedPath = path.replace(/\\/g, '/')

  // 检查 scripts/
  const scriptsMatch = normalizedPath.match(
    new RegExp(`${SKILLS_DIR_NAME}/([^/]+)/${SCRIPTS_DIR_NAME}/`)
  )
  if (scriptsMatch) {
    return {
      inSkill: true,
      skillId: scriptsMatch[1],
      subdirectory: 'scripts',
    }
  }

  // 检查 references/
  const referencesMatch = normalizedPath.match(
    new RegExp(`${SKILLS_DIR_NAME}/([^/]+)/${REFERENCES_DIR_NAME}/`)
  )
  if (referencesMatch) {
    return {
      inSkill: true,
      skillId: referencesMatch[1],
      subdirectory: 'references',
    }
  }

  // 检查 assets/
  const assetsMatch = normalizedPath.match(
    new RegExp(`${SKILLS_DIR_NAME}/([^/]+)/${ASSETS_DIR_NAME}/`)
  )
  if (assetsMatch) {
    return {
      inSkill: true,
      skillId: assetsMatch[1],
      subdirectory: 'assets',
    }
  }

  return {
    inSkill: false,
    skillId: null,
    subdirectory: null,
  }
}

/**
 * 获取 Skills 文件夹的特殊图标组件
 */
export function getSkillsFolderIcon(): string {
  return 'Sparkles'  // lucide-react 图标名称
}

/**
 * 判断是否应该隐藏知识库相关选项
 */
export function shouldHideKnowledgeBaseOptions(folderName: string, filePath: string): boolean {
  return isSkillsFolder(folderName) || isInSkillsFolder(filePath)
}

/**
 * 从右键菜单项中移除知识库相关选项
 */
export function filterKnowledgeBaseMenuItems(
  menuItems: any[],
  folderName: string,
  filePath: string
): any[] {
  if (!shouldHideKnowledgeBaseOptions(folderName, filePath)) {
    return menuItems
  }

  // 过滤掉知识库相关的菜单项
  return menuItems.filter((item: any) => {
    const itemId = item.props?.id || item.id || ''
    return !itemId.includes('knowledge-base')
  })
}

/**
 * 提取 Skill ID 从路径中
 * 例如: "skills/code-reviewer" -> "code-reviewer"
 */
export function extractSkillIdFromPath(path: string): string | null {
  const normalizedPath = path.replace(/\\/g, '/')

  // 检查是否在 skills 文件夹下
  const skillsFolderPattern = new RegExp(
    `${SKILLS_DIR_NAME}/([^/]+)`
  )
  const match = normalizedPath.match(skillsFolderPattern)

  if (match && match[1]) {
    return match[1]
  }

  return null
}

/**
 * 检查路径是否是 Skill 子文件夹
 * 例如: "skills/code-reviewer" -> true
 *       "skills" -> false
 *       "other/code-reviewer" -> false
 */
export function isSkillSubfolder(path: string): boolean {
  return extractSkillIdFromPath(path) !== null
}

/**
 * 检查文件是否是 SKILL.md
 */
export function isSkillFile(fileName: string): boolean {
  return fileName === SKILL_FILE_NAME
}

/**
 * 获取 Skill 目录结构信息
 * 返回 Skill 目录的完整结构描述
 */
export function getSkillDirectoryStructure(): {
  description: string
  structure: Record<string, { description: string; required: boolean }>
} {
  return {
    description: 'Agent Skills directory structure (following the official specification)',
    structure: {
      [SKILL_FILE_NAME]: {
        description: 'Skill definition file (required)',
        required: true,
      },
      [SCRIPTS_DIR_NAME + '/']: {
        description: 'Executable scripts directory (optional)',
        required: false,
      },
      [REFERENCES_DIR_NAME + '/']: {
        description: 'Reference documentation directory (optional)',
        required: false,
      },
      [ASSETS_DIR_NAME + '/']: {
        description: 'Static assets directory (optional)',
        required: false,
      },
    },
  }
}

/**
 * 格式化 Skill 列表为可读格式
 */
export function formatSkillList(skills: Array<{ id: string; name: string; description: string }>): string {
  if (skills.length === 0) {
    return 'No Skills available'
  }

  const lines: string[] = [`Available Skills (${skills.length}):`, '']

  for (const skill of skills) {
    lines.push(`- ${skill.name}`)
    lines.push(`  ${skill.description}`)
    lines.push('')
  }

  return lines.join('\n')
}

/**
 * 验证 Skill 目录结构
 * 检查目录是否符合官方规范
 */
export function validateSkillDirectoryStructure(files: string[]): {
  valid: boolean
  hasSkillFile: boolean
  hasScriptsDir: boolean
  hasReferencesDir: boolean
  hasAssetsDir: boolean
  warnings: string[]
} {
  const warnings: string[] = []

  // 检查必填文件
  const hasSkillFile = files.some(f => f.endsWith(SKILL_FILE_NAME))

  // 检查官方规范目录
  const hasScriptsDir = files.some(f => f.includes(`${SCRIPTS_DIR_NAME}/`))
  const hasReferencesDir = files.some(f => f.includes(`${REFERENCES_DIR_NAME}/`))
  const hasAssetsDir = files.some(f => f.includes(`${ASSETS_DIR_NAME}/`))

  // 检查旧格式文件 (向后兼容)
  const hasOldReferenceFile = files.some(f => f.endsWith('/REFERENCE.md'))
  const hasOldExamplesFile = files.some(f => f.endsWith('/EXAMPLES.md'))
  const hasOldKeywordsFile = files.some(f => f.endsWith('/KEYWORDS.md'))

  if (hasOldReferenceFile) {
    warnings.push(
      'Detected a legacy REFERENCE.md file; move it to the references/ directory'
    )
  }

  if (hasOldExamplesFile) {
    warnings.push(
      'Detected a legacy EXAMPLES.md file; move it to the references/ directory'
    )
  }

  if (hasOldKeywordsFile) {
    warnings.push(
      'Detected a legacy KEYWORDS.md file; merge its content into SKILL.md or move it to the references/ directory'
    )
  }

  return {
    valid: hasSkillFile,
    hasSkillFile,
    hasScriptsDir,
    hasReferencesDir,
    hasAssetsDir,
    warnings,
  }
}

/**
 * 将旧格式 Skill 结构迁移到新格式 (官方规范)
 * 提供迁移建议和步骤
 */
export function getMigrationGuide(): {
  title: string
  description: string
  steps: Array<{ from: string; to: string; description: string }>
} {
  return {
    title: 'Skill directory structure migration guide',
    description: 'Migrate a legacy-format Skill to the new format that follows the official specification',
    steps: [
      {
        from: 'REFERENCE.md',
        to: 'references/REFERENCE.md',
        description: 'Move reference documentation to the references/ directory',
      },
      {
        from: 'EXAMPLES.md',
        to: 'references/EXAMPLES.md',
        description: 'Move example documentation to the references/ directory',
      },
      {
        from: 'KEYWORDS.md',
        to: 'SKILL.md or references/KEYWORDS.md',
        description: 'Merge the keywords content into SKILL.md or move it to the references/ directory',
      },
      {
        from: 'No scripts directory',
        to: 'scripts/',
        description: 'Create a scripts/ directory for executable scripts',
      },
      {
        from: 'No assets directory',
        to: 'assets/',
        description: 'Create an assets/ directory for templates, images, and other static assets',
      },
    ],
  }
}

/**
 * 获取 Skill 模板 (用于创建新 Skill)
 */
export function getSkillTemplate(skillName: string, description: string): string {
  return `---
name: ${skillName}
description: ${description}
---
# ${skillName}

Add your skill instructions here.

## When to use

Use this skill when...

## Instructions

1. First step
2. Second step
3. etc.

## Notes

Add any additional notes here.
`
}
