# 설치 및 운영

[← 목차](README.md)

## 시작

```bash
node server.js
```

또는:

```bash
node start.js                    # Default: dashboard
node start.js both               # Dashboard :3333 + Proxy :8080
node start.js dashboard
node start.js proxy
node start.js forensics
```

**Dashboard + Proxy를 하나의 터미널에서:** `node start.js both` — 포트 **3333** 및 **`ANTHROPIC_PROXY_PORT`** (기본값 **8080**).

## CLI 옵션

```bash
node server.js --port=4444 --refresh=300
node server.js --log-level=debug --log-file=$HOME/.claude/usage-dashboard-server.log
```

- **`--port`**: HTTP 포트 (기본값 `3333`).
- **`--log-level`**, **`--log-file`**: Server-Logging 참조; `CLAUDE_USAGE_LOG_*`에 해당.
- **`--refresh`**: 다음 전체 스캔 + SSE까지의 초 — **최소 60**, 기본값 **180**. 선택적으로 `CLAUDE_USAGE_SCAN_INTERVAL_SEC` (≥ 60)을 덮어씁니다.

## 서버 로깅

stderr로 출력, 선택적 파일: **`CLAUDE_USAGE_LOG_LEVEL`** = `error` | `warn` | `info` (기본값) | `debug` | `none`. 파일: **`CLAUDE_USAGE_LOG_FILE`**. CLI: **`--log-level=…`**, **`--log-file=…`**.

주제: **`scan`/`parse`**, **`cache`**, **`outage`**, **`releases`**, **`marketplace`**, **`github`**, **`i18n`**, **`server`**.

## 실시간 업데이트

- 열 때: `fetch('/api/usage')` + **SSE** (`/api/stream`).
- 녹색 점 = 연결됨; 빨간색 = 재연결.
- 첫 스캔: SSE를 통한 부분 결과 (`scan_progress`); 차트는 브라우저에서 디바운스됨 (약 **420 ms**). 선택사항 **`CLAUDE_USAGE_SCAN_FILES_PER_TICK`** (기본값 **20**, 범위 **1–80**).

## 빠른 시작 / 백그라운드 스캔

- 서버가 즉시 리스닝; 첫 파싱이 `listen` 전에 블로킹하지 않음.
- JSONL을 배치 단위로 처리 (파일 그룹 사이에 `setImmediate`).
- 첫 스캔 완료 전: 스텁 `scanning: true` + UI에 안내 표시.

## 일별 캐시

- 파일: **`~/.claude/usage-dashboard-days.json`**
- **캐시 버전**, **스캔 루트** 및 **`.jsonl` 수**가 일치하면: 이전 날짜는 파일에서, **오늘**만 전체 재집계. 사용 내역 없는 달력 공백은 전체 스캔을 강제하지 않음.
- **`hosts`** 는 버전 **3** 부터; 버전 **4** 일회성 무효화; 버전 **5** 에 **`session_signals`** 추가.
- 선택사항 **`CLAUDE_USAGE_SKIP_IDENTICAL_SCAN=1`**: mtime 변경 없으면 전체 스캔 건너뜀.
- **전체 스캔 강제:** `CLAUDE_USAGE_NO_CACHE=1`, 캐시 삭제, 다른 `.jsonl` 수, 변경된 루트 / `CLAUDE_USAGE_EXTRA_BASES`.

캐시, 릴리스, Marketplace 및 장애 JSON 경로: **Meta 패널** (펼치기).

## GitHub API (릴리스)

- 토큰 없이: IP당 약 **60 Requests/h**. 제한 도달 시: **`GITHUB_TOKEN`** 또는 **`GH_TOKEN`** (공개 저장소용 Classic PAT로 충분).
- **주기적 Fetch 없음:** **`~/.claude/claude-code-releases.json`** 이 없거나 비어있을 때만 네트워크 사용 — 그 외에는 디스크 캐시.
- 수동: **`POST /api/github-releases-refresh`**; 선택적으로 **`CLAUDE_USAGE_ADMIN_TOKEN`** 과 `Authorization: Bearer` 사용.
- 시작 시: **`CLAUDE_USAGE_GITHUB_RELEASES_FETCH=1`**.
- **UI:** Meta 펼치기, PAT 입력 → 해당 탭의 **`sessionStorage`** 에만 저장; 브라우저가 **`X-GitHub-Token`** 전송 (서버 GitHub 호출 시 우선 적용).

## Docker

**`docker compose`** 및 이미지: [7장 — Docker & CI](07-umgebung-api-deployment-dev.md#docker) 참조.
