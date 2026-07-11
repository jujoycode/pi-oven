# pi-hwp

한글 문서(.hwpx, .hwp)를 읽는 `read_hwp` 툴. pi 내장 read는 이 포맷들을 못 읽는다.

| 포맷 | 방식 | 지원 |
|---|---|---|
| `.hwpx` | ZIP + OWPML XML | 본문, 표(행 단위) |
| `.hwp` (5.x) | CFB 바이너리 + 레코드 스트림 | 본문, 압축 문서 |
| 암호화 / 배포용(DRM) | — | 명확한 에러로 거절 |
| `.hwp` (3.0) | — | 미지원 |
| 내장 이미지 | BinData | 추출 + 경로 나열, `images: true`면 비전 첨부 |

내장 이미지는 임시 파일로 추출되고 기본은 경로 나열만 — 이미지 토큰을
매 턴 지불하지 않는다. 스캔 문서·차트처럼 이미지 내용이 필요하면 에이전트가
`images: true`로 다시 호출해 비전 모델에 첨부한다(png/jpg/gif/webp,
최대 8장·장당 4MB). 이 판단은 promptGuidelines로 유도되므로 별도 지시가 필요 없다.
텍스트 전용 모델에서는 pi가 첨부를 자동 생략하므로 안전하다.

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
