// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

/**
 * Local HttpAdapter interface (provisional).
 *
 * The canonical interface is owned by worker V2-04; the integrator
 * reconciles this local definition with the canonical one. This file
 * exists so the web implementation in this directory can be written,
 * typechecked, and tested without waiting for that reconciliation.
 *
 * Surface, per the V1-05 inventory (design registry shim, section 1.7):
 * `fetch` from plugin-http, with the `ClientOptions` fields
 * `maxRedirections`, `connectTimeout`, `proxy`, and `danger`. The
 * plugin types are redeclared here under Http-prefixed names so this
 * file never imports a Tauri specifier; the field shapes match the
 * installed plugin-http 2.3.0 declarations.
 *
 * Notes on the upstream shape:
 * - The installed plugin `fetch` returns a standard web `Response`
 *   and takes `RequestInit` options. There is no `responseType`
 *   option in the installed declarations, and no `responseType`
 *   usage exists in src, so no response-type mapping is defined.
 * - `timeout` as a bare option name does not exist either; the
 *   timeout knob is `connectTimeout` (milliseconds).
 * - Call sites use the aliases `httpFetch` and `tauriFetch` for the
 *   same function; the adapter exposes the single method `fetch`.
 */
export interface HttpProxyConfig {
  /** URL of the proxy server. */
  readonly url: string;
  /** Proxy-Authorization header via Basic auth. */
  readonly basicAuth?: {
    readonly username: string;
    readonly password: string;
  };
  /** Comma-separated list of hosts that must bypass the proxy. */
  readonly noProxy?: string;
}

export interface HttpProxy {
  /** Proxy all traffic to the passed URL. */
  readonly all?: string | HttpProxyConfig;
  /** Proxy all HTTP traffic to the passed URL. */
  readonly http?: string | HttpProxyConfig;
  /** Proxy all HTTPS traffic to the passed URL. */
  readonly https?: string | HttpProxyConfig;
}

export interface HttpDangerSettings {
  /** Disables SSL verification. No browser equivalent. */
  readonly acceptInvalidCerts?: boolean;
  /** Disables hostname verification. No browser equivalent. */
  readonly acceptInvalidHostnames?: boolean;
}

export interface HttpClientOptions {
  /**
   * Maximum number of redirects to follow. Zero means no redirects
   * are followed.
   */
  readonly maxRedirections?: number;
  /** Timeout in milliseconds. */
  readonly connectTimeout?: number;
  /** Proxy configuration. No browser equivalent. */
  readonly proxy?: HttpProxy;
  /** Dangerous client settings. No browser equivalent. */
  readonly danger?: HttpDangerSettings;
}

export interface HttpAdapter {
  /**
   * Fetch a resource, with the same signature as the plugin-http
   * `fetch`: standard `RequestInit` plus `HttpClientOptions`.
   * The web implementation enforces the same-origin policy documented
   * in http.web.ts and rejects cross-origin requests whose origin is
   * not on the (MVP-empty) allowlist.
   */
  fetch(
    input: string | URL | Request,
    init?: RequestInit & HttpClientOptions,
  ): Promise<Response>;
}
