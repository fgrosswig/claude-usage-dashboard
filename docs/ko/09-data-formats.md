# 데이터 형식

[← 목차](README.md)

대시보드는 **두 가지 서로 다른 데이터 소스**를 처리하며, 각각 고유한 파일 형식과 쓰기 경로를 가집니다:

1. **JSONL 세션 로그** — Claude Code(CLI, VS Code 확장, JetBrains 플러그인)가 작성
2. **프록시 NDJSON 로그** — 내장된 `scripts/anthropic-proxy-core.js`가 작성

이 장에서는 두 형식을 필드 단위로 문서화하여, 외부 소스(커뮤니티 연구자, 엔터프라이즈 설정, 대안 프록시 구현)가 호환 가능한 데이터를 생성하고 코어 코드를 수정하지 않고 대시보드에 공급할 수 있도록 합니다.

관련: 이슈 **#167**은 전체 로그 형식 어댑터 로드맵(내장 어댑터, 변환 CLI, 대시보드 서버의 라이브 어댑터)을 추적합니다.

---

## 1. JSONL 세션 로그

### 소스 및 위치

Claude Code는 세션당 하나의 JSONL 파일을 작성합니다:

```
~/.claude/projects/<project-slug>/<session-uuid>.jsonl
```

- 한 줄에 하나의 JSON 객체, **추가 전용(append-only)**
- 세션이 진행되는 동안 시간 순서대로 추가됨
- 쓴 후에는 수정되거나 잘리지 않음
- 하루에 여러 세션 → 여러 파일
- `<project-slug>`는 현재 작업 디렉터리에서 파생됨
- `<session-uuid>`는 UUID v4

### 레코드 유형

각 줄은 세션의 **이벤트** 하나를 나타냅니다. 대시보드는 `message.usage`가 있는 레코드(즉, 업스트림 API 응답이 있는 어시스턴트 턴)만 계산합니다. 일반적인 `type` 값:

| `type` | 의미 | 대시보드 관련? |
|---|---|---|
| `user` | 사용자 턴 (프롬프트, 도구 결과 등) | 아니오 — 토큰 수는 어시스턴트 턴에서 옴 |
| `assistant` | 업스트림 응답이 있는 어시스턴트 턴 | **예** — `message.usage`, `message.model`, `message.stop_reason` 포함 |
| `system` | 시스템 메시지 / 컨텍스트 업데이트 | 선택 — 엔트리포인트 감지용 |
| `summary` | 자동 생성된 세션 요약 | 아니오 |

### 대시보드가 사용하는 필드

| 필드 경로 | 타입 | 필수? | 용도 |
|---|---|---|---|
| `timestamp` | ISO-8601 문자열 | **예** | 일/시간 버킷 |
| `type` | 문자열 | 예 | 어시스턴트 턴 필터 |
| `message.model` | 문자열 | 예 | 모델 분석, `isClaudeModel()` 필터 |
| `message.usage.input_tokens` | 정수 | 예 | 일별 토큰 차트 |
| `message.usage.output_tokens` | 정수 | 예 | 일별 토큰 차트 |
| `message.usage.cache_read_input_tokens` | 정수 | 선택 | 캐시 추이, 예산 효율성 |
| `message.usage.cache_creation_input_tokens` | 정수 | 선택 | 캐시 추이, 예산 효율성 |
| `message.stop_reason` | 문자열 | 선택 | 중지 이유 차트 |
| `version` 또는 `cli_version` 또는 `claude_code_version` 또는 `extension_version` | 문자열 | 선택 | 버전 상태, 릴리스 안정성 |
| `message.cli_version` / `message.extension_version` / `message.client_version` / `message.claude_code_version` / `message.version` | 문자열 | 선택 | 버전 상태 (대체 위치) |
| `entrypoint` | 문자열 | 선택 | 엔트리포인트 분포 (`cli`, `vscode`, `intellij`, `web`, ...) |
| `sessionId` / `uuid` / `parentUuid` | 문자열 | 선택 | 세션 신호 추적 (중단, 재시도) |

### 의미론적 주의사항

- **토큰 수는 요청당이지 세션당이 아닙니다.** API를 호출한 각 어시스턴트 턴은 자체 usage 블록을 가집니다.
- **캐시 필드는 선택 사항입니다.** 콜드 스타트(캐시 미스 시 첫 요청)에서는 `cache_read_input_tokens = 0`이며 `cache_creation_input_tokens`가 높을 수 있습니다. 웜 턴에서는 두 캐시 필드가 일반적으로 원본 `input_tokens`보다 훨씬 큽니다.
- **`message.model`은 Claude 모델만 필터링합니다.** Claude가 아닌 모델(예: 임베딩 모델) 레코드는 `scripts/dashboard-server.js`의 `isClaudeModel()`로 건너뜁니다.
- **버전 감지는 유연합니다.** 여섯 개의 다른 필드 위치를 우선 순위대로 시도합니다(`rec.version`, `rec.cli_version`, `rec.claude_code_version`, `rec.extension_version`, `rec.message.*`). 비어 있지 않은 semver 형태 문자열이 이깁니다.
- **`hit_limit` 감지**는 원시 줄 텍스트를 속도 제한 키워드로 스캔합니다(`message.usage`와 별개).

### 예시 줄 (익명화됨)

```json
{"type":"assistant","timestamp":"2026-04-07T14:23:11.482Z","sessionId":"e1a2...","uuid":"b3c4...","parentUuid":"a1b2...","version":"2.1.96","entrypoint":"vscode","message":{"id":"msg_01...","type":"message","role":"assistant","model":"claude-opus-4-6","stop_reason":"end_turn","usage":{"input_tokens":1204,"output_tokens":487,"cache_read_input_tokens":85203,"cache_creation_input_tokens":0}}}
```

### 개인정보 경고

**JSONL 세션 로그에는 전체 프롬프트 및 응답 내용이 포함됩니다**(`message.content` 배열). 개인 데이터입니다. **수정 없이 JSONL 파일을 공유하거나 업로드하지 마세요.** 대시보드는 위에 나열된 메타데이터 필드만 읽으며 메시지 본문을 표시하거나 저장하지 않지만, 디스크의 파일 자체는 민감합니다.

---

## 2. 프록시 NDJSON 로그

### 소스 및 위치

`scripts/anthropic-proxy-core.js`는 달력일당 하나의 NDJSON 파일을 작성합니다:

```
~/.claude/anthropic-proxy-logs/proxy-YYYY-MM-DD.ndjson
```

- `ANTHROPIC_PROXY_LOG_DIR` 환경 변수로 경로 재정의 가능
- 한 줄에 하나의 JSON 객체, **추가 전용**
- **완료된 업스트림 응답**(성공 또는 오류)당 한 줄
- 응답 본문이 없는 오류는 건너뜀(`rec.error && !rec.ts_end`)

### 대시보드가 사용하는 필드

| 필드 경로 | 타입 | 필수? | 용도 |
|---|---|---|---|
| `ts_start` | ISO-8601 문자열 | 선택 | 요청 시작 |
| `ts_end` | ISO-8601 문자열 | **예** | 일/시간 버킷 (대체: `ts_start`) |
| `duration_ms` | 숫자 | 예 | 지연 시간 차트, 시간별 히트맵 |
| `upstream_status` | 정수 (HTTP 코드) | 예 | 오류율, 상태 코드 분석, 거짓 429 감지 |
| `usage.input_tokens` | 정수 | 예 | 일별 토큰 총합 |
| `usage.output_tokens` | 정수 | 예 | 일별 토큰 총합 |
| `usage.cache_read_input_tokens` | 정수 | 선택 | 캐시 읽기 비율, 예산 효율성 |
| `usage.cache_creation_input_tokens` | 정수 | 선택 | 캐시 생성, 예산 효율성 |
| `cache_read_ratio` | 0-1 부동 소수점 | 선택 | 콜드 스타트 감지 (< 0.5) |
| `cache_health` | `healthy` \| `mixed` \| `affected` \| `na` | 선택 | 캐시 상태 분석 |
| `request_hints.model` | 문자열 | 선택 | 모델 분석 |
| `response_hints.stop_reason` | 문자열 | 선택 | 중지 이유 차트 |
| `response_anthropic_headers["anthropic-ratelimit-unified-5h-utilization"]` | 문자열 (0-1 소수) | 선택 | 5시간 쿼터 게이지, 예산 효율성 |
| `response_anthropic_headers["anthropic-ratelimit-unified-7d-utilization"]` | 문자열 (0-1 소수) | 선택 | 7일 쿼터 게이지 |
| `response_anthropic_headers["anthropic-ratelimit-unified-fallback-percentage"]` | 문자열 (0-1 소수) | 선택 | 폴백 경고 배너, 용량 감소 신호 |
| `response_anthropic_headers["anthropic-ratelimit-unified-overage-status"]` | 문자열 (`accepted` \| `rejected` \| ...) | 선택 | 용량 경고 세부 정보 |
| `response_anthropic_headers["anthropic-ratelimit-unified-representative-claim"]` | 문자열 (예: `five_hour`) | 선택 | 용량 경고 세부 정보 |
| `response_anthropic_headers["cf-ray"]` | 문자열 | 선택 | 거짓 429 감지: `cf-ray`가 없는 429는 Anthropic이 아닌 클라이언트 생성 |

### 의미론적 주의사항

- **속도 제한 헤더는 분수(0-1)이며 백분율이 아닙니다.** 문자열 `"0.03"`은 3% 사용을 의미합니다. 대시보드는 표시를 위해 100을 곱합니다.
- **`cache_health`는 프록시가 계산**하며 다음 임계값을 사용합니다:
  - `healthy`: (읽기 + 생성) 중 캐시 읽기 비율 ≥ 80%
  - `affected`: 캐시 트래픽이 있지만 비율 < 40% (많은 생성, 적은 읽기)
  - `mixed`: 두 임계값 사이
  - `na` / `unknown`: 캐시 트래픽 없음 또는 불확정
- **`cold_starts` 카운터**는 200 응답에서 `cache_read_ratio < 0.5`일 때 증가 — 캐시 미스 버스트에 대한 휴리스틱
- **`context_resets` 카운터**는 B4 패턴을 감지합니다: 높은 캐시 읽기 단계 후 캐시 생성 급증
- **`false_429s` 카운터**는 B3 패턴을 감지합니다: `cf-ray` 헤더 없는 HTTP 429 응답(중간 미들웨어에서 생성, Anthropic의 속도 제한기가 아님)
- **속도 제한 스냅샷은 하루에 하나씩 보존되며 마지막 것이 우선**(`parseProxyNdjsonFiles`의 `dd.rate_limit_snapshots = [snap]`). 누적 쿼터 소비(`visible_tokens_per_pct`)를 위해 서버는 모든 q5 샘플을 시간순으로 수집하고 `computeQ5Consumption()`에서 양수 델타를 합산합니다.

### 예시 줄 (익명화됨)

```json
{"ts_start":"2026-04-07T14:23:11.200Z","ts_end":"2026-04-07T14:23:14.680Z","duration_ms":3480,"path":"/v1/messages","upstream_status":200,"usage":{"input_tokens":1204,"output_tokens":487,"cache_read_input_tokens":85203,"cache_creation_input_tokens":0},"cache_read_ratio":0.986,"cache_health":"healthy","request_hints":{"model":"claude-opus-4-6"},"response_hints":{"stop_reason":"end_turn"},"response_anthropic_headers":{"anthropic-ratelimit-unified-5h-utilization":"0.03","anthropic-ratelimit-unified-7d-utilization":"0.01","anthropic-ratelimit-unified-fallback-percentage":"1","cf-ray":"8a1b2c3d4e5f"}}
```

### 개인정보

프록시 NDJSON 로그는 **요청이나 응답 본문을 포함하지 않으며**, 헤더와 그에서 파생된 메타데이터만 포함합니다. JSONL 세션 로그보다 공유하기 안전하지만 여전히 다음을 포함합니다:

- 인증된 계정의 쿼터 상태(속도 제한 헤더를 통해)
- 요청 경로(어떤 엔드포인트가 호출되는지)
- 사용자를 핑거프린팅할 수 있는 타이밍 패턴

게시하기 전에 `response_anthropic_headers["cf-ray"]`와 내부 경로 세부 정보를 제거하세요.

---

## 3. 크로스 포맷 매핑 참조

어댑터 작성자용(이슈 #167): 이 표는 각 의미론적 개념이 각 형식으로 어떻게 매핑되고 어떤 대시보드 기능이 이를 소비하는지 보여줍니다.

| 개념 | JSONL 경로 | 프록시 NDJSON 경로 | 대시보드 기능 |
|---|---|---|---|
| 타임스탬프 | `timestamp` | `ts_end` | 일/시간 버킷 |
| 입력 토큰 | `message.usage.input_tokens` | `usage.input_tokens` | 일별 토큰, 예산 효율성 |
| 출력 토큰 | `message.usage.output_tokens` | `usage.output_tokens` | 일별 토큰, 예산 효율성 |
| 캐시 읽기 | `message.usage.cache_read_input_tokens` | `usage.cache_read_input_tokens` | 캐시 추이, 예산 효율성 |
| 캐시 생성 | `message.usage.cache_creation_input_tokens` | `usage.cache_creation_input_tokens` | 캐시 추이, 예산 효율성 |
| 모델 | `message.model` | `request_hints.model` | 모델 분석 |
| 중지 이유 | `message.stop_reason` | `response_hints.stop_reason` | 중지 이유 차트 |
| 지속 시간 | — (턴 간격에 암시) | `duration_ms` | 지연 시간 차트, 시간별 히트맵 |
| HTTP 상태 | — (암묵적 성공) | `upstream_status` | 오류율, 상태 코드 분석 |
| 5시간 쿼터 사용률 | — | `response_anthropic_headers["anthropic-ratelimit-unified-5h-utilization"]` | 5시간 연료 게이지, 예산 효율성 |
| 7일 쿼터 사용률 | — | `response_anthropic_headers["anthropic-ratelimit-unified-7d-utilization"]` | 7일 연료 게이지 |
| 쿼터 폴백 | — | `response_anthropic_headers["anthropic-ratelimit-unified-fallback-percentage"]` | 용량 경고 배너 |
| 속도 제한 이벤트 | `hit_limit` 키워드 스캔 | `upstream_status == 429` | 속도 제한 카운터 |
| 거짓 429 | — | `upstream_status == 429 && !response_anthropic_headers["cf-ray"]` | B3 거짓 429 카운터 |
| CLI 버전 | `version` 또는 `cli_version` 또는 `claude_code_version` 또는 `extension_version` | — | 버전 상태, 릴리스 안정성 |
| 엔트리포인트 | `entrypoint` | — | 엔트리포인트 분포 |
| 콜드 스타트 | — | `cache_read_ratio < 0.5 && upstream_status == 200` | 콜드 스타트 카운터 |

### 최소 유효 레코드

**프록시 NDJSON** 출력을 대상으로 하는 외부 어댑터의 경우, 대시보드가 레코드를 계산하기 위한 최소 요구사항은:

```json
{
  "ts_end": "2026-04-07T14:23:14.680Z",
  "duration_ms": 3480,
  "upstream_status": 200,
  "usage": {
    "input_tokens": 1204,
    "output_tokens": 487
  },
  "request_hints": {
    "model": "claude-opus-4-6"
  }
}
```

이는 일별 토큰 차트, 일별 호출 수, 지연 시간 차트, 모델 분석에 항목을 생성합니다. 속도 제한 헤더가 없으면 해당 날짜의 5시간/7일 쿼터 게이지와 예산 효율성 섹션은 비어 있습니다.

---

## 4. 어댑터 / 변환기 가이드

전체 어댑터 프레임워크는 이슈 **#167**에서 추적됩니다. 그것이 완료될 때까지 외부 소스는 작은 변환 스크립트로 호환 가능한 파일을 생성할 수 있습니다.

### 예시: LiteLLM 로그 → 프록시 NDJSON

LiteLLM은 `model`, `response_time`, `usage`, `status_code`와 같은 필드로 호출당 하나의 JSON 객체를 작성합니다. 최소한의 변환기:

```bash
# litellm-to-proxy.sh — 일회성 변환기
jq -c 'select(.model | startswith("claude-")) | {
  ts_end: .end_time,
  ts_start: .start_time,
  duration_ms: (.response_time * 1000 | round),
  upstream_status: (.status_code // 200),
  usage: {
    input_tokens: .usage.prompt_tokens,
    output_tokens: .usage.completion_tokens,
    cache_read_input_tokens: (.usage.cache_read_input_tokens // 0),
    cache_creation_input_tokens: (.usage.cache_creation_input_tokens // 0)
  },
  request_hints: { model: .model },
  response_hints: { stop_reason: (.response.choices[0].finish_reason // "unknown") }
}' litellm-log.jsonl > ~/.claude/anthropic-proxy-logs/proxy-2026-04-07.ndjson
```

결과 파일을 대시보드의 프록시 로그 디렉터리에 넣으면 다음 스캔(또는 `POST /api/debug/cache-reset`)이 이를 가져옵니다.

### 검증

프로덕션에 외부 데이터를 공급하기 전에 각 줄을 독립 실행형 JSON 객체로 검증하세요:

```bash
# 상태 검사 — 모든 줄은 파싱되고 필수 필드가 있어야 함
while read -r line; do
  echo "$line" | jq -e '.ts_end and .upstream_status and .usage.input_tokens != null' > /dev/null || echo "bad: $line"
done < proxy-2026-04-07.ndjson
```

---

## 5. 안정성 및 버전 관리

어느 형식도 공식적으로 버전 관리되지 않습니다. 필드 추가는 하위 호환되지만 필드 제거는 대시보드를 깨뜨립니다. 이슈 #167의 Phase 2가 완료되면 정규 내부 레코드는 명시적 버전 필드(`schema_version: 1`)를 얻어 어댑터가 고정 스키마를 대상으로 할 수 있습니다.

그때까지: **형식을 "현재 main branch"로 취급하세요**. 지금 어댑터를 만든다면 특정 Claude Usage Dashboard 태그(예: `v1.2.0`)에 고정하고 업그레이드할 때 다시 검증하세요.

---

## 레이아웃 파일

**경로:** `~/.claude/usage-dashboard-layout.json`

12열 그리드에서 섹션 순서, 가시성, 열 너비를 제어합니다. `GET/PUT /api/layout`으로 읽기/쓰기합니다.

```json
{
  "v": 1,
  "order": ["health", "token-stats", "forensic", ...],
  "hiddenSections": [],
  "hiddenCharts": ["health-kpi-false429"],
  "widgets": [
    { "id": "health", "span": 12 },
    { "id": "token-stats", "span": 12 },
    { "id": "proxy", "span": 6 },
    { "id": "budget", "span": 6 }
  ]
}
```

- `widgets[]`가 순서와 span의 기본 소스
- `order[]`는 `widgets[]`에서 동기화 (호환성)
- `hiddenSections[]` / `hiddenCharts[]`는 순서와 독립적으로 가시성 제어

상세: [11장 — 위젯 시스템](11-widget-system.md)

## Extract-Cache

**경로:** `~/.claude/usage-dashboard-extract-cache/`

빠른 세션 턴 계산을 위해 사전 추출된 JSONL 레코드 (레코드당 5-50KB 대신 ~150바이트).

- `*.jsonl` — 소스 파일당 추출된 레코드
- `manifest.json` — 증분 동기화를 위한 파일별 mtime + size
- `scripts/extract-cache.js`로 생성
- `scripts/session-turns-core.js`에서 사용 (`pass1FromExtractCache`, `buildSessionTurnsFromCache`)

## 참조

- 진실의 소스 (JSONL 소비): `scripts/dashboard-server.js`의 `parseAllUsageIncremental`, `extractCliVersion`, `extractEntrypoint`, `classifyJsonlSessionSignals` 함수
- 진실의 소스 (프록시 쓰기): `scripts/anthropic-proxy-core.js`의 `extractAnthropicPolicyHeaders` 함수와 NDJSON 작성기
- 진실의 소스 (프록시 소비): `scripts/dashboard-server.js`의 `parseProxyNdjsonFiles`, `computeQ5Consumption`, `emptyProxyDayBucket` 함수
- 관련: 이슈 **#167** (로그 형식 어댑터 / 변환기 로드맵)
- 관련: 영어판의 프록시 동작 및 캐시 상태 의미론 장 (KO 번역 예정, 이슈 #158 참조)
