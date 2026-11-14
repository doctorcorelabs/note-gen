// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

import {
  capabilityError,
  PlatformCapabilityError,
} from "../errors";
import type {
  InvokeAdapter,
  InvokeArgs,
  InvokeOptions,
} from "./interface";
import type {
  BackendRoute,
  BackendTransportRequest,
  InvokeStreamAdapter,
  RouterArgs,
} from "./router";
import {
  createHandlerRegistry,
  type HandlerRegistry,
} from "./handlers";
import {
  createBackendNotImplementedRejection,
  createDefaultRejection,
  createGatedRejection,
  createInvalidArgsRejection,
  createStreamNotAvailableRejection,
  isGatedCommand,
} from "./rejections";
import {
  AI_CHAT_STREAM_COMMAND,
  getBackendRoute,
} from "./routes";
import {
  BOOT_STUBS,
  isStorefrontStubCommand,
  storefrontStub,
} from "./stubs";

/**
 * Web invoke adapter: typed dispatch for Tauri-style commands.
 *
 * Dispatch order is binding and follows the router design (section 2.2):
 * 1. Boot and storefront stubs run locally and ignore all arguments.
 * 2. Gated commands reject locally with a gated rejection.
 * 3. Disabled and unknown names reject locally through the default
 *    path. No HTTP.
 * 4. The reserved stream route rejects locally: SSE is not available
 *    in the MVP and no empty iterable is ever returned instead.
 * 5. A BACKEND route from a phase that is not built yet rejects with
 *    an explicit 501 before argument validation. A registered
 *    handler is the signal that the endpoint exists, so a routed
 *    command with a handler still goes through validation.
 * 6. Phase 1 BACKEND routes validate arguments, resolve the
 *    dedicated endpoint from the route table, and call the
 *    registered handler. A route with no handler rejects with an
 *    explicit 501 error.
 *
 * The adapter never guesses an endpoint from a command name, never
 * sends the command name as request data, never retries, and never
 * forwards raw server text to the caller. In development it logs the
 * command name, the path taken, and the outcome code only; argument
 * and response contents are never logged.
 */

const MAX_ARG_DEPTH = 32;

const SECRET_ARG_KEYS: ReadonlySet<string> = new Set([
  "secret",
  "token",
  "apikey",
  "password",
  "accesstoken",
  "refreshtoken",
  "clientsecret",
  "authorization",
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function normalizeArgKey(key: string): string {
  return key.toLowerCase().replace(/_/g, "");
}

function cleanArgValue(
  command: string,
  value: unknown,
  path: string,
  depth: number,
): unknown {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw createInvalidArgsRejection(
        command,
        `Argument "${path}" must be a finite number.`,
      );
    }
    return value;
  }
  if (Array.isArray(value)) {
    if (depth >= MAX_ARG_DEPTH) {
      throw createInvalidArgsRejection(command, "Arguments are nested too deeply.");
    }
    const cleaned: unknown[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const item: unknown = value[index];
      if (item === undefined) {
        throw createInvalidArgsRejection(
          command,
          `Argument "${path}[${index}]" must not be undefined.`,
        );
      }
      cleaned.push(cleanArgValue(command, item, `${path}[${index}]`, depth + 1));
    }
    return cleaned;
  }
  if (isPlainObject(value)) {
    if (depth >= MAX_ARG_DEPTH) {
      throw createInvalidArgsRejection(command, "Arguments are nested too deeply.");
    }
    const cleaned: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (entry === undefined) {
        continue;
      }
      cleaned[key] = cleanArgValue(command, entry, `${path}.${key}`, depth + 1);
    }
    return cleaned;
  }
  throw createInvalidArgsRejection(
    command,
    `Argument "${path}" must be plain JSON data.`,
  );
}

/**
 * Validate invoke arguments into plain JSON data. Top-level
 * `undefined` values are dropped, nested `undefined` object values
 * are dropped, and anything that is not plain JSON (functions,
 * class instances such as Date or File, non-finite numbers, symbols)
 * is rejected locally without HTTP. Top-level secret-shaped keys
 * are rejected: secrets live server-side and must never travel as
 * invoke arguments.
 */
export function validateInvokeArgs(
  command: string,
  args: InvokeArgs | undefined,
): RouterArgs {
  if (args === undefined) {
    return {};
  }
  if (!isPlainObject(args)) {
    throw createInvalidArgsRejection(command, "Arguments must be an object.");
  }
  const cleaned: RouterArgs = {};
  for (const [key, value] of Object.entries(args)) {
    if (SECRET_ARG_KEYS.has(normalizeArgKey(key))) {
      throw createInvalidArgsRejection(
        command,
        `Argument "${key}" must not be sent from the client.`,
      );
    }
    if (value === undefined) {
      continue;
    }
    cleaned[key] = cleanArgValue(command, value, key, 1);
  }
  return cleaned;
}

export interface ResolvedRoutePath {
  readonly path: string;
  readonly usedKeys: readonly string[];
}

/**
 * Substitute `{placeholder}` segments from arguments. Placeholder
 * values must be strings or finite numbers; a missing placeholder is
 * a local validation error, never a request to a half-built path.
 */
export function resolveRoutePath(
  route: BackendRoute,
  args: RouterArgs,
): ResolvedRoutePath {
  const usedKeys: string[] = [];
  const path = route.path.replace(/\{([^}]+)\}/g, (_match, key: string) => {
    const value: unknown = args[key];
    if (typeof value === "string") {
      if (value === "") {
        throw createInvalidArgsRejection(
          route.command,
          `Argument "${key}" must not be empty.`,
        );
      }
      usedKeys.push(key);
      return encodeURIComponent(value);
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      usedKeys.push(key);
      return encodeURIComponent(String(value));
    }
    throw createInvalidArgsRejection(
      route.command,
      `Argument "${key}" is required for the endpoint path.`,
    );
  });
  return { path, usedKeys };
}

/**
 * Build the transport request from a route and validated arguments.
 * GET arguments become a query string (scalars only); other methods
 * carry the remaining arguments as the JSON body. Placeholder keys
 * are consumed by the path and appear in neither place.
 */
export function buildTransportRequest(
  route: BackendRoute,
  args: RouterArgs,
  signal?: AbortSignal,
): BackendTransportRequest {
  const { path, usedKeys } = resolveRoutePath(route, args);
  const used = new Set(usedKeys);
  const rest: RouterArgs = {};
  for (const [key, value] of Object.entries(args)) {
    if (!used.has(key)) {
      rest[key] = value;
    }
  }
  if (route.method === "GET") {
    const query: Record<string, string> = {};
    for (const [key, value] of Object.entries(rest)) {
      if (
        typeof value === "string" ||
        typeof value === "number" ||
        typeof value === "boolean"
      ) {
        query[key] = String(value);
      } else {
        throw createInvalidArgsRejection(
          route.command,
          `Argument "${key}" must be a scalar for a GET request.`,
        );
      }
    }
    return { method: route.method, path, query, body: undefined, signal };
  }
  return { method: route.method, path, query: {}, body: rest, signal };
}

function isDevelopment(): boolean {
  try {
    const env = (globalThis as { process?: { env?: Record<string, string | undefined> } })
      .process?.env;
    return env?.["NODE_ENV"] === "development";
  } catch {
    return false;
  }
}

function devLog(command: string, outcome: string): void {
  if (isDevelopment()) {
    console.debug(`[invoke] ${command} -> ${outcome}`);
  }
}

export class WebInvokeAdapter implements InvokeAdapter, InvokeStreamAdapter {
  private readonly handlers: HandlerRegistry;

  constructor(handlers: HandlerRegistry = createHandlerRegistry()) {
    this.handlers = handlers;
  }

  async invoke<T>(
    command: string,
    args?: InvokeArgs,
    options?: InvokeOptions,
  ): Promise<T> {
    if (typeof command !== "string" || command === "") {
      devLog(String(command), "invalid_argument");
      throw createInvalidArgsRejection("", "A command name is required.");
    }

    const stub = BOOT_STUBS.get(command);
    if (stub !== undefined) {
      devLog(command, "stub");
      return stub() as T;
    }
    if (isStorefrontStubCommand(command)) {
      devLog(command, "stub");
      return storefrontStub() as T;
    }

    if (isGatedCommand(command)) {
      devLog(command, "unsupported");
      throw createGatedRejection(command);
    }

    const route = getBackendRoute(command);
    if (route === undefined) {
      devLog(command, "unavailable");
      throw createDefaultRejection(command);
    }

    if (route.stream === true) {
      devLog(command, "not_implemented/stream");
      throw createStreamNotAvailableRejection(command, route.path);
    }

    // Design 2.2 step 4: a BACKEND route whose phase is not built yet
    // rejects before argument validation, so a bad argument can never
    // mask "not built yet" as a validation failure. Phase 1 routes
    // always validate first (step 5) and reject with 501 only when no
    // handler is registered for them.
    if (route.phase !== "1" && !this.handlers.has(command)) {
      devLog(command, "not_implemented/501");
      throw createBackendNotImplementedRejection(route);
    }

    const validated = validateInvokeArgs(command, args);
    // The G0 InvokeOptions carry headers owned by the transport; the
    // raw contract has no cancellation signal, so none is threaded
    // here. Cancellation arrives with the transport in a later wave.
    void options;
    const request = buildTransportRequest(route, validated);
    const handler = this.handlers.get(command);
    if (handler === undefined) {
      devLog(command, "not_implemented/501");
      throw createBackendNotImplementedRejection(route);
    }
    try {
      const result = await handler({
        route,
        args: validated,
        request,
      });
      devLog(command, "ok");
      return result as T;
    } catch (error) {
      if (error instanceof PlatformCapabilityError) {
        devLog(command, error.code);
        throw error;
      }
      devLog(command, "backend_error");
      throw capabilityError(
        "backend_error",
        "invoke",
        command,
        "web",
        "Backend handler failed.",
      );
    }
  }

  /**
   * transformCallback has no meaning in web mode (G0): the Tauri
   * event-listener seam it serves does not exist here, so the
   * capability is reported unavailable instead of returning a
   * meaningless id.
   */
  transformCallback<T = unknown>(
    _callback?: (response: T) => void,
    _once?: boolean,
  ): number {
    void _callback;
    void _once;
    throw capabilityError(
      "unavailable",
      "invoke",
      "transformCallback",
      "web",
      "transformCallback is unavailable in web mode",
    );
  }

  /**
   * Channel mapping to SSE, explicit stub in the MVP. The single
   * channel command maps to a reserved SSE endpoint in a later
   * phase; until then every stream request rejects with an explicit
   * not-implemented error. Any other command rejects through the
   * default path. This method never opens a stream and never
   * returns an empty iterable in place of an error.
   */
  async stream<T = unknown>(
    command: string,
    _args?: RouterArgs,
    _signal?: AbortSignal,
  ): Promise<AsyncIterable<T>> {
    void _args;
    void _signal;
    if (command === AI_CHAT_STREAM_COMMAND) {
      const route = getBackendRoute(command);
      devLog(command, "not_implemented/stream");
      throw createStreamNotAvailableRejection(command, route?.path);
    }
    devLog(String(command), "unavailable");
    throw createDefaultRejection(String(command));
  }
}

export function createWebInvokeAdapter(
  handlers?: HandlerRegistry,
): WebInvokeAdapter {
  return new WebInvokeAdapter(handlers);
}
