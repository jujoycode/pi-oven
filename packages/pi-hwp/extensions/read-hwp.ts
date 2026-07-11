/**
 * read-hwp.ts — pi-hwp
 *
 * 한글 문서(.hwpx, .hwp 5.x)에서 텍스트를 추출하는 `read_hwp` 툴.
 * pi 내장 read는 이 포맷들을 못 읽는다 (HWPX는 ZIP, HWP는 CFB 바이너리).
 *
 * - HWPX: ZIP + OWPML. Contents/section*.xml의 <hp:t>를 걷는다.
 *   표는 행 단위로 "| 셀 | 셀 |" 형태로 낸다.
 * - HWP 5.x: CFB(Compound File) + BodyText/Section* 레코드 스트림.
 *   HWPTAG_PARA_TEXT(67)의 UTF-16LE 텍스트를 걷고, 제어문자는
 *   종류별 크기(1 또는 8 워드)만큼 건너뛴다.
 * - 암호화/배포용(DRM) 문서는 지원하지 않고 명확한 에러를 낸다.
 *
 * 외부 의존성 없음: ZIP/CFB 파서 직접 구현 + node:zlib.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readFileSync } from "node:fs";
import { inflateRawSync } from "node:zlib";

// ---------------------------------------------------------------- ZIP

/** 최소 ZIP 리더: central directory를 걷어 entry 이름 → 데이터 맵을 만든다. */
export function readZip(buf: Buffer): Map<string, Buffer> {
  // EOCD(0x06054b50)를 뒤에서부터 찾는다 (코멘트 최대 64KB)
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

    // local header의 name/extra 길이는 central과 다를 수 있어 다시 읽는다
    const lNameLen = buf.readUInt16LE(localOffset + 26);
    const lExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(dataStart, dataStart + compSize);
    entries.set(name, method === 8 ? inflateRawSync(raw) : Buffer.from(raw));

    pos += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

// ---------------------------------------------------------------- XML 텍스트 추출

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

/** 태그 내부 텍스트에서 자식 태그를 벗겨내고 엔티티를 푼다. */
function innerText(xml: string): string {
  return decodeXmlEntities(xml.replace(/<[^>]*>/g, ""));
}

/**
 * HWPX section XML 워커. <hp:t>를 모아 문단(</hp:p>)마다 줄을 만든다.
 * 표 안에서는 셀(</hp:tc>) 단위로 모아 행(</hp:tr>)을 "| a | b |"로 낸다.
 */
export function extractHwpxSection(xml: string): string {
  const lines: string[] = [];
  let para = "";
  let tableDepth = 0;
  let cell = "";
  let row: string[] = [];

  const token = /<hp:t(?:\s[^>]*)?>([\s\S]*?)<\/hp:t>|<hp:tbl[\s>]|<\/hp:tbl>|<\/hp:tc>|<\/hp:tr>|<\/hp:p>/g;
  let m: RegExpExecArray | null;
  while ((m = token.exec(xml)) !== null) {
    const tag = m[0];
    if (m[1] !== undefined) {
      const text = innerText(m[1]);
      if (tableDepth > 0) cell += text;
      else para += text;
    } else if (tag.startsWith("<hp:tbl")) {
      tableDepth++;
    } else if (tag === "</hp:tbl>") {
      tableDepth = Math.max(0, tableDepth - 1);
    } else if (tag === "</hp:tc>" && tableDepth > 0) {
      row.push(cell.trim());
      cell = "";
    } else if (tag === "</hp:tr>" && tableDepth > 0) {
      lines.push("| " + row.join(" | ") + " |");
      row = [];
    } else if (tag === "</hp:p>") {
      if (tableDepth > 0) {
        cell += " "; // 셀 내 문단 구분
      } else {
        lines.push(para);
        para = "";
      }
    }
  }
  if (para.trim()) lines.push(para);
  return lines.join("\n");
}

export function extractHwpx(buf: Buffer): string {
  const entries = readZip(buf);
  const sections = [...entries.keys()]
    .filter((n) => /^Contents\/section\d+\.xml$/.test(n))
    .sort((a, b) => Number(a.match(/\d+/)![0]) - Number(b.match(/\d+/)![0]));
  if (sections.length === 0) throw new Error("no Contents/section*.xml — not a HWPX document?");
  return sections
    .map((n) => extractHwpxSection(entries.get(n)!.toString("utf8")))
    .join("\n\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ---------------------------------------------------------------- CFB (Compound File Binary)

const ENDOFCHAIN = 0xfffffffe;

/** 최소 CFB 리더: "경로/스트림이름" → 데이터 맵을 만든다. */
export function readCfb(buf: Buffer): Map<string, Buffer> {
  const sectorSize = 1 << buf.readUInt16LE(30);
  const miniCutoff = buf.readUInt32LE(56);

  // FAT: 헤더 DIFAT 109개 + DIFAT 체인
  const fatSectors: number[] = [];
  for (let i = 0; i < 109; i++) {
    const s = buf.readUInt32LE(76 + i * 4);
    if (s !== 0xffffffff) fatSectors.push(s);
  }
  let difat = buf.readUInt32LE(68);
  while (difat !== ENDOFCHAIN && difat !== 0xffffffff) {
    const base = 512 + difat * sectorSize;
    for (let i = 0; i < sectorSize / 4 - 1; i++) {
      const s = buf.readUInt32LE(base + i * 4);
      if (s !== 0xffffffff) fatSectors.push(s);
    }
    difat = buf.readUInt32LE(base + sectorSize - 4);
  }
  const fat: number[] = [];
  for (const s of fatSectors) {
    const base = 512 + s * sectorSize;
    for (let i = 0; i < sectorSize / 4; i++) fat.push(buf.readUInt32LE(base + i * 4));
  }

  const readChain = (start: number): Buffer => {
    const parts: Buffer[] = [];
    let s = start;
    while (s !== ENDOFCHAIN && s !== 0xffffffff && s < fat.length) {
      const base = 512 + s * sectorSize;
      parts.push(buf.subarray(base, base + sectorSize));
      s = fat[s];
    }
    return Buffer.concat(parts);
  };

  // 디렉토리 엔트리 (128바이트) 트리
  const dir = readChain(buf.readUInt32LE(48));
  const entryCount = Math.floor(dir.length / 128);
  const entry = (i: number) => {
    const b = dir.subarray(i * 128, (i + 1) * 128);
    const nameLen = b.readUInt16LE(64);
    return {
      name: b.subarray(0, Math.max(0, nameLen - 2)).toString("utf16le"),
      type: b[66],
      left: b.readInt32LE(68),
      right: b.readInt32LE(72),
      child: b.readInt32LE(76),
      start: b.readUInt32LE(116),
      size: b.readUInt32LE(120),
    };
  };

  // miniFAT + ministream (root entry의 스트림)
  const root = entry(0);
  const miniFatData = readChain(buf.readUInt32LE(60));
  const miniStream = readChain(root.start);
  const readMiniChain = (start: number, size: number): Buffer => {
    const parts: Buffer[] = [];
    let s = start;
    while (s !== ENDOFCHAIN && s !== 0xffffffff && s * 4 < miniFatData.length) {
      parts.push(miniStream.subarray(s * 64, s * 64 + 64));
      s = miniFatData.readUInt32LE(s * 4);
    }
    return Buffer.concat(parts).subarray(0, size);
  };

  const streams = new Map<string, Buffer>();
  const walk = (idx: number, prefix: string): void => {
    if (idx < 0 || idx >= entryCount) return;
    const e = entry(idx);
    walk(e.left, prefix);
    walk(e.right, prefix);
    if (e.type === 2) {
      const data =
        e.size < miniCutoff ? readMiniChain(e.start, e.size) : readChain(e.start).subarray(0, e.size);
      streams.set(prefix + e.name, data);
    } else if (e.type === 1) {
      walk(e.child, prefix + e.name + "/");
    }
  };
  walk(root.child, "");
  return streams;
}

// ---------------------------------------------------------------- HWP 5.x

const HWPTAG_PARA_TEXT = 67;

/** 제어문자 크기(UTF-16 워드 수). 표에 없는 0x00-0x1f는 1로 취급. */
const CTRL_EXTENDED = new Set([1, 2, 3, 0x0b, 0x0c, 0x0e, 0x0f, 0x10, 0x11, 0x12, 0x15, 0x16, 0x17]);
const CTRL_INLINE = new Set([4, 5, 6, 7, 8, 9, 0x13, 0x14]);

/** HWPTAG_PARA_TEXT 페이로드에서 텍스트를 꺼낸다. */
export function decodeParaText(payload: Buffer): string {
  let out = "";
  let i = 0;
  const words = Math.floor(payload.length / 2);
  while (i < words) {
    const code = payload.readUInt16LE(i * 2);
    if (code >= 32) {
      // 일반 문자 구간을 통째로 디코드 (서로게이트 쌍 포함)
      let j = i;
      while (j < words && payload.readUInt16LE(j * 2) >= 32) j++;
      out += payload.subarray(i * 2, j * 2).toString("utf16le");
      i = j;
    } else if (CTRL_EXTENDED.has(code) || CTRL_INLINE.has(code)) {
      if (code === 9) out += "\t";
      i += 8;
    } else {
      if (code === 10) out += "\n";
      i += 1; // PARAGRAPH_BREAK(13) 포함 — 문단 경계는 레코드 단위로 이미 나뉜다
    }
  }
  return out;
}

export function extractHwp5(buf: Buffer): string {
  const streams = readCfb(buf);
  const header = streams.get("FileHeader");
  if (!header || !header.toString("latin1", 0, 17).startsWith("HWP Document File")) {
    throw new Error("not a HWP 5.x document (FileHeader missing)");
  }
  const flags = header.readUInt32LE(36);
  if (flags & 0b10) throw new Error("password-protected HWP — cannot read");
  if (flags & 0b100) throw new Error("distribution-only (배포용) HWP — cannot read");
  const compressed = (flags & 0b1) !== 0;

  const sections = [...streams.keys()]
    .filter((n) => /^BodyText\/Section\d+$/.test(n))
    .sort((a, b) => Number(a.match(/\d+/)![0]) - Number(b.match(/\d+/)![0]));
  if (sections.length === 0) throw new Error("no BodyText sections found");

  const paragraphs: string[] = [];
  for (const name of sections) {
    const data = compressed ? inflateRawSync(streams.get(name)!) : streams.get(name)!;
    let pos = 0;
    while (pos + 4 <= data.length) {
      const h = data.readUInt32LE(pos);
      pos += 4;
      const tagid = h & 0x3ff;
      let size = (h >>> 20) & 0xfff;
      if (size === 0xfff) {
        size = data.readUInt32LE(pos);
        pos += 4;
      }
      if (tagid === HWPTAG_PARA_TEXT) {
        paragraphs.push(decodeParaText(data.subarray(pos, pos + size)));
      }
      pos += size;
    }
  }
  return paragraphs.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

// ---------------------------------------------------------------- 툴 등록

const MAX_CHARS = 200_000;

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "read_hwp",
    label: "Read HWP",
    description:
      "Read a Korean HWP/HWPX (한글) document and return its text content, including tables. " +
      "Supports .hwpx (HWPX/OWPML) and binary .hwp (HWP 5.x). " +
      "Use this instead of the built-in read tool for these files.",
    promptSnippet: "Read Korean HWP/HWPX documents",
    promptGuidelines: [
      "The built-in read tool cannot parse .hwp/.hwpx files. " +
        "Always use read_hwp for Korean word processor documents.",
    ],
    parameters: Type.Object({
      path: Type.String({ description: "Path to the .hwp or .hwpx file" }),
    }),

    async execute(_toolCallId, params) {
      const buf = readFileSync(params.path);

      let format: "hwpx" | "hwp5";
      let text: string;
      if (buf.readUInt32LE(0) === 0x04034b50) {
        format = "hwpx";
        text = extractHwpx(buf);
      } else if (buf.readUInt32BE(0) === 0xd0cf11e0) {
        format = "hwp5";
        text = extractHwp5(buf);
      } else {
        throw new Error(
          `${params.path}: not a HWP/HWPX file (unknown signature). ` +
            "HWP 3.0 and other formats are not supported.",
        );
      }

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
        details: { path: params.path, format, chars: text.length, truncated },
      };
    },
  });
}
