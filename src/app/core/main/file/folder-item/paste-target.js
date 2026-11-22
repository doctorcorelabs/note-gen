export function getPasteTargetDirectory(folderPath) {
  return folderPath
}

// A cut pasted back into the item's own parent directory is a no-op:
// the candidate target path equals the item path. Without this guard
// the copy-name generator renames the item to `<name>_copy` (F-05).
export function isSameParentCut(itemPath, targetDir, itemName) {
  const candidate = targetDir ? `${targetDir}/${itemName}` : itemName
  return candidate === itemPath
}
