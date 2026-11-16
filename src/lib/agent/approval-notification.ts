import { platform } from "@/lib/platform"

interface ApprovalNotification {
  title: string
  body: string
}

async function isAppInBackground() {
  if (typeof window === "undefined") return false
  if (document.visibilityState !== "visible") return true

  try {
    return !(await platform.window.getCurrentWindow().isFocused())
  } catch {
    return false
  }
}

/**
 * Alerts a backgrounded desktop app when an Agent run cannot continue without
 * user confirmation. Failures are intentionally non-blocking for the run.
 */
export async function notifyPendingAgentApproval({ title, body }: ApprovalNotification) {
  if (!(await isAppInBackground())) return

  try {
    const permissionGranted = await platform.notification.isPermissionGranted()

    if (permissionGranted) {
      platform.notification.sendNotification({ title, body })
    }
  } catch (error) {
    console.warn("Unable to send Agent approval notification:", error)
  }
}
