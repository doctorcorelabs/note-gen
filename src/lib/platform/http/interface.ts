// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

/**
 * HttpAdapter interface (migration wave G2).
 *
 * Replaces the upstream plugin-http surface: fetch, plus the ClientOptions
 * and Proxy types. Signatures mirror the installed upstream declarations
 * (plugin-http 2.x): fetch takes a standard RequestInit extended with
 * ClientOptions and returns a standard DOM Response. No call site uses a
 * responseType or timeout option, so no such mapping exists in this
 * contract; timeouts travel as AbortSignal, as in the standard fetch API.
 * The maxRedirections, connectTimeout, proxy, and danger fields of
 * ClientOptions are all used, through the local fetch wrapper and the
 * self-hosted sync clients.
 *
 * The local wrapper in src/lib/sync/encode-fetch.ts bypasses this fetch
 * and talks to the plugin over raw invoke commands; its G2 migration is
 * owned by the HttpAdapter implementation work, not by this signature.
 *
 * Merge M11 reconciliation (audit V2-40): G0 wins whole. The
 * branch interface is mechanically identical to G0 (verified
 * comment-stripped).
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
