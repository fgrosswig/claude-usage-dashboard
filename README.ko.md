**[Deutsch](README.md)** · **[English](README.en.md)** · 한국어

## Claude Usage Dashboard

[![Docker build](https://github.com/fgrosswig/claude-usage-dashboard/actions/workflows/docker.yml/badge.svg?branch=main)](https://github.com/fgrosswig/claude-usage-dashboard/actions/workflows/docker.yml)
[![Quality Gate](https://sonar.grosswig-it.de/api/project_badges/measure?project=claude-usage-dashboard&metric=alert_status&token=XXX)](https://sonar.grosswig-it.de/dashboard?id=claude-usage-dashboard)
[![Bugs](https://sonar.grosswig-it.de/api/project_badges/measure?project=claude-usage-dashboard&metric=bugs&token=XXX)](https://sonar.grosswig-it.de/dashboard?id=claude-usage-dashboard)
[![Vulnerabilities](https://sonar.grosswig-it.de/api/project_badges/measure?project=claude-usage-dashboard&metric=vulnerabilities&token=XXX)](https://sonar.grosswig-it.de/dashboard?id=claude-usage-dashboard)
[![Security Rating](https://sonar.grosswig-it.de/api/project_badges/measure?project=claude-usage-dashboard&metric=security_rating&token=XXX)](https://sonar.grosswig-it.de/dashboard?id=claude-usage-dashboard)

### 요약

**Anthropic 및 Claude Code 모니터링:** **셀프 호스팅 웹 대시보드**와 선택적으로 **Anthropic API**에 대한 **투명 HTTP 프록시**를 제공하여 **토큰 흐름**, 휴리스틱 한도, **포렌식** 및 프록시 메트릭을 시각화합니다. **동기:** 실제 **Anthropic 사용**(Claude Code, Max/Session 윈도우 등) 시 종종 **빠른 "사용량 소진"**이 발생하며, 공식 표시로는 카운터가 왜 그렇게 빨리 줄어드는지 항상 설명되지 않습니다. 데이터 소스: **`~/.claude/projects/**/_.jsonl`** 및 — 프록시 사용 시 — 요청당 **NDJSON**(지연 시간, 캐시, **rate-limit 관련 헤더** 등). **`claude-_`** 모델만 집계합니다(`<synthetic>` 제외). **로컬** 또는 **Docker/Kubernetes**에서 운영 — 중앙 SaaS 없음.

### 참고 자료 및 맥락

- **측정된 백그라운드 작업(프록시 아이디어):** **ArkNill**의 **[Claude Code Hidden Problem Analysis](https://github.com/ArkNill/claude-code-hidden-problem-analysis)** — 캐시 버그, **5h/7d-Quota** 및 프록시 캡처 헤더(**cc-relay** 유사 측정 등)에 대한 문서화된 분석. **이 프로젝트는 프록시/NDJSON 아이디어를** 대시보드와 파이프라인에 적용하며, **분석 깊이**는 **해당** 리포지토리에 있습니다.
- **GitHub 이슈 토론(Claude Code):** **[anthropics/claude-code#38335](https://github.com/anthropics/claude-code/issues/38335)** — 특히 **비정상적으로 빠르게** 소진되는 Max/Session 윈도우 관련(토론 기준: 2026년 3월경). **fgrosswig**가 **포렌식/측정**으로 참여했으며, **해당 토론에 링크된 모든 댓글, 이슈 및 하위 토론**은 **동일한 주제 범위**(사용량, 회귀, 커뮤니티 측정값)에 속하며 **참고 자료**입니다 — 여기에 전체 URL 목록을 나열하면 범위를 초과합니다.

- **Q5 할당량 검증 및 인터셉터 연동:** **cnighswonger**(Veritas Super AI Solutions)의 **[claude-code-cache-fix](https://github.com/cnighswonger/claude-code-cache-fix)** — 강제 재시작 발견의 독립적 재현, **cache_read 90% 할인이 여전히 활성** 증명(8.8x 비율), **할당량 제수 가설**(API 비용 대 Q5% 매핑이 고정되지 않음). v1.7.0부터 **NDJSON 어댑터**(`usage-to-dashboard-ndjson.mjs`)로 대시보드 프록시 형식에 직접 기록 — 설정 없는 연동. 공동 분석으로 **대용량 캐시 읽기 패널티** 발견: 큰 Q5 점프의 93%가 압축이 아닌 대용량 캐시의 일반 턴에서 발생.

**직접 링크:** [https://github.com/anthropics/claude-code/issues/38335](https://github.com/anthropics/claude-code/issues/38335) · [https://github.com/ArkNill/claude-code-hidden-problem-analysis](https://github.com/ArkNill/claude-code-hidden-problem-analysis) · [https://github.com/cnighswonger/claude-code-cache-fix](https://github.com/cnighswonger/claude-code-cache-fix)

기술, UI, 환경 변수 및 API: **[문서](docs/README.md)**.

### 문서

**전체** 설명은 **[docs/](docs/README.md)**에 있으며 하위 페이지(아키텍처, UI, 프록시, 포렌식, 환경 변수, API)를 포함합니다.

- **Deutsch:** [docs/de/README.md](docs/de/README.md)
- **English:** [docs/en/README.md](docs/en/README.md)
- **한국어:** [docs/ko/README.md](docs/ko/README.md)

### 빠른 시작

```bash
node server.js              # Dashboard :3333
node start.js both          # Dashboard + Proxy :8080
node start.js forensics     # CLI 분석
```

옵션, 로깅, 캐시, 멀티 호스트 및 동기화: **[문서](docs/ko/README.md)** 참조.

### Docker

두 개의 이미지: **`Dockerfile.base`**(npm 종속성) → **`Dockerfile`**(앱). 로컬 예시: `docker build -f Dockerfile.base -t claude-base:local .` 후 **`BASE_IMAGE=claude-base BASE_TAG=local docker compose build`**. **`docker compose up`** = **`node start.js both`**(3333 / 8080); 추가 모드: **`docker-compose.yml`** 헤더 참조. CI: **`docker-compose.ci.yml`**, **`.github/workflows/docker.yml`**.

### Gitea 및 GitHub(`main` 머지 후 루틴)

작업은 주로 **Gitea**에서 진행됩니다(브랜치 예: **`feat/proxy-logs`** → PR → **`main`**). **GitHub**는 공개 미러로 사용되며, 현재 브랜치 이름은 대부분 **`feat/proxy-analytics`** → PR → **`main`**입니다([Repo](https://github.com/fgrosswig/claude-usage-dashboard)).

**최초 1회 — 두 번째 리모트 추가:**

```bash
git remote add github https://github.com/fgrosswig/claude-usage-dashboard.git   # 이름은 자유롭게 지정
git fetch github
```

**A) Gitea-`main` 머지 후 — GitHub-`main` 동기화**

```bash
git checkout main
git pull origin main                    # origin = Gitea
git push github main                   # github 리모트: main 업데이트
```

**B) GitHub PR용 피처 업로드(브랜치명 맞추기)**

Gitea 피처 브랜치와 동일한 상태에서 GitHub 브랜치 이름으로 푸시합니다(기존 PR이 업데이트됨):

```bash
git checkout feat/proxy-logs
git pull origin feat/proxy-logs
git push github feat/proxy-logs:feat/proxy-analytics
```

GitHub에서: PR **"feat/proxy-analytics" → `main`**을 생성하거나 기존 PR을 확인합니다(새 푸시가 표시됨).  
선택적으로 로컬에서: [GitHub CLI](https://cli.github.com/)가 설치된 경우 **`gh pr create`** / **`gh pr sync`** 사용 가능(웹에서만 작업하지 않는 경우).

**자동 미러:** Gitea-`main` 머지 후 **`.gitea/workflows/mirror-github.yml`**이 정리된 스냅샷을 **GitHub `main`**에 푸시합니다(내부적으로는 모두 변경 없음; 도메인과 `.woodpecker`/`.gitea`는 공개되지 않음). 위의 `git push github` 예시는 필요 시에만 사용(예: 워크플로우 없이 또는 별도의 GitHub 피처 브랜치용).

### 서버 및 CLI 옵션

- **`--port`**: HTTP 포트(기본값 `3333`).
- **`--log-level`**, **`--log-file`**: 진단 로깅(아래 **서버 로깅** 참조); `CLAUDE_USAGE_LOG_*` 환경 변수와 동일.
- **`--refresh`**: 다음 **전체 스캔**(모든 JSONL) + SSE 푸시까지의 초 — **최소 `60`**, 기본값 **`180`**. 또는 **`CLAUDE_USAGE_SCAN_INTERVAL_SEC`** 설정(≥ 60); `--refresh`가 우선.

### 서버 로깅

stderr로 출력, 선택적으로 파일로: **`CLAUDE_USAGE_LOG_LEVEL`** = `error` | `warn` | `info`(기본값) | `debug` | `none`. 파일: **`CLAUDE_USAGE_LOG_FILE`**. CLI: **`--log-level=…`**, **`--log-file=…`**. 주제: **`scan`/`parse`**, **`cache`**, **`outage`**, **`releases`**, **`marketplace`**, **`github`**, **`i18n`**, **`server`**.

### 라이브 업데이트

- 열 때: **`fetch('/api/usage')`**로 현재 캐시, 동시에 **SSE**(`/api/stream`).
- 우측 상단 녹색 점 = 연결됨; 수동 새로고침 없이 데이터가 자동 업데이트됩니다.
- 빨간색 = 연결 끊김, 브라우저가 재시도합니다.

### 빠른 시작 / 백그라운드 스캔

- 서버가 **즉시 수신 대기**; 첫 번째 파싱은 `listen` 전에 **차단하지 않습니다**.
- JSONL은 **배치로** 처리됩니다(파일 그룹 사이에 `setImmediate`), HTTP/SSE가 응답 가능한 상태를 유지합니다.
- 첫 스캔 전: `scanning: true` 스텁과 UI에 안내 텍스트 표시.

### 일별 캐시(이전 날짜를 JSON 하나에)

- 파일: **`~/.claude/usage-dashboard-days.json`**
- **캐시 버전**, **스캔 루트** 및 **`.jsonl` 파일 수**가 일치하면 이전 날짜는 파일에서 로드되고 로컬 캘린더 "오늘"만 전체 집계됩니다. 로그 사용이 없는 **캘린더 빈 날짜**는 전체 스캔을 강제하지 않습니다. 캐시 버전 **3**부터 일별 **`hosts`**; **버전 4**는 이전 캐시를 1회 무효화; **버전 5**는 **`session_signals`**(JSONL 휴리스틱: continue/resume/retry/interrupt)를 추가합니다.
- 선택적 **`CLAUDE_USAGE_SKIP_IDENTICAL_SCAN=1`**: JSONL mtime이 변경되지 않으면 반복 전체 스캔을 건너뜁니다(핑거프린트).
- **Meta** 패널에 **Day-Cache**, **Releases**, **Marketplace** 및 **Outage** JSON 경로가 표시됩니다.
- **전체 스캔** 강제: **`CLAUDE_USAGE_NO_CACHE=1`**(또는 `true`), 캐시 파일 삭제, 새/제거된 `.jsonl`(다른 파일 수), 또는 다른 **`CLAUDE_USAGE_EXTRA_BASES`** / 스캔 루트.

### 추가 컴퓨터 / 가져온 로그(`CLAUDE_USAGE_EXTRA_BASES`)

다른 호스트에서 복사한 **`projects`** 트리를 임의 위치에 배치할 수 있습니다 — 예: **`HOST-B`** 폴더 — 추가로 스캔합니다:

- 환경 변수 **`CLAUDE_USAGE_EXTRA_BASES`**: 하나 이상의 디렉토리, **`;`로 구분**.
- **축약형:** `true`, `1`, `yes`, `auto` 또는 `on` — **`CLAUDE_USAGE_EXTRA_BASES_ROOT`**(비어 있으면: 시작 시 CWD) 아래의 **`HOST-`** 접두사 하위 폴더를 모두 포함합니다.
- 경로는 시작에 **`~`** 또는 절대 경로를 사용할 수 있습니다.
- **UI에서의 레이블** = 마지막 경로 구성 요소(예: `HOST-B`).
- 모든 소스가 **동일한 일별 집계**에 병합됩니다. **중복** 파일 경로는 한 번만 집계됩니다.
- **호스트별:** API에서 각 날짜에 **`hosts`** 객체(Total, Output, Calls, Hit-Limit, Sub-Cache 등)가 있습니다. 여러 루트가 있으면 추가 카드, 테이블 행 및 호스트별 누적 막대 차트가 나타납니다.
- **일별 상세:** 호스트 하위 행 클릭 시 해당 호스트만 표시. 돌아가기: "모든 호스트" 또는 드롭다운에서 다른 날짜.

예시:

```bash
export CLAUDE_USAGE_EXTRA_BASES="$HOME/.claude/imports/HOST-B"
node server.js
```

여러 폴더:

```bash
export CLAUDE_USAGE_EXTRA_BASES="$HOME/sync/win-projects;$HOME/.claude/imports/HOST-B"
```

`HOST-*` 하위 폴더 자동(Root = CWD):

```bash
export CLAUDE_USAGE_EXTRA_BASES=true
cd /pfad/zu/parent-mit-HOST-B-und-HOST-C
node /pfad/zu/server.js
```

사용자 지정 상위 폴더(Windows PowerShell):

```powershell
$env:CLAUDE_USAGE_EXTRA_BASES = "true"
$env:CLAUDE_USAGE_EXTRA_BASES_ROOT = "C:\Temp"
node server.js
```

### Meta 행 & 범례(접기 가능)

- 메인 제목 아래: 모델 안내, 파싱/상태 행, 한도/데이터 소스 및 스캔 소스를 위한 **접기 가능** 블록.
- **접힌 상태**: 짧은 요약(로그 파일 수, 새로고침 간격).
- **펼친 상태**: 더 작은 텍스트로 카드가 더 빨리 보이도록 합니다.
- 상태는 **`sessionStorage`**에 **`usageMetaDetailsOpen`**으로 저장됩니다.

### UI: 날짜 선택(카드 & 테이블)

- **드롭다운**: 데이터가 있는 모든 날짜(최신이 위).
- **카드** 및 **일별 상세 테이블**: 선택된 날짜. **차트** 및 **Forensic 차트**: 전체 날짜.
- 선택은 **`sessionStorage`**에 **`usageDashboardDay`**로 저장됩니다.
- 캘린더 "오늘"이 0 토큰인 경우: 짧은 안내.

### GitHub API(릴리스)

비인증 제한: IP당 **시간당 약 60 요청**. _Rate-Limit_ 시: **`GITHUB_TOKEN`** 또는 **`GH_TOKEN`** 설정(공개 리포에는 Classic PAT로 충분). **주기적 Fetch 없음:** **`~/.claude/claude-code-releases.json`**이 없거나 비어 있을 때만 네트워크 요청 — 그 외 디스크 캐시. 수동: **`POST /api/github-releases-refresh`**; 선택적으로 **`CLAUDE_USAGE_ADMIN_TOKEN`**과 `Authorization: Bearer`. 시작 시 강제: **`CLAUDE_USAGE_GITHUB_RELEASES_FETCH=1`**. **UI에서 선택적으로:** Meta 영역을 펼치고 PAT를 입력 — 이 탭의 `sessionStorage`에만 저장.

### 한도 & 포렌식(휴리스틱만)

- UI의 **데이터 소스**: 일반적으로 **`~/.claude/projects`**(사용자 이름이 포함된 절대 경로 없음).
- **Hit Limit(차트에서 빨간색):** 일반적인 Rate-/Limit 패턴이 있는 JSONL 행을 집계 — 직접적인 API 증거 아님.
- **Forensic**(접기 가능): 코드 **`?`**(매우 높은 Cache-Read), **`HIT`**(Limit 행), **`<<P`**(엄격한 피크 비교). Claude UI의 "90% / 100%"와 동일하지 않음.
- **Forensic 세션 신호**(별도 차트): 일별 누적 막대(continue, resume, retry, interrupt), 상단에 **Outage 시간**. **보라색 선** = Cache Read(별도 오른쪽 축).

### CLI 포렌식(`scripts/token-forensics.js`)

**자동 피크 및 한도 감지**(하드코딩된 데이터 없음)가 있는 별도 분석 도구. 대시보드와 **동일한 스캔 루트** 및 **Day-Cache 버전 5**를 사용합니다.

```bash
node start.js forensics
```

(`node scripts/token-forensics.js` 또는 리포 루트의 `node token_forensics.js`와 동일.)

**자동 감지:**

- **피크 일:** 총 소비량이 가장 높은 날.
- **한도 일:** JSONL에서 Rate-/Limit 행이 50개 이상이거나 Cache-Read가 500M 이상인 날.
- **결론 비교:** 유의미한 활동이 있는 마지막 한도 일(50회 이상 호출, 2시간 이상 활동).

**7개 섹션:**

1. **일별 개요** — Cache:Output 비율, 활동 시간, 한도 레이블, Outage 마커.
2. **효율성 분석** — 오버헤드(Output 토큰당 토큰), Output/h, Subagent 비율.
3. **Subagent 분석** — 캐시 배수: 전체 캐시 대비 Subagent 캐시 비율.
4. **예산 추정** — 한도 일당 암시적 상한(`total/0.9`), 추세, 중앙값 범위. Outage 일은 별도 분리(_OUT_ 표시).
5. **시간별 분석** — 마지막 유의미 한도 일의 시간별 분류.
6. **결론** — 피크 일 vs. 한도 일 비교: 예산 감소, 한도까지 추정 시간(분).
7. **시각화** — 피크/한도/Outage 표시가 있는 ASCII 막대 차트.

**MAX 플랜에 대한 시사점:** 피크/한도 비교로 세션 예산 변동 여부를 확인합니다. `Cache:Output` 비율은 효율성을 보여줍니다 — Subagent가 적을수록 오버헤드가 적고 한도까지 더 오래 작업할 수 있습니다.

### Anthropic Monitor Proxy(`start.js proxy` / `anthropic-proxy.js`)

구현: **`scripts/anthropic-proxy-core.js`** 및 **`scripts/anthropic-proxy-cli.js`**. 선택적 **HTTP 포워드 프록시**(npm 패키지 없음): Anthropic 호환 요청을 수신하여 **`https://api.anthropic.com`**(또는 `--upstream`)으로 전달합니다. 이를 통해 `~/.claude/projects` 아래의 JSONL과 함께 API 응답에서 **트래픽 로깅** 및 **캐시 메트릭**을 캡처할 수 있습니다.

**시작:**

```bash
node start.js proxy --port=8080
```

**Claude를 프록시로 연결:**

```bash
ANTHROPIC_BASE_URL=http://127.0.0.1:8080 claude
```

**로깅:** 완료된 각 업스트림 응답은 **`~/.claude/anthropic-proxy-logs/proxy-YYYY-MM-DD.ndjson`** 아래에 **NDJSON 한 줄**을 생성합니다(**`ANTHROPIC_PROXY_LOG_DIR`**로 재정의 가능). 필드: **`ts_start`/`ts_end`**, **`duration_ms`**, **`path`**, **`upstream_status`**, **`usage`**(`cache_read_input_tokens`, `cache_creation_input_tokens` 포함), **`cache_read_ratio`**, **`cache_health`**:

- **`healthy`:** Cache-Read 비율이 (Read + Creation) 대비 80% 이상.
- **`affected`:** 캐시 트래픽이 있지만 비율 40% 미만(과도한 Creation, 적은 Read = Cache Churn).
- **`mixed`**, **`na`**, **`unknown`** — 상황에 따라 다름.

**Rate Limits & 메타데이터:** 각 줄에 **`request_meta`** 및 **`response_anthropic_headers`**(예: `anthropic-ratelimit-*`, `request-id`, `cf-ray`)가 포함됩니다.

### 대시보드에 데이터 로드(원격 / 컨테이너)

서버가 **`~/.claude/projects`**를 직접 읽을 수 없는 경우:

- **`POST /api/claude-data-sync`**: Request Body = **gzip 압축 tar**. 헤더 **`Authorization: Bearer <CLAUDE_USAGE_SYNC_TOKEN>`**.
- **`projects/**`** 및 **`anthropic-proxy-logs/**`** 아래 경로만 추출됩니다.
- 최대 업로드: **`CLAUDE_USAGE_SYNC_MAX_MB`**(기본값 **512**).
- 헬퍼: **`scripts/claude-data-sync-client.js`**.

### 확장 프로그램 업데이트(Service Impact 차트 & 보고서)

- **마커 데이터:** 주로 **VS Code Marketplace**([Version History](https://marketplace.visualstudio.com/items?itemName=anthropic.claude-code&ssr=false#version-history)): `lastUpdated`, Semver 기준 최신 버전. 데이터는 **UTC 캘린더 일**에 정렬. **`~/.claude/claude-code-marketplace-versions.json`**에 캐시됨.
- **Changelog 항목:** **GitHub Releases**(Fetch당 최대 100개 항목), **`~/.claude/claude-code-releases.json`**에 캐시됨. **날짜 소스:** Marketplace + GitHub 병합(Marketplace 날짜 우선); 그 다음 JSONL 폴백.
- **JSONL의 버전:** 폴백 및 분석을 위해 **`major.minor.patch`**로 정규화.

### 배포

```bash
# Docker / K8s
node start.js both          # Dashboard (3333) + Proxy (8080)
node start.js dashboard     # Dashboard만
node start.js proxy         # Proxy만

# K8s with Kustomize
kubectl apply -k k8s/overlays/dev

# 다른 컴퓨터에서 JSONL 동기화
~/.claude/sync-to-dashboard.sh
```

### 환경 변수

| 변수                             | 기본값                           | 설명                                                  |
| -------------------------------- | -------------------------------- | ----------------------------------------------------- |
| `ANTHROPIC_PROXY_BIND`           | `127.0.0.1`                      | 프록시 바인드 주소                                    |
| `ANTHROPIC_PROXY_PORT`           | `8080`                           | 프록시 포트                                           |
| `ANTHROPIC_PROXY_LOG_DIR`        | `~/.claude/anthropic-proxy-logs` | NDJSON 로그 디렉토리                                  |
| `CLAUDE_USAGE_EXTRA_BASES`       | —                                | `auto` 또는 `;`로 구분된 경로                         |
| `CLAUDE_USAGE_EXTRA_BASES_ROOT`  | `cwd`                            | HOST-\* 자동 검색용 루트                              |
| `CLAUDE_USAGE_SYNC_TOKEN`        | —                                | `/api/claude-data-sync`용 토큰                        |
| `CLAUDE_USAGE_SYNC_MAX_MB`       | `512`                            | 최대 업로드 크기                                      |
| `CLAUDE_USAGE_SCAN_INTERVAL_SEC` | `180`                            | 스캔 간격(최소 60)                                    |
| `CLAUDE_USAGE_NO_CACHE`          | —                                | `1` 또는 `true`로 전체 스캔 강제                      |
| `CLAUDE_USAGE_LOG_LEVEL`         | `info`                           | `error`/`warn`/`info`/`debug`/`none`                  |
| `CLAUDE_USAGE_LOG_FILE`          | —                                | 로그 파일(stderr 추가)                                |
| `GITHUB_TOKEN` / `GH_TOKEN`      | —                                | 릴리스용 GitHub PAT(시간당 60회 초과 시)              |
| `CLAUDE_USAGE_ADMIN_TOKEN`       | —                                | 관리자 엔드포인트용 Bearer 토큰                       |
| `DEBUG_API`                      | —                                | `1`로 `/api/debug/proxy-logs` 엔드포인트 활성화       |
| `DEV_PROXY_SOURCE`               | —                                | Dev 테스트용 원격 대시보드 URL                        |
| `DEV_MODE`                       | —                                | `proxy`(프록시만 원격) 또는 `full`(전체 원격)         |

### API(요약)

- **`GET /`**: HTML 대시보드.
- **`GET /api/usage`**: `days`(일별 `hosts`, `session_signals`, `outage_hours`, `cache_read`, …), `host_labels`, `calendar_today`, `day_cache_mode`, `scanning`, `parsed_files`, `scanned_files`, `scan_sources`, `forensic_*`가 포함된 JSON.
- **`POST /api/claude-data-sync`**: JSONL 업로드(gzip tar).
- **`POST /api/github-releases-refresh`**: 릴리스 수동 새로고침.

### 로컬 Dev 테스트

실제 원격 데이터로 로컬에서 대시보드 테스트(클러스터에 `DEBUG_API=1` 필요):

```powershell
# PowerShell — 전체 원격(로컬 스캔 없음)
$env:DEV_PROXY_SOURCE="https://claude-usage.grosswig-it.de"; $env:DEV_MODE="full"; node start.js dashboard

# PowerShell — 프록시만 원격, JSONL은 로컬
$env:DEV_PROXY_SOURCE="https://claude-usage.grosswig-it.de"; $env:DEV_MODE="proxy"; node start.js dashboard
```

```bash
# bash — 전체 원격
DEV_PROXY_SOURCE=https://claude-usage.grosswig-it.de DEV_MODE=full node start.js dashboard
```

- 상단에 **DEV FULL 배너** + 동기화 버튼 및 Last-Sync 타임스탬프
- 180초마다 자동 동기화, Dev 모드에서 `node start.js both`는 차단됨
- Mermaid 플로우차트는 `k8s/README.md` 참조

### UDAA 필드 스터디 — 익명화된 세션 내보내기

대시보드에는 UDAA 필드 스터디(Usage Drain Anomalies Audit)를 위한 **내보내기 도구**가 포함되어 있습니다. **익명화된** 세션 데이터만 내보냅니다(토큰 카운트, 시간 델타, 모델 ID만) — 프롬프트, 경로, 호스트명 없음.

```bash
node scripts/udaa-fieldstudy-export.js              # 모든 세션 내보내기
node scripts/udaa-fieldstudy-export.js --dry-run     # 파일 작성 없이 미리보기
node scripts/udaa-fieldstudy-export.js --out ./data  # 사용자 지정 출력 디렉토리
```

데이터 공유: 내보낸 JSON 파일을 [file.io](https://www.file.io)(일회 다운로드), [catbox.moe](https://catbox.moe), 또는 [temp.sh](https://temp.sh)를 통해 공유.

상세: **[docs/ko/10-udaa-field-study.md](docs/ko/10-udaa-field-study.md)** | **[English](docs/en/10-udaa-field-study.md)** | **[Deutsch](docs/de/10-udaa-feldstudie.md)**

### 참고 문헌

- [Claude Code Hidden Problem Analysis](https://github.com/ArkNill/claude-code-hidden-problem-analysis) — 이상 감지(B1-B8)의 기초
- Health 패널의 버그 감지: B3 False Rate Limiter, B4 Context Stripping, B5 Tool Truncation
- 쿼터 벤치마크: 1% ≈ 1.5-2.1M 가시적 토큰(ArkNill 참고)
- 정지 이상 감지를 위한 SSE stop_reason 추출

### 스크린샷

**토큰 개요**(대시보드) 및 **Proxy Analytics** — 추가 정보: [docs/de/08-screenshots.md](docs/de/08-screenshots.md).

![토큰 개요 / 메인 차트](images/main_overview_statistics.png)

![Anthropic Monitor Proxy / Proxy Analytics](images/proxy_statistics.png)
