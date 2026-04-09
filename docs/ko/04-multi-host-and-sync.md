# 멀티 호스트 및 동기화

[← 목차](README.md)

**`CLAUDE_USAGE_EXTRA_BASES`**: `;`로 구분된 경로, 또는 **`CLAUDE_USAGE_EXTRA_BASES_ROOT`**(기본: 시작 시 CWD) 아래 **`HOST-*`** 자식만 자동 추가하려면 `true`/`auto` 등. 라벨은 경로의 마지막 세그먼트. 동일 절대 경로는 한 번만 집계. API는 일별 **`hosts`**; UI에 행·스택 막대·서브에이전트 캐시 %가 추가됩니다.

더 많은 예시: [04-multi-host-und-datensync.md](../de/04-multi-host-und-datensync.md) (독일어).

## HTTP로 대시보드에 데이터 업로드 (원격 / 컨테이너)

서버에서 **`~/.claude/projects`**를 직접 읽을 수 없을 때(예: Kubernetes Pod):

- **`POST /api/claude-data-sync`**: 본문 = **gzip으로 압축된 tar**.
- 헤더 **`Authorization: Bearer <토큰>`** — 서버의 **`CLAUDE_USAGE_SYNC_TOKEN`**과 일치해야 합니다.
- **`projects/**`** 및 **`anthropic-proxy-logs/**`**만 추출됩니다.
- 최대 크기: **`CLAUDE_USAGE_SYNC_MAX_MB`** (기본 **512**).
- 클라이언트: **`scripts/claude-data-sync-client.js`**. 수신 처리: **`scripts/claude-data-ingest.js`**.

### Kubernetes: Secret의 토큰 (Git에 넣지 않음)

**`k8s/base/deployment.yml`**에서 **`CLAUDE_USAGE_SYNC_TOKEN`**은 Secret **`claude-usage-dashboard-app`**, 키 **`sync-token`**에서 주입됩니다(`optional: true`). Secret 생성·교체는 **`k8s/README.md`**를 따르세요. Deployment에 토큰을 평문 `env`로 넣지 마세요(병합 오류·유출 위험).

노트북에서 **`CLAUDE_SYNC_TOKEN`**으로 같은 값을 쓰려면(**`kubectl`**로 클러스터 접근 필요):

- **`scripts/print-claude-sync-token.ps1`** (PowerShell)
- **`scripts/print-claude-sync-token.sh`** (bash, **`base64`** 필요)

기본값 덮어쓰기: **`CLAUDE_SYNC_K8S_NAMESPACE`** (기본 **`claude`**), **`CLAUDE_SYNC_K8S_SECRET`** (기본 **`claude-usage-dashboard-app`**).

**예: PowerShell, NodePort**

```powershell
$env:CLAUDE_SYNC_TOKEN = (& pwsh -NoProfile -File .\scripts\print-claude-sync-token.ps1).Trim()
$env:CLAUDE_SYNC_URL = "http://노드_IP:31333"
node scripts/claude-data-sync-client.js
```
