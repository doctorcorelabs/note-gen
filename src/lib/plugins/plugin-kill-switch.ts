// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

/**
 * Plugin kill switch: code enforcement for plugins OFF in the web build.
 *
 * Before wave 4, OFF was a composition of separate layers with no single
 * switch: a build-static web-chrome flag with no consumer, a gated
 * settings page, an empty installed list in web mode, and invoke
 * rejections for unbuilt plugin commands. None of those layers checked
 * one shared flag, and the plugin host still initialized in web mode.
 *
 * This module is the single enforcement entry point (W4-SEC, H4-KILL
 * gates G0-G3). Every choke point reads the same value:
 *
 * - G0: PluginHostBridge does not start the host while the switch is active.
 * - G1: PluginHost.initialize returns silently, activate rejects, and
 *   reconcile does nothing while the switch is active.
 * - G2: invokePluginCapability rejects every RPC method at its head
 *   while the switch is active.
 * - G3: invokePluginBackend, the single plugin seam, rejects every
 *   plugin backend command while the switch is active.
 *
 * The switch is web-only. The Tauri desktop shell is exempt because the
 * desktop app is the upstream runtime where plugins run; the exemption
 * reads the shell marker directly through isTauri() from the platform
 * detect leaf, the same marker checkIsTauri() caches for the rest of
 * the plugin seam. The direct read keeps this module free of the
 * platform barrel (no import cycle, unit-testable) and is never stale:
 * the marker is fixed before application code runs. In every
 * non-Tauri runtime, phase off means no plugin may run, and any doubt
 * fails closed: a missing or unrecognized phase is treated as off by
 * the strict equality below.
 *
 * Scope limit, stated honestly: this is the build-static layer only.
 * There is no runtime kill that takes effect without a redeploy yet
 * (F8 section 10.5, H4-KILL Q1). The 39 UI surfaces of inventory V2-32
 * are not wired here either; the settings dialog gate that already
 * exists is unchanged. This module closes the host/broker/seam layers,
 * which are the layers that can execute plugin code.
 */

import { isTauri } from '../platform/detect'
import { PluginError } from '@notegen/plugin-api'
import { PLUGIN_WEB_PHASE, type PluginWebPhase } from './plugin-web-phase'

export { PLUGIN_WEB_PHASE, type PluginWebPhase }

export const PLUGIN_KILL_SWITCH_MESSAGE =
  'Plugins are off in this build. Plugin execution is disabled by the plugin kill switch.'

/**
 * True when no plugin may run in this runtime: the build phase is off
 * and the runtime is not the Tauri desktop shell. Call sites must gate
 * on this function, never on a local copy of the phase value.
 */
export function isPluginKillSwitchActive(): boolean {
  if (PLUGIN_WEB_PHASE !== 'off') return false
  return !isTauri()
}

/** Throw the explicit kill-switch rejection unless plugins may run. */
export function assertPluginsEnabled(): void {
  if (isPluginKillSwitchActive()) {
    throw new PluginError('UnavailableOnPlatform', PLUGIN_KILL_SWITCH_MESSAGE)
  }
}
