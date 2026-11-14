// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

/**
 * Local HttpAdapter interface (provisional copy of the canonical interface).
 *
 * The canonical interface is owned by worker V2-04 (branch
 * web-registry-g0). The type declarations below are identical to the
 * canonical ones read from that branch, so the integrator can keep
 * either copy with no type reconciliation. This copy exists so the
 * web implementation in this directory can be written, typechecked,
 * and tested inside this branch without waiting for the merge.
 *
 * Surface, per the V1-05 inventory (design registry shim, section
 * 1.7), re-verified against the reference tree at 4dcaa3f and the
 * installed plugin-http 2.3.0 declarations: `fetch` (including the
 * call-site aliases `httpFetch` and `tauriFetch`), plus the
 * `ClientOptions` and `Proxy` types. The plugin types are redeclared
 * here under their upstream names so this file never imports a Tauri
 * specifier; the field shapes match the installed declarations.
 *
 * Notes on the upstream shape:
 * - The installed plugin `fetch` returns a standard web `Response`
 *   and takes `RequestInit` options. There is no `responseType`
 *   option in the installed declarations, and no `responseType`
 *   usage exists in src, so no response-type mapping is defined.
 * - `timeout` as a bare option name does not exist either; the
 *   timeout knob is `connectTimeout` (milliseconds).
 * - `Proxy` is used as a type only in src (object literals such as
 *   `{ all: proxyUrl }`); no call site constructs it as a value, so
 *   a type-only redeclaration is sufficient.
 * - The local wrapper in src/lib/sync/encode-fetch.ts bypasses the
 *   plugin `fetch` and talks to the plugin over raw invoke commands;
 *   its migration is owned by the G2 codemod, not by this signature.
 */
export interface ProxyConfig {
  url: string;
  basicAuth?: {
    username: string;
    password: string;
  };
  noProxy?: string;
}

export interface Proxy {
  all?: string | ProxyConfig;
  http?: string | ProxyConfig;
  https?: string | ProxyConfig;
}

export interface DangerousSettings {
  acceptInvalidCerts?: boolean;
  acceptInvalidHostnames?: boolean;
}

export interface ClientOptions {
  maxRedirections?: number;
  connectTimeout?: number;
  proxy?: Proxy;
  danger?: DangerousSettings;
}

export interface HttpAdapter {
  fetch(
    input: URL | Request | string,
    init?: RequestInit & ClientOptions,
  ): Promise<Response>;
}
