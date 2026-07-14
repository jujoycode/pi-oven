# pi-log

서버 로그를 읽고·감시하고·뒤지는 세 개의 툴. 로컬 파일뿐 아니라 `.pi/log.json`에
등록한 **원격 서버(ssh)** 의 로그도 같은 인터페이스로 다룬다 — 서버와 로그 경로를
설정에 적어두면, "was1에 어제 결제 실패 있었어?" 한마디로 에이전트가 알아서 찾는다.

| 툴 | 역할 |
|---|---|
| `tail_log` | 대용량 로그의 마지막 N줄 — grep(정규식)+context 필터, 바이트 커서로 증분 조회, 로테이션 감지, `.gz`, euc-kr |
| `watch_log` | 패턴이 나타날 때까지 블로킹 대기 — 매치 시 직전 5줄+후행(스택트레이스) 문맥, 타임아웃이면 쌓인 줄 보고 |
| `search_log` | 이벤트 탐색 — 여러 파일/글롭(회전 `.gz` 포함)에서 정규식 매치+문맥을 grep 형식(`file:line:text`)으로 |

**의존성 제로** — `node:fs` + `node:zlib` + `node:child_process`(OpenSSH 클라이언트) + 내장
`TextDecoder`. 원격 접속은 시스템 ssh를 그대로 쓰므로 기존 키·`~/.ssh/config`·점프호스트
설정이 전부 통하고, 폐쇄망에서도 동작한다.

## 서버 설정

`.pi/log.json`(프로젝트) 또는 `~/.pi/log.json`(전역, 프로젝트가 우선):

```json
{
  "was1": {
    "host": "deploy@10.1.2.3",
    "port": 22,
    "args": ["-i", "~/.ssh/deploy_key", "-J", "jump.internal"],
    "logs": ["/logs/app*.log", "/logs/app*.log.*.gz"]
  }
}
```

- `host`는 `user@host` 또는 ssh config 별칭. `args`는 ssh에 그대로 붙는다.
- `logs`는 이 서버의 기본 로그 경로/글롭 — `search_log`가 `files` 없이 호출되면 이걸 뒤진다.
- 원격 명령은 stat/tail/head/gunzip/zgrep 조합의 **읽기 전용으로 고정**되고, 경로는 안전
  문자셋 검증·패턴은 따옴표 인용으로 주입을 차단한다. 검색은 서버 쪽 zgrep이라
  매치만 네트워크를 탄다.

## 사용 흐름

```
> app.log 마지막 200줄에서 ERROR 주변 3줄씩 보여줘          # tail_log(grep, context)
> was1 서버에 어제 결제 실패 이벤트 있었는지 찾아봐          # search_log(server, pattern: "2026-07-13.*결제.*실패")
> 서버 재시작할게, started 뜰 때까지 지켜봐                  # watch_log(pattern)
> 아까 본 이후로 새로 쌓인 로그만 줘                         # tail_log(since: 이전 cursor)
```

- `tail_log`는 매 결과에 **cursor**(바이트 오프셋)를 돌려준다. 다음 호출에 `since`로
  넘기면 새로 쌓인 줄만 온다 — 원격에서도 동일하게 동작한다.
- `watch_log`는 호출 시점의 파일 끝부터만 본다(기존 에러에 낚이지 않는다). 폴링은
  로컬 400ms, 원격 2초(ssh 왕복 비용). 타임아웃은 에러가 아니라 도착한 줄 보고다.
- `search_log`는 시간 범위를 정규식에 날짜를 넣어 좁힌다(예: `2026-07-13.*fail`) —
  로그마다 제각각인 타임스탬프 포맷을 파싱하는 대신 에이전트가 패턴으로 해결한다.
  원격 euc-kr 로그는 ASCII 패턴 검색만 정확하다(패턴이 utf-8로 전달되므로).

## 의도적으로 만들지 않은 것

- 상주 데몬·백그라운드 워처 — 툴은 호출 동안만 감시한다(타임아웃 최대 600초)
- 타임스탬프 파싱 기반 시간 필터 — 날짜 문자열을 패턴에 넣는 것으로 충분하다
- 중앙 로그 시스템(ELK/Loki) 클라이언트 — 그건 HTTP API의 일이고 필요해지면 그때
- JSON 로그 구조화 파싱 — grep이면 에이전트가 알아서 한다

## 테스트

`test/log.test.mjs` — 21케이스: 7MB 역방향 tail, 커서 증분, 로테이션, gz, euc-kr,
watch 매치/타임아웃/취소, search 글롭·gz·상한, 그리고 **루프백 sshd를 통한 실제
원격 모드**(tail/since/gz/zgrep 검색/watch). CI(`.github/workflows/pi-log-test.yml`)는
러너에 sshd를 세워 같은 스크립트를 돌린다:

```bash
node --experimental-strip-types packages/pi-log/test/log.test.mjs          # 로컬만
PI_LOG_SSH_HOST=me@127.0.0.1 PI_LOG_SSH_KEY=~/.ssh/key \
  node --experimental-strip-types packages/pi-log/test/log.test.mjs        # 원격 포함
```

## 설치

```bash
pi install npm:pi-log        # npm 배포 후
pi -e ./packages/pi-log      # 모노레포에서 바로
```
