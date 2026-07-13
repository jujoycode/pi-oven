/**
 * integration.mjs — pi-db 통합 테스트
 *
 * 실제 MySQL·Oracle에 붙어 query_db 툴의 전체 경로를 검증한다:
 * 설정 파일 로드 → 별칭 해석 → 읽기 전용 가드 → 드라이버 실행 → 마크다운 렌더링,
 * 그리고 열린 트랜잭션이 시스템 뷰(innodb_trx / v$transaction)로 보이는지까지.
 *
 * 실행 (Node 22+, 레포 루트에서 npm install 선행):
 *   node --experimental-strip-types packages/pi-db/test/integration.mjs
 *
 * 접속 대상은 환경변수로 바꿀 수 있다 (기본값은 로컬 도커/CI 서비스 컨테이너):
 *   MYSQL_HOST/MYSQL_PORT/MYSQL_ROOT_PASSWORD, ORACLE_HOST/ORACLE_PORT/
 *   ORACLE_PASSWORD(system)/APP_USER/APP_USER_PASSWORD
 *   SKIP_ORACLE=1 이면 Oracle 파트를 건너뛴다.
 */

import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const env = (k, d) => process.env[k] ?? d;

const MYSQL = {
  driver: "mysql",
  host: env("MYSQL_HOST", "127.0.0.1"),
  port: Number(env("MYSQL_PORT", "3306")),
  user: "root",
  password: env("MYSQL_ROOT_PASSWORD", "rootpw"),
  database: "testdb",
};
const ORACLE_APP = {
  driver: "oracle",
  user: env("APP_USER", "testuser"),
  password: env("APP_USER_PASSWORD", "testpw"),
  connectString: `${env("ORACLE_HOST", "127.0.0.1")}:${env("ORACLE_PORT", "1521")}/FREEPDB1`,
};
const ORACLE_ADMIN = {
  driver: "oracle",
  user: "system",
  password: env("ORACLE_PASSWORD", "oraclepw"),
  connectString: ORACLE_APP.connectString,
};
const SKIP_ORACLE = process.env.SKIP_ORACLE === "1";

// ---------------------------------------------------------------- 준비: .pi/db.json → chdir → 툴 로드

const workDir = mkdtempSync(join(tmpdir(), "pi-db-test-"));
mkdirSync(join(workDir, ".pi"));
writeFileSync(
  join(workDir, ".pi", "db.json"),
  JSON.stringify({ my: MYSQL, ora: ORACLE_APP, ora_admin: ORACLE_ADMIN }, null, 2),
);
process.chdir(workDir); // CONFIG_PATHS가 cwd 기준이므로 import 전에 이동

const extPath = fileURLToPath(new URL("../extensions/query-db.ts", import.meta.url));
const { default: register } = await import(extPath);
let tool;
register({ registerTool: (def) => (tool = def), on: () => {} });
if (!tool) throw new Error("extension did not register a tool");

const run = (params) => tool.execute("t1", params);
const text = (r) => r.content[0].text;

// ---------------------------------------------------------------- 테스트 러너

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
function expect(cond, msg) {
  if (!cond) throw new Error(msg);
}
async function retry(label, fn, tries = 30, delayMs = 5000) {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i >= tries) throw e;
      console.log(`  waiting for ${label} (${i}/${tries}): ${e.message?.split("\n")[0]}`);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

// ---------------------------------------------------------------- MySQL

const mysql = await import("mysql2/promise");
const { driver: _d, ...mysqlConnOpts } = MYSQL; // mysql2는 모르는 키에 경고를 낸다
const myAdmin = await retry("mysql", () =>
  mysql.createConnection({ ...mysqlConnOpts, multipleStatements: true, connectTimeout: 3000 }),
);
await myAdmin.query(
  "DROP TABLE IF EXISTS demo; CREATE TABLE demo (id INT PRIMARY KEY, name VARCHAR(50), note VARCHAR(50)); " +
    "INSERT INTO demo VALUES (1,'alpha','x'),(2,'beta|pipe','y'),(3,'gamma',NULL),(4,'delta','z'),(5,'epsilon','w');",
);

await check("mysql: SELECT renders markdown table", async () => {
  const r = await run({ connection: "my", sql: "SELECT id, name, note FROM demo ORDER BY id" });
  expect(text(r).includes("| id | name | note |"), "header row missing");
  expect(text(r).includes("| 2 | beta\\|pipe | y |"), "pipe escaping broken: " + text(r));
  expect(text(r).includes("| 3 | gamma | NULL |"), "NULL rendering broken");
  expect(text(r).includes("(5 rows)"), "row count missing");
  expect(r.details.driver === "mysql" && r.details.rows === 5, "details wrong");
});

await check("mysql: DESCRIBE works", async () => {
  const r = await run({ connection: "my", sql: "DESCRIBE demo" });
  expect(text(r).includes("id") && text(r).includes("int"), "describe output missing columns");
});

await check("mysql: maxRows caps result", async () => {
  const r = await run({ connection: "my", sql: "SELECT * FROM demo", maxRows: 2 });
  expect(r.details.rows === 2 && r.details.capped === true, "cap not applied");
  expect(text(r).includes("[showing first 2 rows"), "cap note missing");
});

await check("mysql: UPDATE is rejected before reaching the DB", async () => {
  let threw = false;
  try {
    await run({ connection: "my", sql: "UPDATE demo SET name='pwned'" });
  } catch (e) {
    threw = true;
    expect(/read-only/.test(e.message), "unexpected error: " + e.message);
  }
  expect(threw, "UPDATE was not rejected");
  const [rows] = await myAdmin.query("SELECT COUNT(*) c FROM demo WHERE name='pwned'");
  expect(rows[0].c === 0, "row was modified!");
});

await check("mysql: open transaction is visible via innodb_trx", async () => {
  await myAdmin.query("BEGIN; UPDATE demo SET note='locked' WHERE id=1;"); // 커밋하지 않는다
  try {
    const r = await run({
      connection: "my",
      sql: "SELECT trx_state, trx_rows_locked FROM information_schema.innodb_trx",
    });
    expect(text(r).includes("RUNNING"), "open trx not visible: " + text(r));
  } finally {
    await myAdmin.query("ROLLBACK");
  }
});

await check("unknown connection lists available aliases", async () => {
  let msg = "";
  try {
    await run({ connection: "nope", sql: "SELECT 1" });
  } catch (e) {
    msg = e.message;
  }
  expect(msg.includes("available: my, ora, ora_admin"), "alias list missing: " + msg);
});

await myAdmin.end();

// ---------------------------------------------------------------- Oracle

if (SKIP_ORACLE) {
  console.log("SKIP oracle (SKIP_ORACLE=1)");
} else {
  const oracledb = (await import("oracledb")).default;
  const oraApp = await retry("oracle", () =>
    oracledb.getConnection({ user: ORACLE_APP.user, password: ORACLE_APP.password, connectString: ORACLE_APP.connectString }),
  );
  try {
    await oraApp.execute("DROP TABLE demo PURGE");
  } catch {
    /* 첫 실행이면 없음 */
  }
  await oraApp.execute("CREATE TABLE demo (id NUMBER PRIMARY KEY, name VARCHAR2(50))");
  for (const [id, name] of [[1, "alpha"], [2, "beta"], [3, "gamma"]]) {
    await oraApp.execute("INSERT INTO demo VALUES (:1, :2)", [id, name]);
  }
  await oraApp.commit();

  await check("oracle: SELECT via thin mode renders markdown table", async () => {
    const r = await run({ connection: "ora", sql: "SELECT id, name FROM demo ORDER BY id" });
    expect(text(r).includes("| ID | NAME |"), "header missing: " + text(r));
    expect(text(r).includes("| 1 | alpha |") && text(r).includes("(3 rows)"), "rows wrong: " + text(r));
    expect(r.details.driver === "oracle", "details wrong");
  });

  await check("oracle: FETCH FIRST + dual work", async () => {
    const r = await run({ connection: "ora", sql: "SELECT 42 AS answer FROM dual FETCH FIRST 1 ROWS ONLY" });
    expect(text(r).includes("| 42 |"), "dual query broken: " + text(r));
  });

  await check("oracle: DROP is rejected", async () => {
    let threw = false;
    try {
      await run({ connection: "ora", sql: "DROP TABLE demo" });
    } catch (e) {
      threw = true;
      expect(/read-only/.test(e.message), "unexpected error: " + e.message);
    }
    expect(threw, "DROP was not rejected");
  });

  await check("oracle: open transaction is visible via v$transaction", async () => {
    await oraApp.execute("UPDATE demo SET name='locked' WHERE id=1"); // 커밋하지 않는다
    try {
      const r = await run({
        connection: "ora_admin",
        sql: "SELECT status, used_urec FROM v$transaction",
      });
      expect(text(r).includes("ACTIVE"), "open trx not visible: " + text(r));
    } finally {
      await oraApp.rollback();
    }
  });

  await oraApp.close();
}

// ----------------------------------------------------------------

console.log(failures === 0 ? "\nALL OK" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
