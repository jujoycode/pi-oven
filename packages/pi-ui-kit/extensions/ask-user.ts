/**
 * ask-user.ts — pi-ui-kit
 *
 * Claude Code 스타일 선택 UI:
 *   ╭─ Question ─────────────────────╮
 *   │  ❯ 1. Option A                 │
 *   │       dimmed description       │
 *   │    2. Option B                 │
 *   ╰────────────────────────────────╯
 *     ↑/↓ move · 1-9 select · enter confirm · esc cancel
 *
 * - mode "single": ↑↓ 이동, 숫자키 즉시 선택, enter 확정
 * - mode "multi" : space/숫자키 토글(◼/◻), enter 확정
 */

import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

interface Option {
  label: string;
  description?: string;
}

/** Claude Code 스타일 라운드 박스 선택기 (단일/다중 겸용) */
class ClaudeSelect {
  private cursor = 0;
  private checked: boolean[];

  public onDone?: (result: string[] | null) => void;

  constructor(
    private question: string,
    private options: Option[],
    private mode: "single" | "multi",
    private theme: Theme,
  ) {
    this.checked = options.map(() => false);
  }

  private confirm(): void {
    if (this.mode === "single") {
      this.onDone?.([this.options[this.cursor].label]);
    } else {
      this.onDone?.(
        this.options.filter((_, i) => this.checked[i]).map((o) => o.label),
      );
    }
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.up)) {
      this.cursor = (this.cursor - 1 + this.options.length) % this.options.length;
    } else if (matchesKey(data, Key.down)) {
      this.cursor = (this.cursor + 1) % this.options.length;
    } else if (matchesKey(data, Key.enter)) {
      this.confirm();
    } else if (matchesKey(data, Key.escape)) {
      this.onDone?.(null);
    } else if (this.mode === "multi" && matchesKey(data, Key.space)) {
      this.checked[this.cursor] = !this.checked[this.cursor];
    } else if (/^[1-9]$/.test(data)) {
      const idx = Number(data) - 1;
      if (idx < this.options.length) {
        this.cursor = idx;
        if (this.mode === "single") {
          this.confirm(); // Claude Code처럼 숫자키는 즉시 선택
        } else {
          this.checked[idx] = !this.checked[idx];
        }
      }
    }
  }

  render(width: number): string[] {
    const t = this.theme;
    const border = (s: string) => t.fg("dim", s);

    // 박스 폭 = 마커/번호 오프셋(단일 7, 다중 9) + 가장 긴 텍스트
    const offset = this.mode === "multi" ? 9 : 7;
    const widths = this.options.flatMap((o) => [o.label, o.description ?? ""]).map(visibleWidth);
    const contentW = offset + Math.max(...widths, visibleWidth(this.question) - offset);
    const innerW = Math.min(Math.max(contentW + 2, 30), width - 4);

    const boxLine = (content: string, activeBg: boolean): string => {
      const clipped = truncateToWidth(content, innerW);
      const pad = Math.max(0, innerW - visibleWidth(clipped));
      const body = clipped + " ".repeat(pad);
      return (
        " " +
        border("│") +
        (activeBg ? t.bg("selectedBg", body) : body) +
        border("│")
      );
    };

    const lines: string[] = [];

    // 질문: 박스 밖 독립 라인 (✻ 마커 + 볼드)
    lines.push(
      " " + t.fg("accent", "✻") + " " + t.bold(truncateToWidth(this.question, width - 4)),
    );
    lines.push("");

    // ╭───╮ 컴팩트 박스
    lines.push(" " + border("╭" + "─".repeat(innerW) + "╮"));

    this.options.forEach((opt, i) => {
      const active = i === this.cursor;
      const num = t.fg("dim", `${i + 1}.`);

      let marker: string;
      if (this.mode === "multi") {
        marker = this.checked[i] ? t.fg("accent", "◼") : t.fg("dim", "◻");
        marker = marker + " ";
      } else {
        marker = "";
      }

      const caret = active ? t.fg("accent", "❯") : " ";
      const label = active ? t.bold(t.fg("accent", opt.label)) : opt.label;
      lines.push(boxLine(` ${caret} ${marker}${num} ${label}`, active));

      if (opt.description) {
        const indent = this.mode === "multi" ? "        " : "      ";
        lines.push(boxLine(`${indent}${t.fg("dim", opt.description)}`, active));
      }
    });

    lines.push(" " + border("╰" + "─".repeat(innerW) + "╯"));

    // footer hint: 박스 밖, 흐리게
    const hint =
      this.mode === "single"
        ? "enter confirm · ↑/↓ move · 1-9 quick select · esc cancel"
        : "space toggle · enter confirm · ↑/↓ move · esc cancel";
    lines.push("   " + t.fg("dim", hint));

    return lines;
  }

}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "ask_user",
    label: "Ask User",
    description:
      "Ask the user a question with a list of options rendered as an interactive picker. " +
      "Use mode 'single' for choosing exactly one option, 'multi' for checkboxes (zero or more). " +
      "Returns the user's selection.",
    promptSnippet:
      "Ask the user to pick between options via an interactive terminal UI",
    promptGuidelines: [
      "Use ask_user whenever you need the user to decide between concrete options " +
        "(e.g. which approach, which file, which features to include). " +
        "Do NOT ask such questions as plain text; call ask_user instead.",
      "Keep ask_user option labels short; put extra context in description.",
    ],
    parameters: Type.Object({
      question: Type.String({ description: "The question to show above the options" }),
      mode: StringEnum(["single", "multi"] as const),
      options: Type.Array(
        Type.Object({
          label: Type.String({ description: "Short option label" }),
          description: Type.Optional(
            Type.String({ description: "Optional one-line explanation" }),
          ),
        }),
        { minItems: 2, description: "The options the user can choose from" },
      ),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const { question, mode, options } = params;

      const result = await ctx.ui.custom<string[] | null>(
        (tui, theme, _kb, done) => {
          const select = new ClaudeSelect(question, options, mode, theme);
          select.onDone = (r) => done(r);
          return {
            render: (w: number) => select.render(w),
            invalidate: () => {},
            handleInput: (data: string) => {
              select.handleInput(data);
              tui.requestRender();
            },
          };
        },
      );

      const text =
        result === null
          ? "User cancelled the selection (esc). Ask differently or proceed with defaults."
          : result.length === 0
            ? "User confirmed with no options selected."
            : mode === "single"
              ? `User selected: "${result[0]}"`
              : `User selected: ${result.map((r) => `"${r}"`).join(", ")}`;

      return {
        content: [{ type: "text" as const, text }],
        details: { question, mode, selected: result },
      };
    },
  });
}
