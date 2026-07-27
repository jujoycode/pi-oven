/**
 * read-odt.ts — pi-odt
 *
 * OpenDocument Text(.odt)에서 텍스트를 추출하는 `read_odt` 툴.
 * ODT는 ZIP + content.xml — pi 내장 read는 ZIP이라 못 읽는다.
 *
 * - 제목(text:h)은 outline-level에 따라 마크다운 #으로
 * - 표(table:table)는 행 단위 "| 셀 | 셀 |"로
 * - text:s(공백 압축), text:tab, text:line-break 처리
 * - 암호화 ZIP과 손상 파일(CRC 불일치)은 지원하지 않고 명확한 에러를 낸다
 *
 * 외부 의존성 없음: ZIP 파서 직접 구현 + node:zlib.
 * (2026-07 오픈소스 대체 검토 후 유지 결정 — 근거는 CLAUDE.md 참고)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { crc32, inflateRawSync } from "node:zlib";

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
    const gpFlags = buf.readUInt16LE(pos + 8);
    const method = buf.readUInt16LE(pos + 10);
    const crc = buf.readUInt32LE(pos + 16);
    const compSize = buf.readUInt32LE(pos + 20);
    const nameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    const localOffset = buf.readUInt32LE(pos + 42);
    const name = buf.subarray(pos + 46, pos + 46 + nameLen).toString("utf8");

    if (gpFlags & 0x1) throw new Error(`encrypted zip entry '${name}' — cannot read`);
    if (method !== 0 && method !== 8) {
      throw new Error(`unsupported zip compression method ${method} ('${name}')`);
    }

    const lNameLen = buf.readUInt16LE(localOffset + 26);
    const lExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(dataStart, dataStart + compSize);
    const data = method === 8 ? inflateRawSync(raw) : Buffer.from(raw);
    if (crc32(data) !== crc) throw new Error(`corrupt zip: CRC mismatch ('${name}')`);
    entries.set(name, data);

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

// ---------------------------------------------------------------- 내장 이미지

export interface EmbeddedImage {
  name: string;
  data: Buffer;
}

/** ODT: ZIP의 Pictures/ 항목이 내장 이미지다. */
export function extractOdtImages(buf: Buffer): EmbeddedImage[] {
  const entries = readZip(buf);
  return [...entries]
    .filter(([n]) => n.startsWith("Pictures/"))
    .map(([name, data]) => ({ name, data }));
}

/**
 * 이미지들을 툴 결과로 변환한다:
 * - 기본은 임시 파일로 풀어 경로만 나열 — 이미지 토큰을 매 턴 지불하지 않는다
 * - attach(images: true)면 png/jpg/gif/webp를 ImageContent로 첨부 (개수·크기 상한)
 */
const ATTACH_LIMIT = 8;
const ATTACH_MAX_BYTES = 4 * 1024 * 1024;
const ATTACH_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

export function imagesToResult(
  tempPrefix: string,
  images: EmbeddedImage[],
  attach: boolean,
): { note: string; blocks: { type: "image"; data: string; mimeType: string }[]; paths: string[] } {
  if (images.length === 0) return { note: "", blocks: [], paths: [] };

  const dir = mkdtempSync(join(tmpdir(), tempPrefix));
  const blocks: { type: "image"; data: string; mimeType: string }[] = [];
  const lines: string[] = [];
  const paths: string[] = [];

  for (const img of images) {
    const p = join(dir, basename(img.name));
    writeFileSync(p, img.data);
    paths.push(p);

    const ext = img.name.split(".").pop()?.toLowerCase() ?? "";
    const mime = ATTACH_MIME[ext];
    const attached =
      attach && mime !== undefined && img.data.length <= ATTACH_MAX_BYTES && blocks.length < ATTACH_LIMIT;
    if (attached) blocks.push({ type: "image", data: img.data.toString("base64"), mimeType: mime });
    lines.push(`- ${p} (${Math.max(1, Math.round(img.data.length / 1024))}KB${attached ? ", attached below" : ""})`);
  }

  const note =
    `\n\n[embedded images: ${images.length}` +
    (blocks.length > 0 ? `, ${blocks.length} attached below` : "") +
    (blocks.length < images.length
      ? attach
        ? "; the rest are available at the listed paths"
        : "; call again with images: true to view them"
      : "") +
    "]\n" +
    lines.join("\n");
  return { note, blocks, paths };
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
        "Always use read_odt for OpenDocument text files. " +
        "If the result lists embedded images and their content matters — scanned pages, " +
        "charts, or a document with little extractable text — call read_odt again with " +
        "images: true to view them.",
    ],
    parameters: Type.Object({
      path: Type.String({ description: "Path to the .odt file" }),
      images: Type.Optional(
        Type.Boolean({
          description:
            "Attach embedded images to the result for vision (default false — only paths are listed)",
        }),
      ),
    }),

    async execute(_toolCallId, params) {
      const buf = readFileSync(params.path);
      if (buf.readUInt32LE(0) !== 0x04034b50) {
        throw new Error(`${params.path}: not an ODT file (not a ZIP archive)`);
      }
      let text = extractOdt(buf);

      const truncated = text.length > MAX_CHARS;
      if (truncated) text = text.slice(0, MAX_CHARS);
      const { note, blocks, paths } = imagesToResult("pi-odt-", extractOdtImages(buf), params.images === true);

      return {
        content: [
          {
            type: "text" as const,
            text:
              (text || "(document contains no extractable text)") +
              (truncated ? `\n\n[truncated at ${MAX_CHARS} chars]` : "") +
              note,
          },
          ...blocks,
        ],
        details: { path: params.path, chars: text.length, truncated, imagePaths: paths },
      };
    },
  });
}
