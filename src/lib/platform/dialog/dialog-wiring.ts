// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

/**
 * DialogService wiring (N-10, V3-11 expanded scope, AD-33).
 *
 * This module connects the DialogService seam of the web dialog adapter
 * (see `interface.ts` and `dialog.web.ts`) to the centralized in-app
 * dialog host (M15 `WebDialogHost`, in `src/components/web-chrome/`).
 * It supplies the service implementation and the wired adapter factory;
 * it does not register anything in the platform registry. Registry
 * registration belongs to the single registry wiring module owned by
 * V3-11 (N-1), which registers the adapter returned by
 * `createWiredWebDialogAdapter` or installs the service with
 * `installHostDialogService` at boot. This module never calls
 * `registerPlatformAdapter` and never touches `registry.ts`.
 *
 * The host is reached through the structural `DialogHostPort`, the
 * promise-based subset of `WebDialogApi` this wiring needs.
 * `WebDialogApi` satisfies the port without this module importing any
 * React or UI code, which keeps the platform-to-UI dependency
 * direction intact (see `desain-registry-shim.md` section 2.3). The
 * wiring spec pins the assignability at compile time with a type-only
 * import.
 *
 * The service delegates every method to the host and returns exactly
 * what the host resolves: confirm/ask resolve true only when the user
 * presses the confirm button, message resolves on dismissal, and
 * prompt resolves the entered text or null on cancel. Option objects
 * pass through unchanged; the host owns title defaulting and button
 * labels. The service never invents an answer.
 *
 * Path-shaped open/save (D-01): this wiring does not reimplement the
 * rejection. The wired adapter delegates to `createWebDialogAdapter`,
 * whose `open` and `save` reject with an `unsupported`
 * PlatformCapabilityError pointing at `openFiles` and `saveBlob`.
 * The wiring spec pins that rejection through the wired adapter, so a
 * future change that weakened it would fail here. `mailto:` is not
 * restored: dialog wiring opens no URLs at all; URL schemes belong to
 * the opener adapter, which rejects `mailto:`.
 *
 * No method in this module falls back to `window.confirm`,
 * `window.alert`, or `window.prompt`. A missing host is an explicit
 * PlatformCapabilityError from the adapter, never a silent native
 * popup (see the throw-without-host cases in the wiring spec).
 *
 * History: the host gaps GAP-1 to GAP-4 documented here before
 * (fire-and-forget host with no promise, no answer, no input, and no
 * React glue) are closed by the host resolution seam in
 * `web-dialog.tsx` plus the install-on-mount glue in `WebDialogHost`
 * (r24-dialog1b). The honest interim semantics that the wiring used
 * to pin (message resolves once presented; confirm/ask present and
 * then reject; prompt rejects without presenting) no longer apply:
 * the spec now pins real resolution through the host. If the host
 * ever loses its resolution seam, this wiring and its spec must be
 * updated together; do not weaken the assertions silently.
 *
 * Glue and timing: the host API only exists inside
 * `WebDialogProvider`, via the `useWebDialog` hook, after React
 * renders. `WebDialogHost` installs the service on mount, so the
 * service is present once either shell (core or mobile) mounts its
 * host. Late installation works for adapters created without an
 * explicit service because `dialog.web.ts` reads the module default
 * at call time, not at factory time. Dialog calls made before any
 * host mounts (routes outside the core and mobile shells, boot code)
 * keep throwing the documented unavailable error, exactly as before.
 */

import {
  createWebDialogAdapter,
  setDefaultDialogService,
} from "./dialog.web";
import type {
  ConfirmDialogOptions,
  DialogAdapter,
  DialogService,
  MessageDialogOptions,
  PromptDialogOptions,
} from "./interface";

/**
 * Minimal host-facing port: the promise-based subset of the web dialog
 * host API this wiring calls. `WebDialogApi` (from `web-dialog.tsx`)
 * satisfies this shape structurally; see the wiring spec for the
 * compile-time proof. Only the four promise methods are needed: the
 * host owns rendering, queuing, dismissal, and the buttons.
 */
export interface DialogHostPort {
  confirmDialog(
    message: string,
    options?: string | ConfirmDialogOptions,
  ): Promise<boolean>;
  askDialog(
    message: string,
    options?: string | ConfirmDialogOptions,
  ): Promise<boolean>;
  messageDialog(
    message: string,
    options?: string | MessageDialogOptions,
  ): Promise<void>;
  promptDialog(
    message: string,
    options?: string | PromptDialogOptions,
  ): Promise<string | null>;
}

function requireHostPort(host: DialogHostPort): DialogHostPort {
  if (
    host === null ||
    host === undefined ||
    typeof (host as DialogHostPort).confirmDialog !== "function" ||
    typeof (host as DialogHostPort).askDialog !== "function" ||
    typeof (host as DialogHostPort).messageDialog !== "function" ||
    typeof (host as DialogHostPort).promptDialog !== "function"
  ) {
    throw new TypeError(
      "createHostDialogService requires a dialog host with confirmDialog, askDialog, messageDialog, and promptDialog functions.",
    );
  }
  return host;
}

/**
 * Build a DialogService that presents through the given host.
 *
 * Every method delegates to the matching host promise method and
 * returns the host resolution unchanged. Errors thrown by the host
 * itself propagate unchanged.
 */
export function createHostDialogService(
  host: DialogHostPort,
): DialogService {
  const port = requireHostPort(host);
  return {
    async confirm(
      message: string,
      options?: string | ConfirmDialogOptions,
    ): Promise<boolean> {
      return port.confirmDialog(message, options);
    },

    async ask(
      message: string,
      options?: string | ConfirmDialogOptions,
    ): Promise<boolean> {
      return port.askDialog(message, options);
    },

    async message(
      message: string,
      options?: string | MessageDialogOptions,
    ): Promise<void> {
      await port.messageDialog(message, options);
    },

    async prompt(
      message: string,
      options?: string | PromptDialogOptions,
    ): Promise<string | null> {
      return port.promptDialog(message, options);
    },
  };
}

/**
 * Install the host-backed service as the module default read by
 * adapters created without an explicit service (see `dialog.web.ts`).
 * Returns the installed service. Passing `undefined` clears the
 * default, restoring the throw-without-host behavior. `WebDialogHost`
 * calls this once on mount; it is safe to call again with a new host,
 * which replaces the previous service.
 */
export function installHostDialogService(
  host: DialogHostPort | undefined,
): DialogService | undefined {
  if (host === undefined) {
    setDefaultDialogService(undefined);
    return undefined;
  }
  const service = createHostDialogService(host);
  setDefaultDialogService(service);
  return service;
}

/**
 * Create a web dialog adapter wired to the given host.
 *
 * The adapter delegates confirm/ask/message/prompt to the
 * host-backed service and keeps the content-shaped openFiles/saveBlob
 * flows of `dialog.web.ts`. Path-shaped open/save reject as
 * unsupported per D-01, exactly as the unwired adapter rejects them.
 * The registry wiring registers the returned adapter as `dialog`.
 */
export function createWiredWebDialogAdapter(
  host: DialogHostPort,
): DialogAdapter {
  return createWebDialogAdapter({
    dialogService: createHostDialogService(host),
  });
}
