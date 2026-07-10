/**
 * notify-native.ts — pi-ui-kit
 *
 * OS 네이티브 알림(Windows 토스트 등)을 띄우는 `notify_os` 툴.
 * 터미널이 백그라운드에 있어도 보이므로 긴 작업 완료 알림에 적합.
 *
 * 지원 환경:
 * - Windows      : powershell.exe + Windows.UI.Notifications 토스트
 * - WSL          : powershell.exe 호출로 Windows 토스트
 * - macOS        : osascript display notification
 * - Linux (GUI)  : notify-send
 *
 * 외부 npm 의존성 없음 (child_process만 사용).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { spawn } from "node:child_process";
import { release } from "node:os";

function isWSL(): boolean {
  return process.platform === "linux" && /microsoft/i.test(release());
}

/** PowerShell 문자열 리터럴 이스케이프 (작은따옴표는 두 번) */
function psEscape(s: string): string {
  return s.replace(/'/g, "''");
}

function shEscape(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function buildToastScript(title: string, body: string): string {
  return [
    "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null;",
    "$xml = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02);",
    '$texts = $xml.GetElementsByTagName("text");',
    `$texts.Item(0).AppendChild($xml.CreateTextNode('${psEscape(title)}')) | Out-Null;`,
    `$texts.Item(1).AppendChild($xml.CreateTextNode('${psEscape(body)}')) | Out-Null;`,
    "$toast = [Windows.UI.Notifications.ToastNotification]::new($xml);",
    "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('Pi').Show($toast);",
  ].join(" ");
}

/** 플랫폼별 네이티브 알림. 실패해도 throw하지 않고 성공 여부만 반환. */
function notifyNative(title: string, body: string): Promise<boolean> {
  return new Promise((resolve) => {
    let cmd: string;
    let args: string[];

    if (process.platform === "win32" || isWSL()) {
      cmd = "powershell.exe";
      args = [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        buildToastScript(title, body),
      ];
    } else if (process.platform === "darwin") {
      cmd = "osascript";
      args = [
        "-e",
        `display notification "${shEscape(body)}" with title "${shEscape(title)}"`,
      ];
    } else {
      cmd = "notify-send";
      args = [title, body];
    }

    try {
      const proc = spawn(cmd, args, { stdio: "ignore" });
      proc.on("error", () => resolve(false));
      proc.on("exit", (code) => resolve(code === 0));
      // 알림 하나에 5초 이상 걸리면 포기
      setTimeout(() => resolve(false), 5000);
    } catch {
      resolve(false);
    }
  });
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "notify_os",
    label: "OS Notification",
    description:
      "Send a native operating system notification (Windows toast, macOS notification, Linux notify-send). " +
      "Visible even when the terminal is in the background. " +
      "Use for events the user should notice while away: long build/test finished, blocking error, input needed.",
    promptSnippet: "Send a native OS notification visible outside the terminal",
    promptGuidelines: [
      "Use notify_os when finishing a long-running task (>30s) or when user attention is needed " +
        "and they may not be watching the terminal..",
    ],
    parameters: Type.Object({
      title: Type.String({ description: "Notification title (short)" }),
      body: Type.String({ description: "Notification body text (one or two lines)" }),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const ok = await notifyNative(params.title, params.body);

      // 네이티브 실패 시 터미널 토스트로 폴백
      if (!ok) {
        try {
          ctx.ui.notify(`${params.title}: ${params.body}`, "info");
        } catch {
          /* headless 모드 등에서는 무시 */
        }
      }

      return {
        content: [
          {
            type: "text" as const,
            text: ok
              ? `OS notification sent: ${params.title}`
              : "Native notification unavailable on this system; fell back to in-terminal notify.",
          },
        ],
        details: { title: params.title, body: params.body, native: ok },
      };
    },
  });

  // /notify-test — 설치 확인용. OS 알림이 실제로 뜨는지 바로 테스트.
  pi.registerCommand("notify-test", {
    description: "Send a test OS notification",
    handler: async (_args, ctx) => {
      const ok = await notifyNative("Pi", "Native notifications are working 🎉");
      ctx.ui.notify(
        ok ? "OS notification sent — check your notification center" : "Native notification failed on this system",
        ok ? "info" : "warning",
      );
    },
  });
}
