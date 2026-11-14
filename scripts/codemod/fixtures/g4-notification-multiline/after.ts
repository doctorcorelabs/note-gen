// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
// Codemod fixture: g4-notification-multiline. Synthetic example.

import { platform } from '@/lib/platform';

export async function notifyUser(title: string, body: string): Promise<boolean> {
  const granted = await platform.notification.isPermissionGranted();
  if (!granted) {
    const permission = await platform.notification.requestPermission();
    if (permission !== 'granted') {
      return false;
    }
  }
  platform.notification.sendNotification({ title, body });
  return true;
}
