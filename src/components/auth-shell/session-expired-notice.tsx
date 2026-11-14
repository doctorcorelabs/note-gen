// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
"use client";

import { useEffect, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { authText } from "./messages";

// Visible state for an ended session, per desain-auth.md section 3.7:
// "The session is invalid or has ended. Please sign in again." This
// component holds no session logic. It only renders the state.
//
// SessionExpiredNotice is presentational: wave 3 wiring decides when it
// shows (for example after a 401 from an authenticated request) and
// passes visible explicitly. SessionExpiredBanner is the shell-only
// convenience wrapper used on the login page: it reads the query string
// on the client after mount (?reason=session-expired) because the app
// is a static export and the page cannot read search params on the
// server. Wave 3 may keep or replace the banner mechanism.
export function SessionExpiredNotice({ visible = true }: { visible?: boolean }) {
  if (!visible) return null;
  return (
    <Alert role="status" aria-live="polite">
      <AlertTitle>{authText("sessionExpiredTitle")}</AlertTitle>
      <AlertDescription>{authText("sessionExpiredDescription")}</AlertDescription>
    </Alert>
  );
}

export function SessionExpiredBanner() {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const reason = new URLSearchParams(window.location.search).get("reason");
    setVisible(reason === "session-expired");
  }, []);
  return <SessionExpiredNotice visible={visible} />;
}
