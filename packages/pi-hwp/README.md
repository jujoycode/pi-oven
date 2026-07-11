# pi-hwp

한글 문서(.hwpx, .hwp)를 읽는 `read_hwp` 툴. pi 내장 read는 이 포맷들을 못 읽는다.

| 포맷 | 방식 | 지원 |
|---|---|---|
| `.hwpx` | ZIP + OWPML XML | 본문, 표(행 단위) |
| `.hwp` (5.x) | CFB 바이너리 + 레코드 스트림 | 본문, 압축 문서 |
| 암호화 / 배포용(DRM) | — | 명확한 에러로 거절 |
| `.hwp` (3.0) | — | 미지원 |

**의존성 제로** — npm 의존성도, 네이티브 애드온도 없다 (압축 해제는 Node 내장 zlib).
내부망·폐쇄망에서도 파일 복사만으로 동작한다.

## 설치

```bash
pi install npm:pi-hwp        # npm 배포 후
pi -e ./packages/pi-hwp      # 모노레포에서 바로
```

## 테스트

```
> read_hwp로 ~/문서/보고서.hwpx 읽고 요약해줘
```

`promptGuidelines`가 주입되므로 에이전트는 .hwp/.hwpx 파일을 만나면
내장 read 대신 이 툴을 쓴다.
