// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

import type {
  BackendRoute,
  BackendTransportRequest,
  RouterArgs,
} from "./router";
import { getBackendRoute } from "./routes";

/**
 * Handler registry for backend routes: the seam where a later wave
 * plugs a real backend endpoint behind a routed command.
 *
 * A handler receives the validated arguments and the transport
 * request already resolved from the route table (dedicated path,
 * method, query, body). The handler owns the HTTP call through the
 * transport it was built with; the adapter never constructs a path
 * from a command name and never calls a generic invoke endpoint.
 *
 * The registry starts empty in the MVP. A backend command with no
 * registered handler is an explicit 501 rejection from the adapter,
 * never a crash and never a silent failure. Registering a handler
 * for a name that has no backend route, for the reserved stream
 * route, or twice for the same command is a programming error and
 * throws at registration time, so a typo can never silently shadow
 * a route.
 */

export interface InvokeHandlerContext {
  readonly route: BackendRoute;
  /** Validated arguments, all keys including path placeholders. */
  readonly args: RouterArgs;
  /** Resolved transport request built from the route table. The body
   * and query already exclude path-placeholder keys. */
  readonly request: BackendTransportRequest;
}

export type InvokeHandler = (
  context: InvokeHandlerContext,
) => Promise<unknown>;

export class HandlerRegistry {
  private readonly handlers = new Map<string, InvokeHandler>();

  register(command: string, handler: InvokeHandler): void {
    const route = getBackendRoute(command);
    if (route === undefined) {
      throw new Error(
        `Cannot register a handler for "${command}": it has no backend route.`,
      );
    }
    if (route.stream === true) {
      throw new Error(
        `Cannot register a plain handler for "${command}": it is a reserved stream route served by the stream adapter.`,
      );
    }
    if (this.handlers.has(command)) {
      throw new Error(`A handler is already registered for "${command}".`);
    }
    this.handlers.set(command, handler);
  }

  unregister(command: string): boolean {
    return this.handlers.delete(command);
  }

  get(command: string): InvokeHandler | undefined {
    return this.handlers.get(command);
  }

  has(command: string): boolean {
    return this.handlers.has(command);
  }

  get size(): number {
    return this.handlers.size;
  }

  commands(): readonly string[] {
    return [...this.handlers.keys()];
  }
}

export function createHandlerRegistry(): HandlerRegistry {
  return new HandlerRegistry();
}
