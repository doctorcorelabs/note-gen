// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

import { getPlatformMode, type PlatformMode } from "./detect";

/**
 * Canonical home of the platform adapter registry (AD-23).
 *
 * Adapter interfaces live in subdirectories of this folder, one per
 * capability group. This skeleton only defines the registry mechanics;
 * interface definitions and adapter registrations land with wave 2.
 */
export type AdapterRegistration = {
  name: string;
  adapter: unknown;
  modes: readonly PlatformMode[];
};

const registry = new Map<string, AdapterRegistration>();

export function registerAdapter(registration: AdapterRegistration): void {
  registry.set(registration.name, registration);
}

export function getAdapter<T>(name: string): T {
  const entry = registry.get(name);
  if (!entry) {
    throw new Error(`Platform adapter "${name}" is not registered`);
  }
  return entry.adapter as T;
}

export function hasAdapter(name: string): boolean {
  return registry.has(name);
}

export function listAdapters(): readonly AdapterRegistration[] {
  return [...registry.values()];
}

export function getCurrentMode(): PlatformMode {
  return getPlatformMode();
}
