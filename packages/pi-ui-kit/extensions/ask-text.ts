/**
 * ask-text.ts — pi-ui-kit
 *
 * 에이전트가 사용자에게 짧은 자유 텍스트 답변을 받을 때 쓰는 `ask_text` 툴.
 * Pi 내장 input 프롬프트를 사용하므로 IME(한글 입력) 커서 처리도 내장 동작을 따른다.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "ask_text",
    label: "Ask Text",
    description:
      "Ask the user a question that needs a short free-form text answer " +
      "(a name, a path, a value, a one-line description). " +
      "Shows an input prompt in the terminal and returns what the user typed.",
    promptSnippet: "Ask the user for a short free-form text answer",
    promptGuidelines: [
      "Use ask_text when you need a value only the user knows (names, paths, versions, API endpoints). " +
        "For choosing between known options, use ask_user instead.",
    ],
    parameters: Type.Object({
      question: Type.String({ description: "The question to show the user" }),
      placeholder: Type.Optional(
        Type.String({ description: "Optional placeholder / example value" }),
      ),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const answer = await ctx.ui.input(params.question, params.placeholder);

      if (answer == null) {
        return {
          content: [
            {
              type: "text" as const,
              text: "User cancelled the input. Proceed with a sensible default or ask differently.",
            },
          ],
          details: { question: params.question, answer: null },
        };
      }

      return {
        content: [
          { type: "text" as const, text: `User answered: "${answer}"` },
        ],
        details: { question: params.question, answer },
      };
    },
  });
}
