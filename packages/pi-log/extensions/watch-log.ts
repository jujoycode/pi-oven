/**
 * watch-log.ts — pi-log
 *
 * 서버 로그를 읽고 감시하는 두 개의 툴.
 *
 * `tail_log` — 대용량 로그의 마지막 N줄을 파일 끝에서 역방향으로 읽는다
 *   (전체 파일을 메모리에 올리지 않는다 — 내장 read가 GB급 로그에서 못 하는 일).
 *   - grep(정규식) + context(전후 줄 수) 필터, 매치 그룹 사이는 "…"로 구분
 *   - details.cursor(바이트 오프셋)를 다음 호출의 since로 넘기면 새로 쌓인 줄만 증분 조회
 *   - 파일이 줄어들었으면(로테이션) 처음부터 다시 읽고 그 사실을 알린다
 *   - 회전 로그 `.gz`는 node:zlib으로 풀어서 읽는다 (압축 32MB 상한)
 *   - encoding: "euc-kr"로 레거시 한글 로그 지원 (TextDecoder 내장)
 *
 * `watch_log` — 패턴이 나타날 때까지 블로킹 대기하는 진짜 "감시".
 *   - 호출 시점의 파일 끝부터 400ms 폴링으로 새 줄만 검사 (fs.watch는 NFS에서
 *     못 믿는다 — stat 폴링이 단순하고 어디서나 동작)
 *   - 매치되면 직전 5줄 + 이후 잠깐(1.5s/40줄) 더 모아서 스택트레이스까지 반환
 *   - 타임아웃이면 에러가 아니라 "그동안 뭐가 쌓였는지"를 돌려준다
 *   - 취소(signal)와 로테이션을 폴링 루프에서 처리
 *
 * 외부 의존성 없음: node:fs + node:zlib + TextDecoder.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { closeSync, openSync, readSync, statSync } from "node:fs";
import { gunzipSync } from "node:zlib";

// ---------------------------------------------------------------- 공통

const MAX_CHARS = 200_000;
const CHUNK = 64 * 1024;
const TAIL_MAX_BYTES = 4 * 1024 * 1024; // 한 번에 스캔하는 상한 — 로그 꼬리는 이 안에 있다
const GZ_MAX_BYTES = 32 * 1024 * 1024;

type Encoding = "utf8" | "euc-kr";

function decode(buf: Buffer, encoding: Encoding): string {
  // EUC-KR/CP949는 trail byte에 0x0A가 없어 \n 경계 분할이 안전하다
  return encoding === "utf8" ? buf.toString("utf8") : new TextDecoder("euc-kr").decode(buf);
}

function compileRegex(pattern: string): RegExp {
  try {
    return new RegExp(pattern);
  } catch (e) {
    throw new Error(`invalid regex '${pattern}': ${e instanceof Error ? e.message : String(e)}`);
  }
}

function statFile(path: string) {
  const st = statSync(path); // ENOENT 등은 그대로 — 명확한 에러가 낫다
  if (!st.isFile()) throw new Error(`${path}: not a regular file`);
  return st;
}

/** grep 매치 줄 ± context줄만 남긴다. 떨어진 그룹 사이는 "…" 한 줄. */
function grepLines(lines: string[], re: RegExp, context: number): { out: string[]; matches: number } {
  const keep = new Set<number>();
  let matches = 0;
  lines.forEach((l, i) => {
    if (!re.test(l)) return;
    matches++;
    for (let j = Math.max(0, i - context); j <= Math.min(lines.length - 1, i + context); j++) keep.add(j);
  });
  const out: string[] = [];
  let prev = -2;
  for (const i of [...keep].sort((a, b) => a - b)) {
    if (i > prev + 1 && out.length > 0) out.push("…");
    out.push(lines[i]);
    prev = i;
  }
  return { out, matches };
}

function capChars(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_CHARS) return { text, truncated: false };
  return { text: text.slice(text.length - MAX_CHARS), truncated: true }; // 로그는 끝이 중요하다
}

// ---------------------------------------------------------------- tail 읽기

/** 파일 끝에서 역방향으로, wantLines줄 또는 maxBytes에 닿을 때까지 읽는다. */
function readBackwards(path: string, size: number, wantLines: number): Buffer {
  const fd = openSync(path, "r");
  try {
    const parts: Buffer[] = [];
    let from = size;
    let newlines = 0;
    while (from > 0 && size - from < TAIL_MAX_BYTES && newlines <= wantLines) {
      const len = Math.min(CHUNK, from);
      const b = Buffer.alloc(len);
      readSync(fd, b, 0, len, from - len);
      from -= len;
      parts.unshift(b);
      for (const byte of b) if (byte === 0x0a) newlines++;
    }
    return Buffer.concat(parts);
  } finally {
    closeSync(fd);
  }
}

/** [from, to) 구간을 읽는다. 구간이 상한을 넘으면 끝쪽만 남기고 잘렸다고 표시한다. */
function readRange(path: string, from: number, to: number): { buf: Buffer; skipped: number } {
  const skipped = Math.max(0, to - from - TAIL_MAX_BYTES);
  const start = from + skipped;
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(to - start);
    let done = 0;
    while (done < buf.length) {
      const n = readSync(fd, buf, done, Math.min(CHUNK, buf.length - done), start + done);
      if (n === 0) break;
      done += n;
    }
    return { buf: buf.subarray(0, done), skipped };
  } finally {
    closeSync(fd);
  }
}

function splitLines(text: string): string[] {
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
}

// ---------------------------------------------------------------- 툴 등록

const DEFAULT_LINES = 100;
const MAX_LINES = 2_000;

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "tail_log",
    label: "Tail log",
    description:
      "Read the last N lines of a (possibly huge) log file without loading it into memory. " +
      "Supports regex filtering with context lines, incremental reads via a byte cursor, " +
      "rotated .gz logs, and euc-kr encoding.",
    promptSnippet: "Tail log files efficiently (regex filter, incremental cursor)",
    promptGuidelines: [
      "Use tail_log instead of the built-in read tool for log files or any large append-only file — " +
        "it reads only the tail. Filter noise with grep (a regex) and context; " +
        "then pass details.cursor back as since on the next call to fetch only newly appended lines.",
    ],
    parameters: Type.Object({
      path: Type.String({ description: "Path to the log file (.gz supported for rotated logs)" }),
      lines: Type.Optional(
        Type.Number({ description: `How many lines from the end (default ${DEFAULT_LINES}, max ${MAX_LINES})` }),
      ),
      grep: Type.Optional(Type.String({ description: "Regex — keep only matching lines (and context around them)" })),
      context: Type.Optional(Type.Number({ description: "Lines of context around each grep match (default 0)" })),
      since: Type.Optional(
        Type.Number({ description: "Byte cursor from a previous call — return only lines appended after it" }),
      ),
      encoding: Type.Optional(
        Type.Union([Type.Literal("utf8"), Type.Literal("euc-kr")], { description: "Text encoding (default utf8)" }),
      ),
    }),

    async execute(_toolCallId, params) {
      const encoding: Encoding = params.encoding ?? "utf8";
      const wantLines = Math.min(Math.max(1, Math.floor(params.lines ?? DEFAULT_LINES)), MAX_LINES);
      const re = params.grep !== undefined ? compileRegex(params.grep) : undefined;
      const context = Math.min(Math.max(0, Math.floor(params.context ?? 0)), 50);
      const notes: string[] = [];

      let lines: string[];
      let cursor: number;

      if (params.path.endsWith(".gz")) {
        if (params.since !== undefined) throw new Error("since is not supported for .gz files (they don't grow)");
        const st = statFile(params.path);
        if (st.size > GZ_MAX_BYTES) {
          throw new Error(`${params.path}: compressed size ${st.size} exceeds ${GZ_MAX_BYTES} — extract it first`);
        }
        const { buf } = readRange(params.path, 0, st.size);
        lines = splitLines(decode(gunzipSync(buf), encoding));
        if (lines.length > wantLines) lines = lines.slice(-wantLines);
        cursor = st.size;
      } else {
        const size = statFile(params.path).size;
        cursor = size;
        let from = params.since;
        if (from !== undefined && from > size) {
          notes.push(`[file shrank since cursor ${from} — rotated? reading from the start]`);
          from = 0;
        }
        if (from !== undefined) {
          const { buf, skipped } = readRange(params.path, from, size);
          if (skipped > 0) notes.push(`[${skipped} bytes skipped — more than ${TAIL_MAX_BYTES} appended since cursor]`);
          lines = splitLines(decode(buf, encoding));
          if (lines.length > MAX_LINES) {
            notes.push(`[showing last ${MAX_LINES} of ${lines.length} new lines]`);
            lines = lines.slice(-MAX_LINES);
          }
        } else {
          const buf = readBackwards(params.path, size, wantLines);
          lines = splitLines(decode(buf, encoding));
          if (lines.length > wantLines) lines = lines.slice(-wantLines);
        }
      }

      let matches: number | undefined;
      if (re !== undefined) {
        const g = grepLines(lines, re, context);
        lines = g.out;
        matches = g.matches;
        notes.push(`[grep /${params.grep}/: ${matches} matching line${matches === 1 ? "" : "s"}]`);
      }

      const body =
        lines.length > 0 ? lines.join("\n") : params.since !== undefined ? "(no new lines)" : "(file is empty)";
      const { text, truncated } = capChars(body);

      return {
        content: [
          {
            type: "text" as const,
            text:
              (truncated ? `[truncated to last ${MAX_CHARS} chars]\n` : "") +
              text +
              (notes.length > 0 ? "\n\n" + notes.join("\n") : "") +
              `\n\n[cursor: ${cursor} — pass as since to read only newer lines]`,
          },
        ],
        details: { path: params.path, cursor, lines: lines.length, matches, truncated },
      };
    },
  });

  pi.registerTool({
    name: "watch_log",
    label: "Watch log",
    description:
      "Block until a regex pattern appears in newly appended lines of a growing log file, or until the " +
      "timeout passes. Returns the match with surrounding lines; on timeout, reports what was logged instead.",
    promptSnippet: "Wait for a pattern in a growing log (startup lines, errors)",
    promptGuidelines: [
      "Use watch_log to wait for something to show up in a log — a server's 'started' line after a restart, " +
        "an error after triggering a request. It watches from the current end of the file, so start it " +
        "before (or right after) the action that produces the log line. On timeout it is not an error: " +
        "it returns the lines that did arrive, which usually explains what happened instead.",
    ],
    parameters: Type.Object({
      path: Type.String({ description: "Path to the log file being appended to" }),
      pattern: Type.String({ description: "Regex to wait for in newly appended lines" }),
      timeout: Type.Optional(Type.Number({ description: "Seconds to wait (default 60, max 600)" })),
      encoding: Type.Optional(
        Type.Union([Type.Literal("utf8"), Type.Literal("euc-kr")], { description: "Text encoding (default utf8)" }),
      ),
    }),

    async execute(_toolCallId, params, signal) {
      const encoding: Encoding = params.encoding ?? "utf8";
      const re = compileRegex(params.pattern);
      const timeoutMs = Math.min(Math.max(1, params.timeout ?? 60), 600) * 1000;
      const POLL_MS = 400;
      const BEFORE = 5;
      const AFTER_LINES = 40;
      const AFTER_GRACE_MS = 1_500;

      let offset = statFile(params.path).size; // 지금부터 쌓이는 것만 본다
      let remainder = Buffer.alloc(0);
      const ring: string[] = []; // 매치 직전 문맥
      const notes: string[] = [];
      let seen = 0;
      const recent: string[] = []; // 타임아웃 보고용 최근 줄
      let matchLine: string | undefined;
      const after: string[] = [];

      const started = Date.now();
      const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

      /** 새로 쌓인 바이트를 완성된 줄 단위로 돌려준다. 로테이션도 여기서 처리. */
      const drain = (): string[] => {
        const size = statSync(params.path).size;
        if (size < offset) {
          notes.push("[file shrank while watching — rotated; following the new file from its start]");
          offset = 0;
          remainder = Buffer.alloc(0);
        }
        if (size === offset) return [];
        const { buf, skipped } = readRange(params.path, offset, size);
        if (skipped > 0) notes.push(`[${skipped} bytes skipped — log grew faster than ${TAIL_MAX_BYTES}/poll]`);
        offset = size;
        const data = Buffer.concat([remainder, buf]);
        const lastNl = data.lastIndexOf(0x0a);
        if (lastNl < 0) {
          remainder = data;
          return [];
        }
        remainder = Buffer.from(data.subarray(lastNl + 1));
        return splitLines(decode(data.subarray(0, lastNl + 1), encoding));
      };

      while (matchLine === undefined && Date.now() - started < timeoutMs) {
        if (signal?.aborted) break;
        for (const line of drain()) {
          seen++;
          recent.push(line);
          if (recent.length > 20) recent.shift();
          if (matchLine === undefined && re.test(line)) {
            matchLine = line;
          } else if (matchLine === undefined) {
            ring.push(line);
            if (ring.length > BEFORE) ring.shift();
          } else if (after.length < AFTER_LINES) {
            after.push(line); // 같은 폴링 배치에 이미 도착한 후행 줄
          }
        }
        if (matchLine === undefined) await sleep(POLL_MS);
      }

      if (matchLine !== undefined) {
        // 스택트레이스처럼 매치 직후 쏟아지는 줄을 잠깐 더 모은다
        const graceEnd = Date.now() + AFTER_GRACE_MS;
        while (after.length < AFTER_LINES && Date.now() < graceEnd && !signal?.aborted) {
          await sleep(200);
          for (const line of drain()) {
            if (after.length < AFTER_LINES) after.push(line);
          }
        }
        const elapsed = ((Date.now() - started) / 1000).toFixed(1);
        const block = [...ring, `>>> ${matchLine}`, ...after].join("\n");
        const { text } = capChars(block);
        return {
          content: [
            {
              type: "text" as const,
              text:
                `matched /${params.pattern}/ after ${elapsed}s (>>> marks the match):\n\n${text}` +
                (notes.length > 0 ? "\n\n" + notes.join("\n") : "") +
                `\n\n[cursor: ${offset} — pass to tail_log as since to continue reading]`,
            },
          ],
          details: { path: params.path, matched: true, elapsedSec: Number(elapsed), newLines: seen, cursor: offset },
        };
      }

      const why = signal?.aborted ? "cancelled" : `no match within ${timeoutMs / 1000}s`;
      const tailReport =
        recent.length > 0 ? `Last ${recent.length} of ${seen} new lines:\n${recent.join("\n")}` : "No new lines arrived.";
      const { text } = capChars(tailReport);
      return {
        content: [
          {
            type: "text" as const,
            text:
              `${why} — /${params.pattern}/ did not appear. ${text}` +
              (notes.length > 0 ? "\n\n" + notes.join("\n") : "") +
              `\n\n[cursor: ${offset} — pass to tail_log as since to continue reading]`,
          },
        ],
        details: {
          path: params.path,
          matched: false,
          elapsedSec: Number(((Date.now() - started) / 1000).toFixed(1)),
          newLines: seen,
          cursor: offset,
        },
      };
    },
  });
}
