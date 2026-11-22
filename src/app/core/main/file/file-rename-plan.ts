// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

// Pure rename planning for the file tree (N-02/N-04): a note keeps
// its Markdown suffix across renames, including extensionless
// originals, and the suffix check is case-insensitive so "Note.MD"
// is not renamed to "Baru.MD.md".
export function hasMarkdownSuffix(name: string): boolean {
  return name.toLowerCase().endsWith('.md')
}

export function buildFileRenamePlan({
  originalName,
  currentPath,
  enteredName,
}: {
  originalName: string
  currentPath: string
  enteredName: string
}) {
  const needsMarkdownSuffix =
    !hasMarkdownSuffix(enteredName) &&
    (originalName === '' || hasMarkdownSuffix(originalName) || !originalName.includes('.'))
  const displayName = needsMarkdownSuffix ? `${enteredName}.md` : enteredName
  const parentPath = currentPath.split('/').slice(0, -1).join('/')
  const targetRelativePath = parentPath ? `${parentPath}/${displayName}` : displayName

  return {
    operation: originalName === '' ? 'create' : 'rename',
    displayName,
    targetRelativePath,
  } as const
}
