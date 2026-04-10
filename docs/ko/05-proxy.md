# Anthropic Monitor Proxy

[← 목차](README.md)

구현: **`scripts/anthropic-proxy-core.js`**, **`scripts/anthropic-proxy-cli.js`**. 스크립트에 추가 npm 의존성 없는 선택적 **HTTP-Forward-Proxy**: **`https://api.anthropic.com`** (또는 **`--upstream`**) 으로의 요청.

## 시작

```bash
node start.js proxy --port=8080
```

루트 동등 명령: `node anthropic-proxy.js --port=8080`.

## Claude를 프록시로 연결

로컬:

```bash
ANTHROPIC_BASE_URL=http://127.0.0.1:8080 claude
```

네트워크 / 배포 환경 (이것은 **플레이스홀더** — 스키마와 포트를 Ingress에 맞게 조정):

```bash
ANTHROPIC_BASE_URL=http://proxy.host.domain.tld:8080 claude
```

**Dashboard**는 일반적으로 **다른** 호스트네임 URL에 있습니다. 예: **`https://dashboard.host.domain.tld`** (웹 UI **3333** 또는 HTTPS); **Proxy**는 **`proxy.host.domain.tld:8080`** — 설치 방식에 따라 두 개의 별도 진입점 또는 경로 라우팅을 사용하는 하나의 호스트.

## 로깅 (NDJSON)

완료된 각 Upstream 응답: **`~/.claude/anthropic-proxy-logs/proxy-YYYY-MM-DD.ndjson`** 에 **한 줄** 기록 (재정의: **`ANTHROPIC_PROXY_LOG_DIR`**).

주요 필드: **`ts_start`/`ts_end`**, **`duration_ms`**, **`path`**, **`upstream_status`**, **`usage`** (`cache_read_input_tokens`, `cache_creation_input_tokens` 포함), **`cache_read_ratio`**, **`cache_health`**:

- **`healthy`:** (Read + Creation) 대비 Cache-Read 비율 ≥ **80 %**
- **`affected`:** Cache 트래픽이 있는 상태에서 비율 **< 40 %** (Creation 많음, Read 적음)
- **`mixed`**, **`na`**, **`unknown`** — 상황에 따라 다름

**Rate Limits 및 메타데이터:** **`request_meta`**, **`response_anthropic_headers`** (예: `anthropic-ratelimit-*`, `request-id`, `cf-ray`).

## Subagents, Tools, JSONL 매칭

- Proxy는 HTTP를 확인 (예: `tools`, `tool_use` / `tool_result`); **`request_hints`** / **`response_hints`**.
- Subagent 세션은 주로 **JSONL 경로** (`subagent`)에서 확인.
- **`ANTHROPIC_PROXY_ALIGN_JSONL=1`** 사용 시: 인접한 JSONL 라인에 매칭 → **`jsonl_alignment`** 에 **`is_subagent_path`** 포함.

추가 변수: **`ANTHROPIC_PROXY_LOG_STDOUT=1`**, **`ANTHROPIC_PROXY_LOG_BODIES=1`** (주의: 시크릿 포함 가능), **`ANTHROPIC_PROXY_JSONL_ROOTS`**, **`ANTHROPIC_PROXY_BIND`**.

도움말: `node start.js proxy -- --help` 또는 `node anthropic-proxy.js --help`.

## 리버스 프록시 뒤 / 컨테이너 내

일반적으로 **`ANTHROPIC_PROXY_BIND=0.0.0.0`**, 포트 **8080**, 외부에서 접근 가능한 서비스 — 로컬과 동일한 매개변수이며, 네트워크/노출은 운영 사안입니다 (`docs/` 저장소 문서의 범위 밖).
