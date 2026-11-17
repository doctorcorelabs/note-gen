/**
 * Skill 验证器
 *
 * 验证 Skill 元数据和内容的完整性和正确性。
 * 遵循 Agent Skills 官方规范: https://agentskills.io/specification
 */

import {
  SkillContent,
  SkillYamlMetadata,
  ValidationResult,
  ValidationError,
  ValidationWarning,
} from './types'
import {
  isValidSkillId,
  isValidSkillName,
  isValidSkillDescription,
} from './parser'

// ============================================================================
// 验证函数
// ============================================================================

/**
 * 验证 Skill YAML 元数据 (符合官方规范)
 *
 * @param metadata - YAML 元数据
 * @returns 验证结果
 */
export function validateSkillYamlMetadata(metadata: SkillYamlMetadata): ValidationResult {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []

  // 验证必填字段 - name
  if (!metadata.name || metadata.name.trim().length === 0) {
    errors.push({
      field: 'name',
      message: 'The name field must not be empty',
      severity: 'error',
    })
  } else if (!isValidSkillName(metadata.name)) {
    errors.push({
      field: 'name',
      message: 'name must be 1-64 characters, only lowercase letters, digits, and hyphens; it must not start or end with a hyphen or contain consecutive hyphens',
      severity: 'error',
    })
  }

  // 验证必填字段 - description
  if (!metadata.description || metadata.description.trim().length === 0) {
    errors.push({
      field: 'description',
      message: 'The description field must not be empty',
      severity: 'error',
    })
  } else if (!isValidSkillDescription(metadata.description)) {
    errors.push({
      field: 'description',
      message: 'description must be 1-1024 characters',
      severity: 'error',
    })
  }

  // 验证可选字段 - license
  if (metadata.license) {
    if (metadata.license.length > 200) {
      warnings.push({
        field: 'license',
        message: 'license should be at most 200 characters',
        severity: 'warning',
      })
    }
  }

  // 验证可选字段 - compatibility
  if (metadata.compatibility) {
    if (metadata.compatibility.length > 500) {
      errors.push({
        field: 'compatibility',
        message: 'compatibility must be at most 500 characters',
        severity: 'error',
      })
    }
  }

  // 验证 metadata 字段
  if (metadata.metadata) {
    for (const [key, value] of Object.entries(metadata.metadata)) {
      if (key.length > 50) {
        warnings.push({
          field: 'metadata',
          message: `metadata key "${key}" is too long; keep it under 50 characters`,
          severity: 'warning',
        })
      }
      if (value.length > 500) {
        warnings.push({
          field: 'metadata',
          message: `The value of metadata "${key}" is too long; keep it under 500 characters`,
          severity: 'warning',
        })
      }
    }
  }

  // 验证 allowedTools (官方规范使用空格分隔)
  if (metadata.allowedTools) {
    const tools = Array.isArray(metadata.allowedTools)
      ? metadata.allowedTools
      : typeof metadata.allowedTools === 'string'
        ? metadata.allowedTools.split(/\s+/).filter(v => v.length > 0)
        : []

    if (tools.length === 0) {
      warnings.push({
        field: 'allowedTools',
        message: 'allowedTools is empty; remove this field or add tools',
        severity: 'warning',
      })
    }

    // 验证工具名称格式
    const invalidTools = tools.filter((tool) => !isValidToolName(tool))
    if (invalidTools.length > 0) {
      errors.push({
        field: 'allowedTools',
        message: `Invalid tool names: ${invalidTools.join(', ')}`,
        severity: 'error',
      })
    }
  }

  // 验证扩展字段 (向后兼容)
  if (metadata.version && !isValidVersion(metadata.version)) {
    warnings.push({
      field: 'version',
      message: 'Invalid version format; use semver format (e.g. 1.0.0)',
      severity: 'warning',
    })
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  }
}

/**
 * 验证 Skill 完整内容
 *
 * @param skill - Skill 内容
 * @returns 验证结果
 */
export function validateSkillContent(skill: SkillContent): ValidationResult {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []

  // 验证元数据
  const metadataResult = validateSkillYamlMetadata({
    name: skill.metadata.name,
    description: skill.metadata.description,
    license: skill.metadata.license,
    compatibility: skill.metadata.compatibility,
    metadata: skill.metadata.metadata,
    allowedTools: skill.metadata.allowedTools,
    version: skill.metadata.version,
    author: skill.metadata.author,
    model: skill.metadata.model,
    userInvocable: skill.metadata.userInvocable,
  })
  errors.push(...metadataResult.errors)
  warnings.push(...metadataResult.warnings)

  // 验证 ID 格式
  if (!isValidSkillId(skill.metadata.id)) {
    errors.push({
      field: 'id',
      message: 'Invalid Skill ID format; it must match the directory name and follow the name field format requirements',
      severity: 'error',
    })
  }

  // 验证 ID 与 name 匹配 (官方规范要求)
  if (skill.metadata.id !== skill.metadata.name) {
    warnings.push({
      field: 'id',
      message: 'The Skill ID should match the name field (recommended by the official spec)',
      severity: 'warning',
    })
  }

  // 验证指令内容
  if (!skill.instructions || skill.instructions.trim().length === 0) {
    errors.push({
      field: 'instructions',
      message: 'Instruction content must not be empty',
      severity: 'error',
    })
  } else {
    // 官方规范建议指令长度
    if (skill.instructions.length > 10000) {
      warnings.push({
        field: 'instructions',
        message: 'Instruction content exceeds 10000 characters; move detailed docs to the references/ directory',
        severity: 'warning',
      })
    }

    if (skill.instructions.length < 50) {
      warnings.push({
        field: 'instructions',
        message: 'Instruction content is too short; provide more detailed instructions',
        severity: 'warning',
      })
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  }
}

/**
 * 验证 Skill ID
 *
 * @param id - Skill ID
 * @returns 是否有效
 */
export function validateSkillId(id: string): boolean {
  return isValidSkillId(id)
}

// ============================================================================
// 辅助验证函数
// ============================================================================

/**
 * 验证版本号格式 (semver)
 *
 * @param version - 版本号字符串
 * @returns 是否有效
 */
function isValidVersion(version: string): boolean {
  return /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?(?:\+[a-zA-Z0-9.-]+)?$/.test(version)
}

/**
 * 验证工具名称格式
 *
 * @param toolName - 工具名称
 * @returns 是否有效
 */
function isValidToolName(toolName: string): boolean {
  // 工具名称可以包含字母、数字、下划线、冒号和星号
  // 例如: Bash, Read, git:*, jq:*
  return /^[a-zA-Z_][a-zA-Z0-9_:*]*$/.test(toolName)
}

// ============================================================================
// 工具函数
// ============================================================================

/**
 * 格式化验证结果为可读文本
 *
 * @param result - 验证结果
 * @returns 格式化的错误和警告信息
 */
export function formatValidationResult(result: ValidationResult): string {
  const lines: string[] = []

  if (result.valid) {
    lines.push('✓ Validation passed')
  } else {
    lines.push('✗ Validation failed')
  }

  if (result.errors.length > 0) {
    lines.push('\nErrors:')
    for (const error of result.errors) {
      lines.push(`  - ${error.field}: ${error.message}`)
    }
  }

  if (result.warnings.length > 0) {
    lines.push('\nWarnings:')
    for (const warning of result.warnings) {
      lines.push(`  - ${warning.field}: ${warning.message}`)
    }
  }

  return lines.join('\n')
}

/**
 * 获取验证错误的摘要
 *
 * @param result - 验证结果
 * @returns 错误摘要
 */
export function getValidationSummary(result: ValidationResult): string {
  if (result.valid) {
    return 'Validation passed'
  }

  const errorCount = result.errors.length
  const warningCount = result.warnings.length

  const parts: string[] = []
  if (errorCount > 0) {
    parts.push(`${errorCount} errors`)
  }
  if (warningCount > 0) {
    parts.push(`${warningCount} warnings`)
  }

  return `Validation failed: ${parts.join(', ')}`
}
