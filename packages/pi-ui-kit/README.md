# pi-ui-kit

Pi 에이전트가 텍스트로 질문하는 대신 인터랙티브 터미널 UI를 쓰게 만드는 확장 모음.

## 포함된 툴

| 툴 | 용도 | UI |
|---|---|---|
| `ask_user` | 선택지 중 고르기 | 단일 선택(SelectList) / 다중 선택(체크박스) |
| `ask_text` | 짧은 자유 텍스트 답변 받기 | 입력 프롬프트 |
| `notify_os` | 터미널 밖에서도 보이는 알림 | Windows 토스트 / macOS / Linux 네이티브 알림 |

설치하면 세션 시작마다 마스코트 **Pai**(`╭◕‿◕╮`)가 헤더에서 마중 나온다.
`/pai` 커맨드로 아무 때나 소환할 수 있다 (로드 확인 겸용).

`notify_os`는 Windows(및 WSL)에서 `powershell.exe`로 토스트를 직접 띄우므로
터미널이 백그라운드여도 알림이 보인다. `/notify-test` 커맨드로 즉시 테스트 가능.

각 툴의 `promptGuidelines`가 시스템 프롬프트에 자동 주입되므로,
에이전트는 별도 지시 없이도 선택형 질문에 `ask_user`를 쓰도록 유도된다.
작은 모델(예: Qwen 계열)이 툴을 안 부르면 프롬프트에 "ask_user로 물어봐"라고 한 번 언급하면 된다.

## 설치

```bash
# 로컬에서 임시로 테스트 (설치 없이 현재 세션만)
pi -e ./pi-ui-kit

# 로컬 경로로 설치 (settings.json의 packages에 경로 추가)
# 또는 git에 올린 뒤:
pi install git:github.com/<you>/pi-ui-kit

# npm에 배포한 뒤:
pi install npm:pi-ui-kit
```

설치 후 세션에서 `/ask-demo` 를 치면 로드 확인용 안내가 뜬다.

## 테스트

```
> use ask_user to ask me which framework I prefer between React, Vue, Svelte
> use ask_user (multi) to ask which features to include: tests, lint, CI, docs
> use ask_text to ask me the project name
```

## 확장 아이디어

- 진행 상황 위젯: 에디터 위에 고정되는 태스크 진행 바
- diff 프리뷰 선택기: 변경 파일 목록에서 골라 diff 보기
- 플랜 승인 UI: 에이전트 계획을 항목별로 승인/거부

새 확장은 `extensions/` 에 `.ts` 파일 하나 추가하면 자동 로드된다.
Pi 자신에게 "pi-ui-kit에 XX 확장 추가해줘"라고 시켜도 된다.

## 호환성 주의

구버전 Pi(`@mariozechner/*` 네임스페이스)를 쓰는 경우 import를 다음으로 교체:

- `@earendil-works/pi-coding-agent` → `@mariozechner/pi-coding-agent`
- `@earendil-works/pi-tui` → `@mariozechner/pi-tui`
- `@earendil-works/pi-ai` → `@mariozechner/pi-ai`
- `typebox` → `@sinclair/typebox`
