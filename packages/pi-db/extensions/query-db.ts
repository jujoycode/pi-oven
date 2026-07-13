/**
 * query-db.ts — pi-db
 *
 * MySQL·Oracle에 접속해 읽기 전용 SQL을 실행하는 `query_db` 툴.
 *
 * - 접속 정보는 대화가 아니라 설정 파일에서: .pi/db.json(프로젝트) → ~/.pi/db.json(전역).
 *   툴 파라미터는 접속 별칭만 받는다 — 크리덴셜이 세션 컨텍스트와 로그에 남지 않는다.
 * - 읽기 전용 강제: SELECT/SHOW/EXPLAIN/DESCRIBE/WITH로 시작하는 단일 문만 허용하고,
 *   문자열·주석·따옴표 식별자를 벗겨낸 뒤 DML/DDL 키워드가 보이면 거절한다
 *   (WITH ... UPDATE 같은 CTE 뒤 쓰기, SELECT ... FOR UPDATE의 락 획득까지 차단).
 * - 결과는 마크다운 표(| 셀 | 셀 |), 행 상한 + 200k 자 절단.
 * - 드라이버는 실행 시점에 동적 import: mysql2(순수 JS), oracledb Thin 모드(순수 JS,
 *   Oracle Client 바이너리 불필요). 와이어 프로토콜은 Node 빌트인이 없고 Oracle TNS는
 *   비공개 프로토콜이라, 이 패키지는 예외적으로 런타임 의존성을 가진다.
 *
 * 트랜잭션·락 조회는 별도 기능이 아니라 시스템 뷰 질의로 해결한다
 * (MySQL: information_schema.innodb_trx, Oracle: v$transaction) — promptGuidelines로 유도.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------- 접속 설정

interface MysqlConn {
  driver: "mysql";
  host: string;
  port?: number;
  user: string;
  password: string;
  database?: string;
}

interface OracleConn {
  driver: "oracle";
  user: string;
  password: string;
  /** 예: "db.example.com:1521/ORCLPDB1" */
  connectString: string;
}

type ConnConfig = MysqlConn | OracleConn;

const CONFIG_PATHS = [join(process.cwd(), ".pi", "db.json"), join(homedir(), ".pi", "db.json")];

/** 매 호출마다 다시 읽는다(설정 수정이 즉시 반영). 프로젝트 설정이 전역을 덮는다. */
function loadConnections(): Record<string, ConnConfig> {
  const merged: Record<string, ConnConfig> = {};
  for (const p of [...CONFIG_PATHS].reverse()) {
    if (!existsSync(p)) continue;
    try {
      Object.assign(merged, JSON.parse(readFileSync(p, "utf8")) as Record<string, ConnConfig>);
    } catch (e) {
      throw new Error(`${p}: invalid JSON (${e instanceof Error ? e.message : String(e)})`);
    }
  }
  return merged;
}

// ---------------------------------------------------------------- 읽기 전용 강제

const ALLOWED_FIRST = ["select", "show", "explain", "describe", "desc", "with"];

// 문자열·주석 제거 후 남은 본문에서 쓰기/락 동사를 찾는다. FOR UPDATE는 \bupdate\b에 걸린다.
const FORBIDDEN =
  /\b(insert|update|delete|merge|replace|drop|alter|create|truncate|rename|grant|revoke|call|lock|set|commit|rollback)\b|\binto\s+(outfile|dumpfile)\b/i;

export function assertReadOnly(sql: string): void {
  const stripped = sql
    .replace(/'(?:[^'\\]|\\.|'')*'/g, "''") // 문자열 리터럴
    .replace(/"(?:[^"]|"")*"/g, '""') // 따옴표 식별자 (ANSI/Oracle)
    .replace(/`[^`]*`/g, "``") // 백틱 식별자 (MySQL)
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .trim()
    .replace(/;\s*$/, "");

  if (stripped.includes(";")) throw new Error("query_db runs a single statement — remove ';' separators");

  const first = /^[a-zA-Z]+/.exec(stripped)?.[0]?.toLowerCase();
  if (first === undefined || !ALLOWED_FIRST.includes(first)) {
    throw new Error(`query_db is read-only: statement must start with ${ALLOWED_FIRST.join("/").toUpperCase()}`);
  }
  const hit = FORBIDDEN.exec(stripped);
  if (hit) throw new Error(`query_db is read-only: '${hit[0].toUpperCase()}' is not allowed`);
}

// ---------------------------------------------------------------- 마크다운 표

function cell(v: unknown): string {
  if (v === null || v === undefined) return "NULL";
  if (v instanceof Date) return v.toISOString();
  if (Buffer.isBuffer(v)) return "0x" + v.toString("hex", 0, 32) + (v.length > 32 ? "…" : "");
  const s = typeof v === "object" ? JSON.stringify(v) : String(v);
  return s.replace(/\|/g, "\\|").replace(/\r?\n/g, "␤");
}

function toMarkdown(columns: string[], rows: unknown[][]): string {
  if (columns.length === 0) return "(no result set)";
  return [
    "| " + columns.join(" | ") + " |",
    "|" + columns.map(() => "---").join("|") + "|",
    ...rows.map((r) => "| " + r.map(cell).join(" | ") + " |"),
  ].join("\n");
}

// ---------------------------------------------------------------- 드라이버

interface QueryResult {
  columns: string[];
  rows: unknown[][];
}

const QUERY_TIMEOUT_MS = 60_000;

async function runMysql(cfg: MysqlConn, sql: string): Promise<QueryResult> {
  let mysql: typeof import("mysql2/promise");
  try {
    mysql = await import("mysql2/promise");
  } catch {
    throw new Error("mysql2 driver not installed — run 'npm install' in the pi-db package directory");
  }
  const conn = await mysql.createConnection({
    host: cfg.host,
    port: cfg.port ?? 3306,
    user: cfg.user,
    password: cfg.password,
    database: cfg.database,
    connectTimeout: 10_000,
    rowsAsArray: true,
  });
  try {
    const [rows, fields] = await conn.query({ sql, timeout: QUERY_TIMEOUT_MS });
    if (!Array.isArray(rows)) return { columns: [], rows: [] };
    return { columns: (fields ?? []).map((f) => f.name), rows: rows as unknown[][] };
  } finally {
    await conn.end();
  }
}

async function runOracle(cfg: OracleConn, sql: string, maxRows: number): Promise<QueryResult> {
  let odb: typeof import("oracledb");
  try {
    odb = (await import("oracledb")).default as unknown as typeof import("oracledb");
  } catch {
    throw new Error("oracledb driver not installed — run 'npm install' in the pi-db package directory");
  }
  odb.fetchAsString = [odb.CLOB]; // CLOB을 Lob 스트림 대신 문자열로
  const conn = await odb.getConnection({
    user: cfg.user,
    password: cfg.password,
    connectString: cfg.connectString,
  });
  try {
    conn.callTimeout = QUERY_TIMEOUT_MS;
    const res = await conn.execute<unknown[]>(sql, [], { maxRows, outFormat: odb.OUT_FORMAT_ARRAY });
    return { columns: (res.metaData ?? []).map((m) => m.name), rows: res.rows ?? [] };
  } finally {
    await conn.close();
  }
}

// ---------------------------------------------------------------- 툴 등록

const MAX_CHARS = 200_000;
const DEFAULT_ROWS = 100;
const HARD_ROW_CAP = 1_000;

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "query_db",
    label: "Query DB",
    description:
      "Run a single read-only SQL statement (SELECT/SHOW/EXPLAIN/DESCRIBE/WITH) against a named MySQL or Oracle " +
      "connection defined in .pi/db.json and return the result as a markdown table.",
    promptSnippet: "Query MySQL/Oracle databases (read-only)",
    promptGuidelines: [
      "Use query_db to run read-only SQL against MySQL or Oracle connections named in .pi/db.json (project) or " +
        "~/.pi/db.json (global). It rejects everything except a single SELECT/SHOW/EXPLAIN/DESCRIBE/WITH statement. " +
        "Always constrain potentially large results with LIMIT (MySQL) or FETCH FIRST n ROWS ONLY (Oracle).",
      "Use query_db to inspect live sessions, transactions, and locks via system views: " +
        "information_schema.innodb_trx, information_schema.processlist, performance_schema.data_locks (MySQL); " +
        "v$session, v$transaction, v$lock (Oracle — the account needs SELECT privilege on them).",
    ],
    parameters: Type.Object({
      connection: Type.String({ description: "Connection alias defined in .pi/db.json" }),
      sql: Type.String({ description: "A single read-only SQL statement" }),
      maxRows: Type.Optional(
        Type.Number({ description: `Row cap for the result (default ${DEFAULT_ROWS}, max ${HARD_ROW_CAP})` }),
      ),
    }),

    async execute(_toolCallId, params) {
      const connections = loadConnections();
      const cfg = connections[params.connection];
      if (cfg === undefined) {
        const known = Object.keys(connections);
        throw new Error(
          `unknown connection '${params.connection}' — ` +
            (known.length > 0
              ? `available: ${known.join(", ")}`
              : `no connections defined; create ${CONFIG_PATHS[0]} (see pi-db README)`),
        );
      }

      assertReadOnly(params.sql);
      const maxRows = Math.min(Math.max(1, Math.floor(params.maxRows ?? DEFAULT_ROWS)), HARD_ROW_CAP);

      let result: QueryResult;
      if (cfg.driver === "mysql") result = await runMysql(cfg, params.sql);
      else if (cfg.driver === "oracle") result = await runOracle(cfg, params.sql, maxRows);
      else {
        throw new Error(
          `connection '${params.connection}': unsupported driver '${(cfg as { driver?: string }).driver}' (use "mysql" or "oracle")`,
        );
      }

      const capped = result.rows.length > maxRows;
      const rows = capped ? result.rows.slice(0, maxRows) : result.rows;

      let text = toMarkdown(result.columns, rows) + `\n\n(${rows.length} row${rows.length === 1 ? "" : "s"})`;
      if (capped) text += `\n[showing first ${maxRows} rows — add LIMIT / FETCH FIRST, or raise maxRows]`;
      const truncated = text.length > MAX_CHARS;
      if (truncated) text = text.slice(0, MAX_CHARS) + `\n\n[truncated at ${MAX_CHARS} chars]`;

      return {
        content: [{ type: "text" as const, text }],
        details: { connection: params.connection, driver: cfg.driver, rows: rows.length, capped, truncated },
      };
    },
  });
}
