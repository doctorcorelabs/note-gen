// Copyright (C) 2026 doctorcorelabs
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.
//
// POC ONLY. This file is a minimal proof-of-concept replacement for
// `@tauri-apps/api/app` used only to prove that the app boots in a plain
// browser without Tauri (Fase 0 POC, W12). It is NOT a production adapter
// and it MUST be replaced by the real AppAdapter from design F1 in Fase 1.
//
// Only `getVersion` is stubbed, because it is the only export from
// `@tauri-apps/api/app` imported anywhere in src/ at HEAD 4dcaa3f (7 sites,
// all `import { getVersion }`, verified by grep). The returned string is
// deliberately marked `-poc` so a POC build can never be mistaken for the
// real desktop app. The base version `0.39.2` comes from
// `src-tauri/tauri.conf.json` (see design D6). No other export from the
// original module is provided; adding one later must be a conscious Fase 1
// decision, not a silent extension of this stub.

const POC_VERSION = '0.39.2-poc'
let logged = false

export async function getVersion(): Promise<string> {
  if (!logged) {
    logged = true
    console.info('[notegen-poc-app] getVersion() served by the POC shim, returning "0.39.2-poc"')
  }
  return POC_VERSION
}
