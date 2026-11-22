import test from 'node:test'
import assert from 'node:assert/strict'

import { getPasteTargetDirectory, isSameParentCut } from './paste-target.js'

test('uses the current folder path as the paste target for folder items', () => {
  assert.equal(getPasteTargetDirectory('projects/docs'), 'projects/docs')
})

test('keeps a root folder path as the paste target for folder items', () => {
  assert.equal(getPasteTargetDirectory('inbox'), 'inbox')
})

test('cut folder pasted into its own parent is a no-op (F-05)', () => {
  assert.equal(isSameParentCut('projects/docs', 'projects', 'docs'), true)
})

test('cut folder pasted into another folder is not a no-op (F-05)', () => {
  assert.equal(isSameParentCut('projects/docs', 'archive', 'docs'), false)
})

test('cut file at the workspace root pasted at the root is a no-op (F-05)', () => {
  assert.equal(isSameParentCut('note.md', '', 'note.md'), true)
  assert.equal(isSameParentCut('note.md', 'inbox', 'note.md'), false)
})
