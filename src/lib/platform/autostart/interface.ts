// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

/**
 * Local interface definition for the autostart adapter, following the
 * V1-05 inventory (desain-registry-shim.md section 1.14). The canonical
 * interface is owned by V2-04; the integrator reconciles this local
 * definition with the canonical one. Do not treat this file as the
 * canonical definition.
 *
 * The interface covers exactly the three surfaces from the desktop
 * autostart plugin imported anywhere in `src/` at HEAD 4dcaa3f, all in
 * one file (`src/app/core/setting/general/system-behavior-settings.tsx`,
 * aliased there as `enableAutostart`, `disableAutostart`, and
 * `isAutostartEnabled`): `isEnabled`, `enable`, and `disable`.
 */
export interface AutostartAdapter {
  /**
   * Report whether launch at system startup is enabled.
   *
   * In the web build this always rejects with a PlatformCapabilityError
   * (code `unsupported`, capability `isEnabled`). It deliberately does
   * not return `false`: an unknown autostart state must not be mistaken
   * for a disabled one.
   */
  isEnabled(): Promise<boolean>;

  /**
   * Enable launch at system startup.
   *
   * In the web build this always rejects with a PlatformCapabilityError
   * (code `unsupported`, capability `enable`).
   */
  enable(): Promise<void>;

  /**
   * Disable launch at system startup.
   *
   * In the web build this always rejects with a PlatformCapabilityError
   * (code `unsupported`, capability `disable`).
   */
  disable(): Promise<void>;
}
