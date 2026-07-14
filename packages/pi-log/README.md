# pi-log

서버 로그를 읽고 감시하는 두 개의 툴. 내장 read는 GB급 로그를 통째로 올리다 죽고,
"에러 날 때까지 지켜보기"는 아예 못 한다.

| 툴 | 역할 |
|---|---|
| `tail_log` | 대용량 로그의 마지막 N줄을 역방향으로 읽기 — grep(정규식)+context 필터, 바이트 커서로 증분 조회, 로테이션 감지, `.gz` 회전 로그, euc-kr |
| `watch_log` | 패턴이 나타날 때까지 블로킹 대기 — 매치되면 직전 5줄 + 후행(스택트레이스) 문맥과 함께 반환, 타임아웃이면 그동안 쌓인 줄을 보고 |

**의존성 제로** — `node:fs` + `node:zlib` + 내장 `TextDecoder`.
폐쇄망 서버에서 파일 복사만으로 동작한다.

## 사용 흐름

```
> app.log 마지막 200줄에서 ERROR 주변 3줄씩 보여줘        # tail_log(grep, context)
> 서버 재시작할게, started 뜰 때까지 지켜봐                # watch_log(pattern)
> 아까 본 이후로 새로 쌓인 로그만 줘                       # tail_log(since: 이전 cursor)
```

- `tail_log`는 매 결과에 **cursor**(바이트 오프셋)를 돌려준다. 다음 호출에 `since`로
  넘기면 새로 쌓인 줄만 온다 — 재기동/배포 전후 비교가 폴링 없이 된다.
- `watch_log`는 호출 시점의 파일 끝부터만 본다(기존 에러에 낚이지 않는다).
  매치 직후 1.5초/40줄을 더 모아 스택트레이스까지 붙여준다.
  타임아웃은 에러가 아니다 — 대신 뭐가 로깅됐는지를 돌려주므로 그걸로 원인을 좁힌다.
- 원격 서버 로그는 pi의 bash(ssh)로 내려받거나 마운트된 경로를 쓴다 —
  이 툴은 로컬 파일 시스템만 담당한다.

## 의도적으로 만들지 않은 것

- 상주 데몬·백그라운드 워처 — 툴은 호출 동안만 감시한다(타임아웃 최대 600초).
  세션을 넘어서는 감시는 에이전트가 반복 호출로 해결한다
- ssh/원격 tail — bash가 이미 한다
- 로그 파싱/구조화(JSON 로그 필드 추출 등) — grep이면 에이전트가 알아서 한다

## 테스트

동작 테스트는 `test/log.test.mjs` — 7MB 파일 역방향 tail, 커서 증분, 로테이션,
gz, euc-kr, watch의 매치/타임아웃/취소까지 11케이스:

```bash
node --experimental-strip-types packages/pi-log/test/log.test.mjs
```

## 설치

```bash
pi install npm:pi-log        # npm 배포 후
pi -e ./packages/pi-log      # 모노레포에서 바로
```
