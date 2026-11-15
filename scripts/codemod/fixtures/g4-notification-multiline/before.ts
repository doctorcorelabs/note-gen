// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
// Codemod fixture: g4-notification-multiline. Synthetic example.

import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from '@tauri-apps/plugin-notification';

export async function notifyUser(title: string, body: string): Promise<boolean> {
  const granted = await isPermissionGranted();
  if (!granted) {
    const permission = await requestPermission();
    if (permission !== 'granted') {
      return false;
    }
  }
  sendNotification({ title, body });
  return true;
}
