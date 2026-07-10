/**
 * pai.ts — pi-ui-kit
 *
 * pi-oven 마스코트 Pai. 세션이 시작되면 채팅 맨 위 헤더에서 마중 나온다
 * (Claude Code의 시작 배너처럼, 커맨드 없이 항상 표시).
 * 헤더가 보이면 확장이 로드된 것이다.
 *
 *      °  o
 *    ╭◠◠◠◠◠◠◠╮
 *    │ ◕ ᵕ ◕ │   pi-ui-kit · baked fresh in the pi-oven
 *    ╰───────╯
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    ctx.ui.setHeader((_tui, theme) => ({
      render: () => {
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
      },
      invalidate: () => {},
    }));
  });
}
