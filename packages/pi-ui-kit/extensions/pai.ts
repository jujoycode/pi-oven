/**
 * pai.ts — pi-ui-kit
 *
 * pi-oven 마스코트 Pai. 세션이 시작되면 채팅 맨 위 헤더에서 마중 나온다
 * (Claude Code의 시작 배너처럼, 커맨드 없이 항상 표시).
 *
 *      °  o
 *    ╭◠◠◠◠◠◠◠╮
 *    │ ◕ ᵕ ◕ │   pi-ui-kit · baked fresh in the pi-oven
 *    ╰───────╯
 *
 * /pai 커맨드로도 아무 때나 불러낼 수 있다 (로드 확인용).
 */

import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";

function paiLines(theme: Theme): string[] {
  const dim = (s: string) => theme.fg("dim", s);
  const crust = (s: string) => theme.fg("accent", s);
  return [
    dim("      °  o"),
    "    " + crust("╭◠◠◠◠◠◠◠╮"),
    "    " + crust("│") + " ◕ ᵕ ◕ " + crust("│") + "   " +
      theme.bold("pi-ui-kit") + dim(" · baked fresh in the pi-oven"),
    "    " + crust("╰───────╯"),
    "",
  ];
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    ctx.ui.setHeader((_tui, theme) => ({
      render: () => paiLines(theme),
      invalidate: () => {},
    }));
  });

  // /pai — 로드 확인 겸 Pai 소환 (아무 키나 누르면 닫힘)
  pi.registerCommand("pai", {
    description: "Meet Pai, the pi-oven mascot",
    handler: async (_args, ctx) => {
      await ctx.ui.custom<null>((tui, theme, _kb, done) => ({
        render: () => ["", ...paiLines(theme), "    " + theme.fg("dim", "press any key")],
        invalidate: () => {},
        handleInput: () => {
          done(null);
          tui.requestRender();
        },
      }));
    },
  });
}
