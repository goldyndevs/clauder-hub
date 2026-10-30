import { spawn } from "node:child_process";
import { KIND_LABEL, truncate } from "./format.js";
import type { ChannelAdapter, ChannelKindInfo, OutboundMessage, SentMessage } from "./types.js";

/**
 * Notifications on the machine the hub runs on, sent by the hub itself as the
 * operating system's own: a Windows toast, macOS Notification Center, or
 * notify-send on Linux. Nothing in the browser is involved, so they arrive with
 * every browser window closed, as long as the hub runs (which sessions need
 * anyway). On Windows a click opens the dashboard at the session.
 *
 * One-way: answers are given in the dashboard or on another channel.
 */
export const deviceInfo: ChannelKindInfo = {
  kind: "device",
  label: "This computer",
  twoWay: false,
  fields: [],
};

const xml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * Shows a toast through the Windows Runtime from PowerShell, under PowerShell's
 * own registered app id (no installer needed). The toast XML travels in an
 * environment variable, never in the command text.
 */
const TOAST_SCRIPT = `
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
$doc = New-Object Windows.Data.Xml.Dom.XmlDocument
$doc.LoadXml($env:CLAUDER_TOAST)
$app = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($app).Show([Windows.UI.Notifications.ToastNotification]::new($doc))
`;

function run(command: string, args: string[], env?: Record<string, string>): Promise<void> {
  return new Promise((resolve, reject) => {
    // Not detached: a detached PowerShell on Windows starts nothing (measured on reveal).
    const child = spawn(command, args, { windowsHide: true, stdio: "ignore", env: env ? { ...process.env, ...env } : process.env });
    child.once("error", (error) => reject(new Error(`Could not show a notification: ${error.message}`)));
    child.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(`The notifier exited with ${code}.`))));
  });
}

export function notify(title: string, body: string, link: string): Promise<void> {
  if (process.platform === "win32") {
    const toast = `<toast activationType="protocol" launch="${xml(link)}"><visual><binding template="ToastGeneric"><text>${xml(title)}</text><text>${xml(body)}</text></binding></visual><actions><action content="Open in Clauder Hub" activationType="protocol" arguments="${xml(link)}"/></actions></toast>`;
    return run("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", TOAST_SCRIPT], { CLAUDER_TOAST: toast });
  }
  if (process.platform === "darwin") {
    // The text goes in as script arguments, so nothing in it is read as AppleScript.
    return run("osascript", ["-e", "on run argv", "-e", "display notification (item 2 of argv) with title (item 1 of argv)", "-e", "end run", title, body]);
  }
  if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) return Promise.reject(new Error("There is no desktop session on this machine to show notifications in."));
  return run("notify-send", ["--app-name=Clauder Hub", title, body]);
}

/** `link` opens the session (or, without one, the project) in the dashboard; the project is named, as several notify on one machine. */
export function createDevice(project: string, link: (sessionId?: string, projectId?: string) => string): ChannelAdapter {
  let state = { ok: true, detail: "Ready." };
  const show = async (title: string, body: string, link: string) => {
    try {
      await notify(truncate(title, 120), truncate(body, 300), link);
      state = { ok: true, detail: "Last notification shown." };
    } catch (error) {
      state = { ok: false, detail: (error as Error).message };
      throw error;
    }
  };
  return {
    async start() {},
    stop() {},
    async send(message: OutboundMessage): Promise<SentMessage | null> {
      const presented = message.presented;
      const kind = KIND_LABEL[message.kind] ?? "Clauder Hub";
      const target = link(message.sessionId && message.sessionId !== "test" ? message.sessionId : undefined, message.projectId);
      if (!presented) await show(`Clauder Hub · ${project}`, message.text, target);
      else await show(`${kind} · ${project} · ${presented.sessionTitle}`, [presented.headline, presented.question].filter(Boolean).join("\n"), target);
      return { ref: message.interactionId };
    },
    // An answer given elsewhere needs no second notification.
    async follow() {},
    status: () => state,
  };
}
