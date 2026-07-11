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
 * 외부 의존성 없음: ZIP 파서와 DEFLATE 해제까지 전부 순수 TS.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readFileSync } from "node:fs";

// ------------------------------------------------- DEFLATE 해제 (RFC 1951)
// node:zlib(네이티브) 대신 순수 TS 구현. puff.c의 canonical Huffman
// 디코딩 방식을 따른다. 정확성은 실물 파일에서 zlib과 바이트 일치로 검증됨.

const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const CLC_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

/** 코드 길이 배열로 만든 canonical Huffman 테이블. */
class Huffman {
  counts = new Array<number>(16).fill(0);
  symbols: number[] = [];

  constructor(lengths: number[]) {
    for (const l of lengths) this.counts[l]++;
    this.counts[0] = 0;
    const offs = new Array<number>(16).fill(0);
    for (let i = 1; i < 15; i++) offs[i + 1] = offs[i] + this.counts[i];
    lengths.forEach((l, sym) => {
      if (l) this.symbols[offs[l]++] = sym;
    });
  }
}

class Inflater {
  private pos = 0;
  private bitBuf = 0;
  private bitCnt = 0;
  private out: Uint8Array = new Uint8Array(64 * 1024);
  private outLen = 0;

  private input: Buffer;

  constructor(input: Buffer) {
    this.input = input;
  }

  private bits(n: number): number {
    while (this.bitCnt < n) {
      if (this.pos >= this.input.length) throw new Error("deflate: unexpected end of input");
      this.bitBuf |= this.input[this.pos++] << this.bitCnt;
      this.bitCnt += 8;
    }
    const v = this.bitBuf & ((1 << n) - 1);
    this.bitBuf >>>= n;
    this.bitCnt -= n;
    return v;
  }

  private decode(h: Huffman): number {
    let code = 0;
    let first = 0;
    let index = 0;
    for (let len = 1; len <= 15; len++) {
      code |= this.bits(1);
      const count = h.counts[len];
      if (code - first < count) return h.symbols[index + (code - first)];
      index += count;
      first = (first + count) << 1;
      code <<= 1;
    }
    throw new Error("deflate: invalid huffman code");
  }

  private push(byte: number): void {
    if (this.outLen === this.out.length) {
      const bigger = new Uint8Array(this.out.length * 2);
      bigger.set(this.out);
      this.out = bigger;
    }
    this.out[this.outLen++] = byte;
  }

  run(): Buffer {
    let final = 0;
    do {
      final = this.bits(1);
      const type = this.bits(2);

      if (type === 0) {
        // stored 블록: 바이트 경계 정렬 후 그대로 복사
        this.bitBuf = 0;
        this.bitCnt = 0;
        const len = this.input.readUInt16LE(this.pos);
        this.pos += 4; // LEN + NLEN
        for (let i = 0; i < len; i++) this.push(this.input[this.pos++]);
        continue;
      }

      let lit: Huffman;
      let dist: Huffman;
      if (type === 1) {
        // 고정 테이블
        const litLens = new Array<number>(288);
        for (let i = 0; i < 288; i++) litLens[i] = i < 144 ? 8 : i < 256 ? 9 : i < 280 ? 7 : 8;
        lit = new Huffman(litLens);
        dist = new Huffman(new Array<number>(30).fill(5));
      } else if (type === 2) {
        // 동적 테이블
        const hlit = this.bits(5) + 257;
        const hdist = this.bits(5) + 1;
        const hclen = this.bits(4) + 4;
        const clcLens = new Array<number>(19).fill(0);
        for (let i = 0; i < hclen; i++) clcLens[CLC_ORDER[i]] = this.bits(3);
        const clc = new Huffman(clcLens);

        const lens: number[] = [];
        while (lens.length < hlit + hdist) {
          const sym = this.decode(clc);
          if (sym < 16) lens.push(sym);
          else if (sym === 16) {
            const prev = lens[lens.length - 1];
            for (let r = this.bits(2) + 3; r > 0; r--) lens.push(prev);
          } else if (sym === 17) {
            for (let r = this.bits(3) + 3; r > 0; r--) lens.push(0);
          } else {
            for (let r = this.bits(7) + 11; r > 0; r--) lens.push(0);
          }
        }
        lit = new Huffman(lens.slice(0, hlit));
        dist = new Huffman(lens.slice(hlit));
      } else {
        throw new Error("deflate: invalid block type");
      }

      for (;;) {
        const sym = this.decode(lit);
        if (sym < 256) {
          this.push(sym);
        } else if (sym === 256) {
          break;
        } else {
          const len = LEN_BASE[sym - 257] + this.bits(LEN_EXTRA[sym - 257]);
          const dSym = this.decode(dist);
          const distance = DIST_BASE[dSym] + this.bits(DIST_EXTRA[dSym]);
          let from = this.outLen - distance;
          if (from < 0) throw new Error("deflate: distance too far back");
          for (let i = 0; i < len; i++) this.push(this.out[from++]);
        }
      }
    } while (!final);

    return Buffer.from(this.out.subarray(0, this.outLen));
  }
}

/** raw DEFLATE 스트림 해제 (zlib 헤더 없음). */
export function inflateRaw(input: Buffer): Buffer {
  return new Inflater(input).run();
}


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
    entries.set(name, method === 8 ? inflateRaw(raw) : Buffer.from(raw));

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
