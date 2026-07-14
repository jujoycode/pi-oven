/**
 * log.test.mjs — pi-log 동작 테스트
 *
 * 실제 파일시스템에서 tail_log/watch_log의 전체 경로를 검증한다:
 * 역방향 tail, grep+context, 커서 증분, 로테이션 감지, .gz, euc-kr,
 * watch의 매치(후행 문맥 수집)·타임아웃 보고·경쟁 없는 폴링.
 *
 * 실행: node --experimental-strip-types packages/pi-log/test/log.test.mjs
 */

import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const extPath = fileURLToPath(new URL("../extensions/watch-log.ts", import.meta.url));
const { default: register } = await import(extPath);

const tools = {};
register({ registerTool: (def) => (tools[def.name] = def), on: () => {} });
if (!tools.tail_log || !tools.watch_log) throw new Error("tools not registered");

const tail = (p) => tools.tail_log.execute("t", p);
const watch = (p, signal) => tools.watch_log.execute("t", p, signal);
const text = (r) => r.content[0].text;

const dir = mkdtempSync(join(tmpdir(), "pi-log-test-"));
let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (e) {
    failures++;
    console.log(`FAIL ${name}\n  ${e && e.stack ? e.stack.split("\n").slice(0, 4).join("\n  ") : e}`);
  }
}
const expect = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

// ---------------------------------------------------------------- tail_log

const big = join(dir, "big.log");
{
  // 20만 줄(~7MB) — TAIL_MAX_BYTES(4MB)보다 크다: 전체를 읽지 않는 경로를 강제
  const chunk = [];
  for (let i = 1; i <= 200_000; i++) chunk.push(`2026-07-12 12:00:00 INFO line ${i}`);
  writeFileSync(big, chunk.join("\n") + "\n");
}

await check("tail: last N lines of a 7MB file, in order", async () => {
  const r = await tail({ path: big, lines: 3 });
  const lines = text(r).split("\n");
  expect(lines[0].endsWith("line 199998"), "wrong start: " + lines[0]);
  expect(lines[2].endsWith("line 200000"), "wrong end: " + lines[2]);
  expect(r.details.cursor > 0, "cursor missing");
});

await check("tail: since cursor returns only appended lines", async () => {
  const r1 = await tail({ path: big, lines: 1 });
  appendFileSync(big, "2026-07-12 12:00:01 ERROR boom\n2026-07-12 12:00:01 INFO after\n");
  const r2 = await tail({ path: big, since: r1.details.cursor });
  expect(r2.details.lines === 2, `expected 2 new lines, got ${r2.details.lines}`);
  expect(text(r2).includes("ERROR boom") && text(r2).includes("INFO after"), "new lines missing");
  const r3 = await tail({ path: big, since: r2.details.cursor });
  expect(text(r3).includes("(no new lines)"), "expected no new lines");
});

await check("tail: grep + context with … separators", async () => {
  const p = join(dir, "grep.log");
  writeFileSync(p, ["a1", "a2", "ERROR one", "b1", "b2", "b3", "b4", "ERROR two", "c1", "c2"].join("\n") + "\n");
  const r = await tail({ path: p, grep: "^ERROR", context: 1 });
  expect(r.details.matches === 2, `expected 2 matches, got ${r.details.matches}`);
  const lines = text(r).split("\n");
  expect(lines.slice(0, 7).join(",") === "a2,ERROR one,b1,…,b4,ERROR two,c1", "grouping wrong: " + lines.join(","));
});

await check("tail: rotation (cursor beyond size) resets with a note", async () => {
  const p = join(dir, "rot.log");
  writeFileSync(p, "old1\nold2\nold3\n");
  const r1 = await tail({ path: p });
  writeFileSync(p, "fresh\n"); // 로테이션: 파일이 줄었다
  const r2 = await tail({ path: p, since: r1.details.cursor });
  expect(text(r2).includes("rotated?"), "rotation note missing");
  expect(text(r2).includes("fresh"), "new content missing");
});

await check("tail: rotated .gz log", async () => {
  const p = join(dir, "app.log.1.gz");
  writeFileSync(p, gzipSync(Buffer.from("gz1\ngz2\ngz3\n")));
  const r = await tail({ path: p, lines: 2 });
  expect(text(r).startsWith("gz2\ngz3"), "gz tail wrong: " + text(r));
});

await check("tail: euc-kr encoded log", async () => {
  const p = join(dir, "legacy.log");
  const euckr = Buffer.from([0xbc, 0xad, 0xb9, 0xf6, 0x20, 0xbd, 0xc3, 0xc0, 0xdb]); // "서버 시작"
  writeFileSync(p, Buffer.concat([Buffer.from("INFO "), euckr, Buffer.from("\n")]));
  const r = await tail({ path: p, encoding: "euc-kr" });
  expect(text(r).includes("서버 시작"), "euc-kr decode failed: " + text(r));
});

await check("tail: missing file raises a clear error", async () => {
  let threw = false;
  try {
    await tail({ path: join(dir, "nope.log") });
  } catch (e) {
    threw = true;
    expect(e.message.includes("nope.log"), "path missing from error");
  }
  expect(threw, "no error raised");
});

// ---------------------------------------------------------------- watch_log

await check("watch: catches a pattern with before/after context", async () => {
  const p = join(dir, "watch.log");
  writeFileSync(p, "preexisting — must not match ERROR\n");
  const t = setTimeout(() => {
    appendFileSync(p, "warmup 1\nwarmup 2\nERROR exploded\n  at Server.handle (app.js:10)\n  at listen (net.js:1)\n");
  }, 600);
  const r = await watch({ path: p, pattern: "ERROR", timeout: 10 });
  clearTimeout(t);
  expect(r.details.matched === true, "did not match");
  expect(text(r).includes(">>> ERROR exploded"), "match marker missing");
  expect(text(r).includes("warmup 2"), "before-context missing");
  expect(text(r).includes("at Server.handle"), "after-context (stack trace) missing");
});

await check("watch: only NEW lines are considered (existing ERROR ignored)", async () => {
  const p = join(dir, "watch2.log");
  writeFileSync(p, "ERROR old one — before the watch\n");
  const r = await watch({ path: p, pattern: "ERROR", timeout: 2 });
  expect(r.details.matched === false, "matched a pre-existing line");
});

await check("watch: timeout reports what did arrive", async () => {
  const p = join(dir, "watch3.log");
  writeFileSync(p, "");
  const t = setTimeout(() => appendFileSync(p, "INFO something else\n"), 400);
  const r = await watch({ path: p, pattern: "NEVER_MATCHES", timeout: 2 });
  clearTimeout(t);
  expect(r.details.matched === false, "unexpected match");
  expect(text(r).includes("INFO something else"), "arrived lines not reported: " + text(r));
  expect(r.details.newLines === 1, `newLines=${r.details.newLines}`);
});

await check("watch: abort signal stops the wait early", async () => {
  const p = join(dir, "watch4.log");
  writeFileSync(p, "");
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 500);
  const started = Date.now();
  const r = await watch({ path: p, pattern: "X", timeout: 30 }, ac.signal);
  expect(Date.now() - started < 5_000, "abort did not stop the wait");
  expect(r.details.matched === false && text(r).includes("cancelled"), "cancel not reported");
});

console.log(failures === 0 ? "\nALL OK" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
