// SPDX-License-Identifier: GPL-3.0-only
// Engine fixture (V3-16aR). Not part of the app bundle; never imported by src/.

import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from '@tauri-apps/plugin-notification'

export async function ping() {
  if (await isPermissionGranted()) sendNotification({ title: 'hi', body: 'yo' })
  await requestPermission()
}
