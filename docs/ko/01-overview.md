# 개요

[← 목차](README.md)

**Claude Code**를 위한 독립 실행형 Node 서버: 토큰 사용량 분석, 이상 탐지 및 프록시 모니터링. **`~/.claude/projects/**/*.jsonl`** 파일 및 **Claude Desktop App** 세션 로그(자동 감지)를 읽어 사용량, 휴리스틱 제한 및 포렌식을 웹 UI에 표시합니다. **`claude-*`** 모델만 집계됩니다 (`<synthetic>` 제외).

## 기능 (간략 개요)

### Health Score (신호등)

- **14개 지표**를 녹색/황색/적색으로 표시: Quota 5h, Thinking Gap, Cache Health, Error Rate, Hit Limits, 지연시간, Interrupts, Cold Starts, Retries, False 429 (B3), Truncations (B5), Context Resets (B4), Tokens/1 % Quota, 비정상 중단
- **Score 0–10** 및 전체 기간 트렌드 차트
- **핵심 소견** — 자동 계산된 힌트 (Thinking-Gap, Overhead, Cache-Paradox 등)
- **ArkNill-Bugs** B1–B8 (예: False 429, Context Stripping, Tool Truncation)
- 접기 가능: 컴팩트한 신호등 라인

### Proxy Analytics

- NDJSON 로깅을 지원하는 투명 HTTPS 프록시
- 통계 카드, 토큰 비용 (Cache Read / Creation / Output), 지연시간, 모델 분포, 시간별 부하
- Cold-Starts, SSE `stop_reason`, JSONL 대 Proxy 비교 (Thinking 중복)

### Status & Incidents

- 장애 시간, Hit-Limits, Extension 업데이트 (Marketplace + GitHub)
- Top-Bar에 실시간 **Anthropic** 뱃지 표시

### Token Stats

- 카드 및 네 가지 주요 차트 (일별 소비량, Cache:Output, Output/시간, Subagent-Cache)
- 섹션 접기 가능

### 포렌식

- JSONL의 Hit-Limits, Session 신호, Service-Impact 대 작업시간, Cache-Read 상관관계, Markdown 보고서

### Multi-Host

- 다중 소스 (`HOST-*`), 호스트 필터, Auto-Discovery, 선택적 로그 HTTP 동기화

### 내비게이션

- 날짜 범위, 카드/테이블용 일자, 범위 전체 기간 / 24시간, 소스 전체 또는 호스트별

## 아키텍처

```
start.js (dashboard | both | proxy | forensics)
  ├── scripts/dashboard-server.js    # HTTP + SSE + Parsing
  ├── scripts/dashboard-http.js
  ├── scripts/anthropic-proxy-cli.js # Proxy → NDJSON
  ├── scripts/usage-scan-roots.js
  ├── scripts/service-logger.js
  ├── tpl/dashboard.html
  ├── tpl/de/ui.tpl + tpl/en/ui.tpl  # i18n (JSON)
  ├── public/js/dashboard.client.js
  └── public/css/dashboard.css
```

도우미: `scripts/extract-dashboard-assets.js`, CLI `scripts/token-forensics.js`; 루트 별칭 `claude-usage-dashboard.js` → `server.js`.

## 저장소 참고사항

이 저장소는 **Whitelist** 방식의 [`.gitignore`](../../.gitignore) 를 사용합니다 (모든 파일을 무시한 후 `!`로 허용). **`docs/`**, **`k8s/`**, Dockerfile 및 **`images/`** 는 존재하는 경우 버전 관리됩니다. 시크릿은 커밋하지 **마십시오** (**`.env`**, 토큰, 개인 경로가 포함된 `HOST-*` 사본).

## 참고 자료

- [Claude Code Hidden Problem Analysis](https://github.com/ArkNill/claude-code-hidden-problem-analysis) — 이상 탐지 기반 (B1–B8)
- Quota 벤치마크: 약 1 % ≈ 1.5–2.1 M 가시 토큰 (ArkNill)
