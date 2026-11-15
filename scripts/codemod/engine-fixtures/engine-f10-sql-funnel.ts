// SPDX-License-Identifier: GPL-3.0-only
// Engine fixture (V3-16aR). Not part of the app bundle; never imported by src/.

import Database, { type QueryResult } from '@tauri-apps/plugin-sql'
import { invoke } from '@tauri-apps/api/core'

export async function getDb() {
  return Database.load('sqlite:note.db')
}
export type R = QueryResult
