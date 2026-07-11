# pi-odt

OpenDocument Text(.odt)를 읽는 `read_odt` 툴. ODT는 ZIP이라 pi 내장 read로는 못 읽는다.

- 제목(`text:h`)은 outline level에 따라 마크다운 `#`으로
- 표는 행 단위 `| 셀 | 셀 |`로
- 공백 압축(`text:s`), 탭, 줄바꿈 처리

외부 의존성 없음 — ZIP 파서 내장, 압축 해제는 node:zlib.

## 설치

```bash
pi install npm:pi-odt        # npm 배포 후
pi -e ./packages/pi-odt      # 모노레포에서 바로
```

## 테스트

```
> read_odt로 ~/Documents/notes.odt 읽고 요약해줘
```
