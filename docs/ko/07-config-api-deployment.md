# 설정, API, 배포, 개발(발췌)

[← 목차](README.md)

전체 장(도커, CI, Mermaid 플로우, GitHub 미러 등)은 **[English](../en/07-config-api-deployment.md)**를 참고하세요.

## 환경 변수(일부)

| 변수 | 기본값 | 설명 |
|------|--------|------|
| `CLAUDE_USAGE_SYNC_TOKEN` | — | `POST /api/claude-data-sync`용 토큰(Kubernetes에서는 Secret **`sync-token`** — **`k8s/base/deployment.yml`**, **`k8s/README.md`**) |
| `CLAUDE_USAGE_SYNC_MAX_MB` | `512` | 업로드 최대 크기(MB) |
| `DEBUG_API` | — | `1`이면 디버그용 HTTP 경로 활성화 — 자세한 표는 영어 **[07-config-api-deployment.md](../en/07-config-api-deployment.md#debug-api)** 의 **DEBUG API** 절 |
| `DEV_PROXY_SOURCE` | — | 개발용 원격 대시보드 URL |
| `DEV_MODE` | — | `proxy`(프록시 로그만 원격) 또는 `full`(전체 usage 원격) |

프록시 전용 옵션: **`node … proxy --help`**, [English: Proxy](../en/05-proxy.md).

## API(요약)

- **`GET /`**: HTML 대시보드.
- **`GET /api/usage`**: `days`, `host_labels`, 스캔 상태 등 JSON.
- **`POST /api/claude-data-sync`**: gzip-tar 업로드.
- **`POST /api/github-releases-refresh`**: 릴리스 캐시 갱신.

## 동기화 클라이언트 토큰(클러스터에서 읽기)

대시보드가 **Kubernetes**에서 돌면 Secret **`claude-usage-dashboard-app`** / 키 **`sync-token`**을 사용합니다(**`k8s/base/deployment.yml`**). 로컬 **`CLAUDE_SYNC_TOKEN`**은 **`scripts/print-claude-sync-token.ps1`** 또는 **`scripts/print-claude-sync-token.sh`**로 출력할 수 있습니다. 자세한 내용은 **[k8s/README.md](../../k8s/README.md)**, **[04-multi-host-and-sync.md](04-multi-host-and-sync.md)**.

## 배포·Kubernetes

매니페스트와 클러스터 절차: **[k8s/README.md](../../k8s/README.md)**.

**개발 시 원격 데이터:** `DEV_PROXY_SOURCE` + 선택적 `DEV_MODE=full`. **`node start.js both`**는 `DEV_PROXY_SOURCE`가 설정되면 사용할 수 없습니다. 자세한 명령은 영어 문서 [07-config-api-deployment.md](../en/07-config-api-deployment.md#dev-testing-remote-data) 참고.
