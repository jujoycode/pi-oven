/**
 * read-odt.ts — pi-odt
 *
 * OpenDocument Text(.odt)에서 텍스트를 추출하는 `read_odt` 툴.
 * ODT는 ZIP + content.xml — pi 내장 read는 ZIP이라 못 읽는다.
 *
 * - 제목(text:h)은 outline-level에 따라 마크다운 #으로
 * - 표(table:table)는 행 단위 "| 셀 | 셀 |"로
 * - text:s(공백 압축), text:tab, text:line-break 처리
 *
 * 외부 의존성 없음: ZIP 파서 직접 구현 + node:zlib.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readFileSync } from "node:fs";
import { inflateRawSync } from "node:zlib";

// ---------------------------------------------------------------- ZIP

/** 최소 ZIP 리더: central directory를 걷어 entry 이름 → 데이터 맵을 만든다. */
export function readZip(buf: Buffer): Map<string, Buffer> {
  let eocd = -1;
  const scanFrom = Math.max(0, buf.length - 65557);
  for (let i = buf.length - 22; i >= scanFrom; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a zip file (no end-of-central-directory)");

  const count = buf.readUInt16LE(eocd + 10);
  let pos = buf.readUInt32LE(eocd + 16);
  const entries = new Map<string, Buffer>();

  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(pos) !== 0x02014b50) break;
    const method = buf.readUInt16LE(pos + 10);
    const compSize = buf.readUInt32LE(pos + 20);
    const nameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    const localOffset = buf.readUInt32LE(pos + 42);
    const name = buf.subarray(pos + 46, pos + 46 + nameLen).toString("utf8");

    const lNameLen = buf.readUInt16LE(localOffset + 26);
    const lExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(dataStart, dataStart + compSize);
    entries.set(name, method === 8 ? inflateRawSync(raw) : Buffer.from(raw));

    pos += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

// ---------------------------------------------------------------- ODT 텍스트 추출

const XML_ENTITIES: Record<string, string> = {
  lt: "<", gt: ">", amp: "&", quot: '"', apos: "'",
};

export function decodeXmlEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-z]+);/g, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return XML_ENTITIES[e] ?? m;
  });
}

/** 문단/제목 내부 마크업을 평문으로: 공백류 태그를 풀고 나머지 태그는 벗긴다. */
function inlineText(xml: string): string {
  return decodeXmlEntities(
    xml
      .replace(/<text:s(?:\s[^>]*?c="(\d+)")?[^>]*\/>/g, (_, c) => " ".repeat(c ? Number(c) : 1))
      .replace(/<text:tab[^>]*\/>/g, "\t")
      .replace(/<text:line-break[^>]*\/>/g, "\n")
      .replace(/<[^>]*>/g, ""),
  );
}

export function extractOdt(buf: Buffer): string {
  const entries = readZip(buf);
  const content = entries.get("content.xml");
  if (!content) throw new Error("no content.xml — not an ODT document?");
  const xml = content.toString("utf8");

  const lines: string[] = [];
  let row: string[] | null = null;

  // 문단·제목·표 경계를 문서 순서대로 걷는다
  const token =
    /<text:h(?:\s[^>]*?text:outline-level="(\d+)")?[^>]*>([\s\S]*?)<\/text:h>|<text:p(?:\s[^>]*)?>([\s\S]*?)<\/text:p>|<text:p[^>]*\/>|<table:table-row[\s>]|<\/table:table-row>|<table:table-cell[\s>]|<table:table-cell[^>]*\/>/g;
  let m: RegExpExecArray | null;
  while ((m = token.exec(xml)) !== null) {
    const tag = m[0];
    if (tag.startsWith("<text:h")) {
      const level = Math.min(Number(m[1] ?? 1), 6);
      lines.push("#".repeat(level) + " " + inlineText(m[2]));
    } else if (tag.startsWith("<text:p")) {
      const text = m[3] !== undefined ? inlineText(m[3]) : "";
      if (row) {
        // 표 셀 안의 문단: 마지막 셀에 이어붙인다
        row[row.length - 1] = (row[row.length - 1] + " " + text).trim();
      } else {
        lines.push(text);
      }
    } else if (tag.startsWith("<table:table-row")) {
      row = [];
    } else if (tag === "</table:table-row>") {
      if (row) lines.push("| " + row.join(" | ") + " |");
      row = null;
    } else if (tag.startsWith("<table:table-cell")) {
      if (row) row.push("");
    }
  }

  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

// ---------------------------------------------------------------- 툴 등록

const MAX_CHARS = 200_000;

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "read_odt",
    label: "Read ODT",
    description:
      "Read an OpenDocument Text (.odt) file and return its text content — " +
      "headings, paragraphs, lists, and tables. " +
      "Use this instead of the built-in read tool for .odt files.",
    promptSnippet: "Read OpenDocument .odt files",
    promptGuidelines: [
      "The built-in read tool cannot parse .odt files (they are ZIP archives). " +
        "Always use read_odt for OpenDocument text files.",
    ],
    parameters: Type.Object({
      path: Type.String({ description: "Path to the .odt file" }),
    }),

    async execute(_toolCallId, params) {
      const buf = readFileSync(params.path);
      if (buf.readUInt32LE(0) !== 0x04034b50) {
        throw new Error(`${params.path}: not an ODT file (not a ZIP archive)`);
      }
      let text = extractOdt(buf);

      const truncated = text.length > MAX_CHARS;
      if (truncated) text = text.slice(0, MAX_CHARS);

      return {
        content: [
          {
            type: "text" as const,
            text:
              (text || "(document contains no extractable text)") +
              (truncated ? `\n\n[truncated at ${MAX_CHARS} chars]` : ""),
          },
        ],
        details: { path: params.path, chars: text.length, truncated },
      };
    },
  });
}
