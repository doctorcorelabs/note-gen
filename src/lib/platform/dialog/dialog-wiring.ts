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
 * subset of `WebDialogApi` this wiring needs. `WebDialogApi` satisfies
 * the port without this module importing any React or UI code, which
 * keeps the platform-to-UI dependency direction intact (see
 * `desain-registry-shim.md` section 2.3). The wiring spec pins the
 * assignability at compile time with a type-only import.
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
 * INTEGRATOR NOTE: exact host gaps. The current host
 * (`web-dialog.tsx`) offers only a fire-and-forget `openDialog` plus a
 * single Close button. It has no promise, no answer, no input, and no
 * dismissal signal. The service below is honest about that boundary
 * instead of fabricating answers. Do not "fix" these gaps inside this
 * module by inventing return values; each gap needs a host change
 * under its own decision (the merge plan records that WebDialogHost
 * behavior must not change without a decision).
 *
 * GAP-1 (message resolution): `message` resolves once the host has
 * been asked to present the dialog, not when the user dismisses it.
 * The host exposes no dismissal callback or subscription, and the
 * `WebDialogApi` snapshot handed to this wiring never updates, so
 * awaiting dismissal is impossible without a host change. Callers
 * awaiting `message` proceed while the dialog may still be visible.
 *
 * GAP-2 (confirm/ask resolution, kind, labels): the host renders no
 * confirm/cancel buttons and returns no answer, so `confirm` and
 * `ask` cannot produce the boolean the interface promises. They
 * present the question through the host and then reject with an
 * `unavailable` PlatformCapabilityError naming the missing seam.
 * Returning a fixed true or false would fabricate the user's answer
 * and is forbidden. Likewise `kind`, `okLabel`, and `cancelLabel`
 * are accepted per the interface but not rendered: the host has no
 * field for them, and this wiring does not rewrite the caller's
 * title or message to encode them.
 *
 * GAP-3 (prompt input): the host renders no text input, so `prompt`
 * cannot collect text. It rejects with an `unavailable`
 * PlatformCapabilityError without presenting anything: showing an
 * unanswerable question would mislead the user.
 *
 * GAP-4 (React glue and timing): the host API only exists inside
 * `WebDialogProvider`, via the `useWebDialog` hook, after React
 * renders. Nothing in this module can obtain it at boot time, and
 * this module adds no React glue. The integrator still needs a small
 * client component inside the provider that calls
 * `installHostDialogService(api)` on mount (or passes the API to
 * the registry wiring). Late installation works for adapters
 * created without an explicit service because `dialog.web.ts`
 * reads the module default at call time, not at factory time.
 * Until that glue lands, dialog methods keep throwing exactly as
 * they do today, which is the documented behavior, not a bug.
 *
 * Until GAP-2 and GAP-3 close, E2E dialog tests must encode the
 * behavior pinned here (present-then-reject for confirm/ask,
 * reject for prompt), not expect booleans or typed text.
 */

import { capabilityError } from "../errors";
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

/** Fallback dialog title when the caller supplies none (the app name). */
const DEFAULT_DIALOG_TITLE = "NoteGen";

/**
 * Minimal host-facing port: the subset of the web dialog host API
 * this wiring calls. `WebDialogApi` (from `web-dialog.tsx`) satisfies
 * this shape structurally; see the wiring spec for the compile-time
 * proof. Only `openDialog` is needed: the host owns rendering,
 * dismissal, and the Close button.
 */
export interface DialogHostPort {
  openDialog(options: { title: string; description?: string }): void;
}

function resolveTitle(
  options: string | { title?: string } | undefined,
): string {
  if (typeof options === "string") {
    return options.trim() !== "" ? options : DEFAULT_DIALOG_TITLE;
  }
  const title = options?.title;
  return title !== undefined && title.trim() !== ""
    ? title
    : DEFAULT_DIALOG_TITLE;
}

function requireHostPort(host: DialogHostPort): DialogHostPort {
  if (
    host === null ||
    host === undefined ||
    typeof (host as DialogHostPort).openDialog !== "function"
  ) {
    throw new TypeError(
      "createHostDialogService requires a dialog host with an openDialog function.",
    );
  }
  return host;
}

/**
 * Build a DialogService that presents through the given host.
 *
 * `message` presents and resolves once presented (GAP-1).
 * `confirm` and `ask` present and then reject with an `unavailable`
 * PlatformCapabilityError (GAP-2): the host cannot answer.
 * `prompt` rejects with an `unavailable` PlatformCapabilityError
 * without presenting (GAP-3): the host has no text input.
 * Errors thrown by the host itself propagate unchanged.
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
      port.openDialog({
        title: resolveTitle(options),
        description: message,
      });
      throw capabilityError(
        "unavailable",
        "dialog",
        "confirm",
        "web",
        "WebDialogHost has no confirm/cancel resolution seam: it renders a single Close button and returns no answer. The question was presented; the boolean cannot be produced without a host change (dialog-wiring.ts GAP-2).",
      );
    },

    async ask(
      message: string,
      options?: string | ConfirmDialogOptions,
    ): Promise<boolean> {
      port.openDialog({
        title: resolveTitle(options),
        description: message,
      });
      throw capabilityError(
        "unavailable",
        "dialog",
        "ask",
        "web",
        "WebDialogHost has no confirm/cancel resolution seam: it renders a single Close button and returns no answer. The question was presented; the boolean cannot be produced without a host change (dialog-wiring.ts GAP-2).",
      );
    },

    async message(
      message: string,
      options?: string | MessageDialogOptions,
    ): Promise<void> {
      port.openDialog({
        title: resolveTitle(options),
        description: message,
      });
    },

    async prompt(
      message: string,
      options?: string | PromptDialogOptions,
    ): Promise<string | null> {
      void message;
      void options;
      throw capabilityError(
        "unavailable",
        "dialog",
        "prompt",
        "web",
        "WebDialogHost has no text-input seam: it renders no input field, so prompt cannot collect text. Nothing was presented (dialog-wiring.ts GAP-3).",
      );
    },
  };
}

/**
 * Install the host-backed service as the module default read by
 * adapters created without an explicit service (see `dialog.web.ts`).
 * Returns the installed service. Passing `undefined` clears the
 * default, restoring the throw-without-host behavior. The registry
 * wiring or the React glue (GAP-4) calls this once; it is safe to
 * call again with a new host, which replaces the previous service.
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
