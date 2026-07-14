/**
 * watch-log.ts — pi-log
 *
 * 서버 로그를 읽고·감시하고·뒤지는 세 개의 툴. 로컬 파일뿐 아니라
 * `.pi/log.json`에 등록한 원격 서버(ssh)의 로그도 같은 인터페이스로 다룬다 —
 * 서버와 로그 경로를 설정에 적어두면 에이전트가 인프라를 알게 된다.
 *
 * `tail_log` — 대용량 로그의 마지막 N줄 (전체 파일을 메모리에 올리지 않는다).
 *   - grep(정규식) + context 필터, 매치 그룹 사이는 "…"
 *   - details.cursor(바이트 오프셋)를 다음 호출의 since로 넘기면 새 줄만 증분 조회
 *   - 로테이션(파일 축소) 감지, 회전 로그 `.gz`, euc-kr, server: 원격
 *
 * `watch_log` — 패턴이 나타날 때까지 블로킹 대기하는 감시.
 *   - 호출 시점의 파일 끝부터 stat 폴링(로컬 400ms / 원격 2s — ssh 왕복 비용)
 *   - 매치되면 직전 5줄 + 이후 1.5s/40줄을 더 모아 스택트레이스까지 반환
 *   - 타임아웃이면 에러가 아니라 "그동안 뭐가 쌓였는지"를 돌려준다
 *
 * `search_log` — "이런 이벤트 있었어?"에 답하는 탐색.
 *   - 여러 파일/글롭(회전 .gz 포함)에서 정규식 매치 + 전후 문맥을 grep 형식으로
 *   - 원격은 zgrep을 서버 쪽에서 돌려 매치만 가져온다 (로그 전송 없음)
 *
 * 원격 실행은 OpenSSH 클라이언트(spawn "ssh")를 그대로 쓴다 — npm 의존성 없이
 * 사용자의 기존 ssh 키·config·점프호스트 설정이 전부 통한다. 원격 명령은
 * stat/tail/head/gunzip/zgrep 조합의 읽기 전용으로 고정되고, 경로·글롭은
 * 안전 문자셋 검증, 패턴은 단일따옴표 인용으로 주입을 차단한다.
 *
 * 외부 의존성 없음: node:fs + node:zlib + node:child_process + TextDecoder.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { closeSync, createReadStream, globSync, openSync, readFileSync, readSync, statSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createGunzip, gunzipSync } from "node:zlib";

// ---------------------------------------------------------------- 공통

const MAX_CHARS = 200_000;
const CHUNK = 64 * 1024;
const TAIL_MAX_BYTES = 4 * 1024 * 1024; // 한 번에 스캔/전송하는 상한 — 로그 꼬리는 이 안에 있다
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

function splitLines(text: string): string[] {
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
}

// ---------------------------------------------------------------- 서버 설정 (.pi/log.json)

interface ServerConfig {
  /** ssh 대상: "user@host" 또는 ~/.ssh/config 별칭 */
  host: string;
  port?: number;
  /** ssh에 그대로 붙는 추가 인자 (예: ["-i", "~/.ssh/deploy_key", "-J", "jump"]) */
  args?: string[];
  /** 이 서버의 기본 로그 경로/글롭 — search_log가 files 없이 호출되면 이걸 쓴다 */
  logs?: string[];
}

const CONFIG_PATHS = [join(process.cwd(), ".pi", "log.json"), join(homedir(), ".pi", "log.json")];

/** 매 호출마다 다시 읽는다. 프로젝트 설정이 전역을 덮는다. */
function loadServers(): Record<string, ServerConfig> {
  const merged: Record<string, ServerConfig> = {};
  for (const p of [...CONFIG_PATHS].reverse()) {
    if (!existsSync(p)) continue;
    try {
      Object.assign(merged, JSON.parse(readFileSync(p, "utf8")) as Record<string, ServerConfig>);
    } catch (e) {
      throw new Error(`${p}: invalid JSON (${e instanceof Error ? e.message : String(e)})`);
    }
  }
  return merged;
}

function getServer(name: string): ServerConfig {
  const servers = loadServers();
  const srv = servers[name];
  if (srv === undefined) {
    const known = Object.keys(servers);
    throw new Error(
      `unknown server '${name}' — ` +
        (known.length > 0
          ? `available: ${known.join(", ")}`
          : `no servers defined; create ${CONFIG_PATHS[0]} (see pi-log README)`),
    );
  }
  if (typeof srv.host !== "string" || srv.host.length === 0) throw new Error(`server '${name}': missing "host"`);
  return srv;
}

// ---------------------------------------------------------------- ssh 실행 (읽기 전용 명령만 조립한다)

const SAFE_PATH = /^[A-Za-z0-9_./*?\[\]+:,@=-]+$/;

function safePath(p: string): string {
  if (!SAFE_PATH.test(p)) throw new Error(`unsafe remote path/glob: ${p}`);
  return p;
}

/** POSIX 셸 단일따옴표 인용 — 원격 명령 주입 차단 */
function q(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

function expandTilde(a: string): string {
  return a.startsWith("~/") ? join(homedir(), a.slice(2)) : a;
}

function sshExec(
  srv: ServerConfig,
  command: string,
  timeoutMs: number,
): Promise<{ out: Buffer; code: number; err: string }> {
  const args = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10"];
  if (srv.port !== undefined) args.push("-p", String(srv.port));
  for (const a of srv.args ?? []) args.push(expandTilde(a));
  args.push(srv.host, "--", command);

  return new Promise((resolve, reject) => {
    const child = spawn("ssh", args, { stdio: ["ignore", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outLen = 0;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`ssh ${srv.host}: timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs);
    child.stdout.on("data", (d: Buffer) => {
      outLen += d.length;
      if (outLen <= TAIL_MAX_BYTES + CHUNK) out.push(d); // 상한 초과분은 버린다
    });
    child.stderr.on("data", (d: Buffer) => err.push(d));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(new Error(`cannot run ssh: ${e.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ out: Buffer.concat(out), code: code ?? -1, err: Buffer.concat(err).toString("utf8").trim() });
    });
  });
}

async function sshRun(srv: ServerConfig, command: string, timeoutMs = 30_000): Promise<Buffer> {
  const r = await sshExec(srv, command, timeoutMs);
  if (r.code === 255) throw new Error(`ssh ${srv.host}: connection failed — ${r.err.split("\n").pop() ?? ""}`);
  if (r.code !== 0) throw new Error(`${srv.host}: remote command failed (exit ${r.code}): ${r.err || command}`);
  return r.out;
}

// ---------------------------------------------------------------- 로그 소스 추상화 (로컬 fs ↔ 원격 ssh)

interface LogSource {
  label: string;
  size(path: string): Promise<number>;
  readRange(path: string, from: number, to: number): Promise<{ buf: Buffer; skipped: number }>;
  /** 마지막 n줄어치 바이트 — 넉넉히 돌아올 수 있으니 호출자가 slice(-n)한다 */
  tailLines(path: string, n: number, gz: boolean): Promise<Buffer>;
}

/** 파일 끝에서 역방향으로, wantLines줄 또는 상한에 닿을 때까지 읽는다. */
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

/** [from, to) 구간. 상한을 넘으면 끝쪽만 남기고 skipped로 알린다. */
function readRangeLocal(path: string, from: number, to: number): { buf: Buffer; skipped: number } {
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

const LOCAL: LogSource = {
  label: "local",
  async size(p) {
    return statFile(p).size;
  },
  async readRange(p, from, to) {
    return readRangeLocal(p, from, to);
  },
  async tailLines(p, n, gz) {
    const st = statFile(p);
    if (!gz) return readBackwards(p, st.size, n);
    if (st.size > GZ_MAX_BYTES) throw new Error(`${p}: compressed size ${st.size} exceeds ${GZ_MAX_BYTES}`);
    return gunzipSync(readRangeLocal(p, 0, st.size).buf);
  },
};

function remoteSource(name: string, srv: ServerConfig): LogSource {
  return {
    label: name,
    async size(p) {
      const out = await sshRun(srv, `stat -c %s -- ${q(safePath(p))}`);
      const n = Number(out.toString("utf8").trim());
      if (!Number.isFinite(n)) throw new Error(`${name}: cannot stat ${p}`);
      return n;
    },
    async readRange(p, from, to) {
      const skipped = Math.max(0, to - from - TAIL_MAX_BYTES);
      const start = from + skipped;
      const buf = await sshRun(srv, `tail -c +${start + 1} -- ${q(safePath(p))} | head -c ${to - start}`);
      return { buf, skipped };
    },
    async tailLines(p, n, gz) {
      const path = q(safePath(p));
      return sshRun(srv, gz ? `gunzip -c -- ${path} | tail -n ${n}` : `tail -n ${n} -- ${path}`);
    },
  };
}

function pickSource(server: string | undefined): LogSource {
  return server === undefined ? LOCAL : remoteSource(server, getServer(server));
}

// ---------------------------------------------------------------- search 구현

/** 스트림을 완성된 줄 단위로 디코딩해 흘린다 (\n 바이트 분할 — euc-kr 안전). */
async function* lineIter(stream: AsyncIterable<Buffer | string>, encoding: Encoding): AsyncGenerator<string> {
  let rem = Buffer.alloc(0);
  for await (const chunk of stream) {
    const data = Buffer.concat([rem, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
    let start = 0;
    let idx: number;
    while ((idx = data.indexOf(0x0a, start)) !== -1) {
      let end = idx;
      if (end > start && data[end - 1] === 0x0d) end--;
      yield decode(data.subarray(start, end), encoding);
      start = idx + 1;
    }
    rem = Buffer.from(data.subarray(start));
  }
  if (rem.length > 0) yield decode(rem, encoding);
}

/** grep 출력 형식(매치 `path:번호:줄`, 문맥 `path-번호-줄`, 그룹 사이 `--`)으로 한 파일을 뒤진다. */
async function searchFileLocal(
  path: string,
  re: RegExp,
  context: number,
  maxMatches: number,
  encoding: Encoding,
): Promise<{ out: string[]; matches: number }> {
  const raw = createReadStream(path);
  const stream = path.endsWith(".gz") ? raw.pipe(createGunzip()) : raw;
  const out: string[] = [];
  const ring: Array<[number, string]> = [];
  let matches = 0;
  let lineNo = 0;
  let afterLeft = 0;
  let lastPrinted = 0;

  try {
    for await (const line of lineIter(stream as AsyncIterable<Buffer>, encoding)) {
      lineNo++;
      if (matches < maxMatches && re.test(line)) {
        const groupStart = ring.length > 0 ? ring[0][0] : lineNo;
        if (out.length > 0 && groupStart > lastPrinted + 1) out.push("--");
        for (const [n, t] of ring) {
          out.push(`${path}-${n}-${t}`);
          lastPrinted = n;
        }
        ring.length = 0;
        out.push(`${path}:${lineNo}:${line}`);
        lastPrinted = lineNo;
        matches++;
        afterLeft = context;
      } else if (afterLeft > 0) {
        out.push(`${path}-${lineNo}-${line}`);
        lastPrinted = lineNo;
        afterLeft--;
      } else {
        if (context > 0) {
          ring.push([lineNo, line]);
          if (ring.length > context) ring.shift();
        }
        if (matches >= maxMatches) {
          raw.destroy();
          break;
        }
      }
    }
  } finally {
    raw.destroy();
  }
  return { out, matches };
}

// ---------------------------------------------------------------- 툴 등록

const DEFAULT_LINES = 100;
const MAX_LINES = 2_000;
const SERVER_DESC = "Named server from .pi/log.json to run against over ssh (omit for a local file)";
const ENC = Type.Optional(
  Type.Union([Type.Literal("utf8"), Type.Literal("euc-kr")], { description: "Text encoding (default utf8)" }),
);

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "tail_log",
    label: "Tail log",
    description:
      "Read the last N lines of a (possibly huge) log file — local or on a named ssh server — without " +
      "loading the whole file. Regex filtering with context, incremental reads via a byte cursor, " +
      "rotated .gz logs, euc-kr.",
    promptSnippet: "Tail log files efficiently (local or remote, regex filter, incremental cursor)",
    promptGuidelines: [
      "Use tail_log instead of the built-in read tool for log files or any large append-only file — " +
        "it reads only the tail. Pass server to read logs on a remote host defined in .pi/log.json. " +
        "Filter noise with grep (a regex) and context; then pass details.cursor back as since " +
        "on the next call to fetch only newly appended lines.",
    ],
    parameters: Type.Object({
      path: Type.String({ description: "Path to the log file (.gz supported for rotated logs)" }),
      server: Type.Optional(Type.String({ description: SERVER_DESC })),
      lines: Type.Optional(
        Type.Number({ description: `How many lines from the end (default ${DEFAULT_LINES}, max ${MAX_LINES})` }),
      ),
      grep: Type.Optional(Type.String({ description: "Regex — keep only matching lines (and context around them)" })),
      context: Type.Optional(Type.Number({ description: "Lines of context around each grep match (default 0)" })),
      since: Type.Optional(
        Type.Number({ description: "Byte cursor from a previous call — return only lines appended after it" }),
      ),
      encoding: ENC,
    }),

    async execute(_toolCallId, params) {
      const source = pickSource(params.server);
      const encoding: Encoding = params.encoding ?? "utf8";
      const wantLines = Math.min(Math.max(1, Math.floor(params.lines ?? DEFAULT_LINES)), MAX_LINES);
      const re = params.grep !== undefined ? compileRegex(params.grep) : undefined;
      const context = Math.min(Math.max(0, Math.floor(params.context ?? 0)), 50);
      const notes: string[] = [];
      const isGz = params.path.endsWith(".gz");

      let lines: string[];
      let cursor = -1; // .gz는 자라지 않는다 — 커서 없음

      if (isGz) {
        if (params.since !== undefined) throw new Error("since is not supported for .gz files (they don't grow)");
        lines = splitLines(decode(await source.tailLines(params.path, wantLines, true), encoding));
        if (lines.length > wantLines) lines = lines.slice(-wantLines);
      } else {
        const size = await source.size(params.path);
        cursor = size;
        let from = params.since;
        if (from !== undefined && from > size) {
          notes.push(`[file shrank since cursor ${from} — rotated? reading from the start]`);
          from = 0;
        }
        if (from !== undefined) {
          const { buf, skipped } = await source.readRange(params.path, from, size);
          if (skipped > 0) notes.push(`[${skipped} bytes skipped — more than ${TAIL_MAX_BYTES} appended since cursor]`);
          lines = splitLines(decode(buf, encoding));
          if (lines.length > MAX_LINES) {
            notes.push(`[showing last ${MAX_LINES} of ${lines.length} new lines]`);
            lines = lines.slice(-MAX_LINES);
          }
        } else {
          lines = splitLines(decode(await source.tailLines(params.path, wantLines, false), encoding));
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
              (cursor >= 0 ? `\n\n[cursor: ${cursor} — pass as since to read only newer lines]` : ""),
          },
        ],
        details: { path: params.path, source: source.label, cursor, lines: lines.length, matches, truncated },
      };
    },
  });

  pi.registerTool({
    name: "watch_log",
    label: "Watch log",
    description:
      "Block until a regex pattern appears in newly appended lines of a growing log file — local or on a " +
      "named ssh server — or until the timeout passes. Returns the match with surrounding lines; on " +
      "timeout, reports what was logged instead.",
    promptSnippet: "Wait for a pattern in a growing log (startup lines, errors)",
    promptGuidelines: [
      "Use watch_log to wait for something to show up in a log — a server's 'started' line after a restart, " +
        "an error after triggering a request. It watches from the current end of the file (pass server for " +
        "a remote host from .pi/log.json), so start it before (or right after) the action that produces " +
        "the log line. On timeout it is not an error: it returns the lines that did arrive, which usually " +
        "explains what happened instead.",
    ],
    parameters: Type.Object({
      path: Type.String({ description: "Path to the log file being appended to" }),
      server: Type.Optional(Type.String({ description: SERVER_DESC })),
      pattern: Type.String({ description: "Regex to wait for in newly appended lines" }),
      timeout: Type.Optional(Type.Number({ description: "Seconds to wait (default 60, max 600)" })),
      encoding: ENC,
    }),

    async execute(_toolCallId, params, signal) {
      const source = pickSource(params.server);
      const encoding: Encoding = params.encoding ?? "utf8";
      const re = compileRegex(params.pattern);
      const timeoutMs = Math.min(Math.max(1, params.timeout ?? 60), 600) * 1000;
      const pollMs = params.server === undefined ? 400 : 2_000; // 원격은 폴링마다 ssh 왕복
      const BEFORE = 5;
      const AFTER_LINES = 40;
      const AFTER_GRACE_MS = 1_500;
      if (params.path.endsWith(".gz")) throw new Error("cannot watch a .gz file (it doesn't grow)");

      let offset = await source.size(params.path); // 지금부터 쌓이는 것만 본다
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
      const drain = async (): Promise<string[]> => {
        const size = await source.size(params.path);
        if (size < offset) {
          notes.push("[file shrank while watching — rotated; following the new file from its start]");
          offset = 0;
          remainder = Buffer.alloc(0);
        }
        if (size === offset) return [];
        const { buf, skipped } = await source.readRange(params.path, offset, size);
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
        for (const line of await drain()) {
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
        if (matchLine === undefined) await sleep(pollMs);
      }

      if (matchLine !== undefined) {
        // 스택트레이스처럼 매치 직후 쏟아지는 줄을 잠깐 더 모은다
        const graceEnd = Date.now() + AFTER_GRACE_MS;
        while (after.length < AFTER_LINES && Date.now() < graceEnd && !signal?.aborted) {
          await sleep(200);
          for (const line of await drain()) {
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

  pi.registerTool({
    name: "search_log",
    label: "Search logs",
    description:
      "Search for a regex across log files (globs, rotated .gz included) — local or on a named ssh " +
      "server — and return matches with context in grep format (file:line:text). Remote search runs " +
      "zgrep on the server, so only matches travel back.",
    promptSnippet: "Find an event across log files (globs, .gz, local or remote)",
    promptGuidelines: [
      "Use search_log when asked to find an event or error in logs ('was there a payment failure " +
        "yesterday?'). Include a date/time string in the pattern to narrow the window (e.g. " +
        "'2026-07-13.*payment.*fail'). Servers and their default log paths live in .pi/log.json — " +
        "with server set and files omitted, search_log searches that server's configured logs, " +
        "including rotated .gz files.",
    ],
    parameters: Type.Object({
      pattern: Type.String({ description: "Extended regex (POSIX ERE — works with both grep -E and JS)" }),
      server: Type.Optional(Type.String({ description: SERVER_DESC })),
      files: Type.Optional(
        Type.Array(Type.String(), {
          description:
            "Log paths/globs to search (e.g. /logs/app*.log*). Defaults to the server's configured logs",
        }),
      ),
      context: Type.Optional(Type.Number({ description: "Lines of context around each match (default 2)" })),
      maxMatches: Type.Optional(Type.Number({ description: "Match cap per file (default 50, max 500)" })),
      encoding: ENC,
    }),

    async execute(_toolCallId, params) {
      const encoding: Encoding = params.encoding ?? "utf8";
      const context = Math.min(Math.max(0, Math.floor(params.context ?? 2)), 20);
      const maxMatches = Math.min(Math.max(1, Math.floor(params.maxMatches ?? 50)), 500);

      let text: string;
      let matches: number;
      let fileCount: number;

      if (params.server !== undefined) {
        const srv = getServer(params.server);
        const patterns = params.files ?? srv.logs;
        if (patterns === undefined || patterns.length === 0) {
          throw new Error(`server '${params.server}' has no "logs" configured — pass files explicitly`);
        }
        const fileArgs = patterns.map((f) => safePath(f)).join(" "); // 글롭은 원격 셸이 확장한다
        const ctx = context > 0 ? `-C ${context} ` : "";
        const r = await sshExec(
          srv,
          `zgrep -H -n -E ${ctx}-m ${maxMatches} -e ${q(params.pattern)} -- ${fileArgs}`,
          60_000,
        );
        if (r.code === 255) throw new Error(`ssh ${srv.host}: connection failed — ${r.err.split("\n").pop() ?? ""}`);
        if (r.code > 1) throw new Error(`${srv.host}: zgrep failed (exit ${r.code}): ${r.err}`);
        text = decode(r.out, encoding).trimEnd();
        matches = text === "" ? 0 : splitLines(text).filter((l) => /^[^:]+:\d+:/.test(l)).length;
        fileCount = patterns.length;
      } else {
        compileRegex(params.pattern); // 로컬은 JS 정규식 — 미리 검증
        if (params.files === undefined || params.files.length === 0) {
          throw new Error('files is required for a local search (or pass server to use its configured "logs")');
        }
        const expanded = [...new Set(params.files.flatMap((f) => globSync(f)))].sort();
        if (expanded.length === 0) throw new Error(`no files matched: ${params.files.join(", ")}`);
        const re = compileRegex(params.pattern);
        const sections: string[] = [];
        matches = 0;
        for (const file of expanded) {
          const r = await searchFileLocal(file, re, context, maxMatches, encoding);
          if (r.out.length > 0) sections.push(r.out.join("\n"));
          matches += r.matches;
        }
        text = sections.join("\n--\n");
        fileCount = expanded.length;
      }

      const capped = capChars(text);
      return {
        content: [
          {
            type: "text" as const,
            text:
              (capped.truncated ? `[truncated to last ${MAX_CHARS} chars]\n` : "") +
              (matches === 0 ? `no matches for /${params.pattern}/` : capped.text) +
              `\n\n[${matches} match${matches === 1 ? "" : "es"} across ${fileCount} file${fileCount === 1 ? "" : "s"}` +
              ` (per-file cap ${maxMatches})]`,
          },
        ],
        details: { source: params.server ?? "local", files: fileCount, matches, truncated: capped.truncated },
      };
    },
  });
}
