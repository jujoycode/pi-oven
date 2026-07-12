# pi-db

MySQL·Oracle에 읽기 전용 SQL을 실행하는 `query_db` 툴. 에이전트가 스키마 확인,
데이터 조회, 그리고 **지금 어떤 트랜잭션이 락을 잡고 있는지**까지 시스템 뷰 질의로
직접 확인한다.

| DBMS | 드라이버 | 방식 |
|---|---|---|
| MySQL / MariaDB | mysql2 | 순수 JS, 바이너리 불필요 |
| Oracle | node-oracledb **Thin 모드** | 순수 JS, Oracle Client 설치 불필요 |
| 그 외 / 쓰기 SQL | — | 명확한 에러로 거절 |

이 패키지는 pi-oven에서 예외적으로 런타임 의존성 2개를 가진다 — DB 와이어 프로토콜은
Node 빌트인이 없고, Oracle TNS는 비공개 프로토콜이라 수제 구현 대상이 아니다.
둘 다 순수 JS라 네이티브 애드온 반입 없이 폐쇄망에서도 동작한다.

## 접속 설정

크리덴셜은 대화가 아니라 설정 파일에 둔다. 툴은 별칭만 받으므로 접속 정보가
세션 컨텍스트와 로그에 남지 않는다. `.pi/db.json`(프로젝트) 또는
`~/.pi/db.json`(전역, 프로젝트가 우선):

```json
{
  "erp": {
    "driver": "mysql",
    "host": "db.internal", "port": 3306,
    "user": "readonly", "password": "...", "database": "erp"
  },
  "hr": {
    "driver": "oracle",
    "user": "readonly", "password": "...",
    "connectString": "db.internal:1521/ORCLPDB1"
  }
}
```

파일 권한은 `chmod 600`을 권장하고, 계정은 읽기 전용 계정 발급을 권장한다
(툴도 이중으로 막지만 최후의 방어선은 DB 권한이다).

## 읽기 전용 강제

- `SELECT / SHOW / EXPLAIN / DESCRIBE / WITH`로 시작하는 **단일 문**만 허용
- 문자열·주석·따옴표 식별자를 벗겨낸 뒤 DML/DDL 키워드(`INSERT/UPDATE/DELETE/DROP/...`)가
  보이면 거절 — CTE 뒤에 숨긴 쓰기, `SELECT ... FOR UPDATE`의 락 획득까지 차단
- 행 상한(기본 100, 최대 1,000) + 200k 자 절단, 초과 시 `[truncated ...]` 표시

## 테스트

```
> erp에서 최근 주문 10건 보여줘
> hr 디비에 지금 락 잡고 있는 트랜잭션 있어?
```

실 DB 통합 테스트는 `test/integration.mjs` — 도커로 MySQL 8.4 + Oracle Free 23을
띄우고 마크다운 렌더링, 읽기 전용 거절, 열린 트랜잭션의 시스템 뷰 노출까지 검증한다.
CI(`.github/workflows/pi-db-integration.yml`)는 pi-db가 바뀔 때 같은 스크립트를
서비스 컨테이너로 돌린다:

```bash
docker run -d -e MYSQL_ROOT_PASSWORD=rootpw -e MYSQL_DATABASE=testdb -p 3306:3306 mysql:8.4
docker run -d -e ORACLE_PASSWORD=oraclepw -e APP_USER=testuser -e APP_USER_PASSWORD=testpw -p 1521:1521 gvenzl/oracle-free:23-slim
node --experimental-strip-types packages/pi-db/test/integration.mjs
```

`promptGuidelines`가 주입되므로 에이전트는 트랜잭션·락 질문에
`information_schema.innodb_trx`(MySQL), `v$transaction`·`v$lock`(Oracle) 같은
시스템 뷰를 알아서 질의한다.

## 의도적으로 만들지 않은 것

- 쓰기(DML/DDL) — 이 툴의 정체성은 읽기 전용이다
- binlog(MySQL)·LogMiner(Oracle) 실시간 트랜잭션 스트리밍 — 상주 프로세스가 필요해
  단일 파일 확장의 그릇을 넘는다
- 커넥션 풀 — 호출마다 접속·해제한다. 에이전트 사용 빈도에서는 충분하다

## 설치

```bash
pi install npm:pi-db         # npm 배포 후
pi -e ./packages/pi-db       # 모노레포에서 바로 (npm install 선행)
```
