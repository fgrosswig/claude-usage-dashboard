pipeline {
  agent {
    kubernetes {
      inheritFrom 'enterprise'
      yaml '''
        spec:
          imagePullSecrets:
          - name: harbor-pull-secret
          containers:
          - name: kubectl
            image: harbor.grosswig-it.de/claude/kubectl:latest
            command: ["/bin/sh", "-c"]
            args: ["while true; do sleep 86400; done"]
            tty: true
            securityContext:
              runAsUser: 0
          - name: sonar
            image: sonarsource/sonar-scanner-cli:latest
            command: ["/bin/sh", "-c"]
            args: ["while true; do sleep 86400; done"]
            tty: true
      '''
    }
  }

  options {
    skipDefaultCheckout()
    disableConcurrentBuilds(abortPrevious: true)
    timeout(time: 30, unit: 'MINUTES')
    buildDiscarder(logRotator(numToKeepStr: '20'))
  }

  environment {
    HARBOR      = 'harbor.grosswig-it.de'
    DOCKER_HOST = 'tcp://localhost:2375'
    SONAR_URL   = 'http://sonarqube-sonarqube.sonarqube.svc.cluster.local:9000'
    GITEA_URL   = 'https://gitea.grosswig-it.de'
    GITEA_REPO  = 'GRO/Claude-Usage-Dashboard'
    KUBE_NS     = 'claude'
  }

  stages {

    // ── 1. Checkout + Params ──────────────────────────────────────────
    stage('Prepare') {
      steps {
        checkout scm
        script {
          env.SHORT_SHA = sh(script: 'git rev-parse --short=8 HEAD', returnStdout: true).trim()
          env.COMMIT_MSG = sh(script: 'git log -1 --format=%s', returnStdout: true).trim()
          env.IS_MAIN = (env.BRANCH_NAME == 'main') ? 'true' : 'false'
          env.APP_VERSION = (env.IS_MAIN == 'true') ? env.SHORT_SHA : "dev-${env.SHORT_SHA}"
          env.IMAGE_TAG = env.APP_VERSION

          def baseVer = sh(script: "awk -F'\"' '/base_image/{print \$4}' version.json", returnStdout: true).trim()
          env.BASE_TAG = baseVer ?: 'latest'

          def branch = env.BRANCH_NAME ?: ''
          switch (branch) {
            case 'main':
              env.BUILD_DASHBOARD = 'true'; env.BUILD_GATEWAY = 'false'; break
            case 'develop':
              env.BUILD_DASHBOARD = 'true'; env.BUILD_GATEWAY = 'true'; break
            case ['feat/dashboard', 'feat/ndjson-parser']:
              env.BUILD_DASHBOARD = 'true'; env.BUILD_GATEWAY = 'false'; break
            case ['gateway', 'feat/gateway', 'feat/failover-sync']:
              env.BUILD_DASHBOARD = 'false'; env.BUILD_GATEWAY = 'true'; break
            default:
              env.BUILD_DASHBOARD = 'false'; env.BUILD_GATEWAY = 'false'
          }

          if (env.COMMIT_MSG.contains('[tx-log]')) {
            currentBuild.description = 'tx-log commit – skipped'
            currentBuild.result = 'NOT_BUILT'
            error('tx-log commit – skipping build')
          }

          if (env.BUILD_DASHBOARD == 'false' && env.BUILD_GATEWAY == 'false') {
            currentBuild.description = "No targets for branch ${branch}"
            currentBuild.result = 'NOT_BUILT'
            error("No build targets for branch ${branch}")
          }

          echo "Branch=${branch}  SHA=${env.SHORT_SHA}  Tag=${env.IMAGE_TAG}"
          echo "dashboard=${env.BUILD_DASHBOARD}  gateway=${env.BUILD_GATEWAY}"
        }
      }
    }

    // ── 2. Harbor Login + DinD Wait ───────────────────────────────────
    stage('Harbor Login') {
      steps {
        container('docker') {
          sh 'for i in $(seq 1 30); do docker info >/dev/null 2>&1 && break; echo "Waiting for Docker daemon ($i/30)..."; sleep 2; done'
          withCredentials([usernamePassword(
            credentialsId: 'robo-token',
            usernameVariable: 'HARBOR_USER',
            passwordVariable: 'HARBOR_PASS'
          )]) {
            sh "echo \"\$HARBOR_PASS\" | docker login ${HARBOR} -u \"\$HARBOR_USER\" --password-stdin"
          }
        }
      }
    }

    // ── 3. Base Image (nur bei Aenderungen an Dockerfile.base/deps) ──
    stage('Base Image') {
      when {
        anyOf {
          changeset 'Dockerfile.base'
          changeset 'package.json'
          changeset 'package-lock.json'
          changeset 'version.json'
        }
      }
      steps {
        container('docker') {
          withCredentials([usernamePassword(
            credentialsId: 'robo-token',
            usernameVariable: 'HARBOR_USER',
            passwordVariable: 'HARBOR_PASS'
          )]) {
            sh """
              echo "\$HARBOR_PASS" | docker login ${HARBOR} -u "\$HARBOR_USER" --password-stdin
              docker build -f Dockerfile.base \\
                -t ${HARBOR}/claude/base:v3 \\
                -t ${HARBOR}/claude/base:latest .
              docker push ${HARBOR}/claude/base:v3
              docker push ${HARBOR}/claude/base:latest
            """
          }
        }
      }
    }

    // ── 4. Parallel Build ─────────────────────────────────────────────
    stage('Build') {
      parallel {

        stage('Dashboard') {
          when { expression { env.BUILD_DASHBOARD == 'true' } }
          steps {
            container('docker') {
              script {
                def tags = buildTagList('dashboard')
                def flags = tags.collect { "-t ${HARBOR}/claude/dashboard:${it}" }.join(' ')
                sh """
                  docker build \\
                    --build-arg BASE_TAG=${env.BASE_TAG} \\
                    --build-arg APP_VERSION=${env.APP_VERSION} \\
                    ${flags} -f Dockerfile .
                """
                tags.each { sh "docker push ${HARBOR}/claude/dashboard:${it}" }
              }
            }
          }
        }

        stage('Gateway') {
          when { expression { env.BUILD_GATEWAY == 'true' } }
          steps {
            container('docker') {
              script {
                if (!fileExists('Dockerfile.gateway')) {
                  error("Dockerfile.gateway missing on branch ${env.BRANCH_NAME}")
                }
                def tags = buildTagList('gateway')
                def flags = tags.collect { "-t ${HARBOR}/claude/gateway:${it}" }.join(' ')
                sh """
                  docker build \\
                    --build-arg BASE_TAG=${env.BASE_TAG} \\
                    --build-arg APP_VERSION=${env.APP_VERSION} \\
                    ${flags} -f Dockerfile.gateway .
                """
                tags.each { sh "docker push ${HARBOR}/claude/gateway:${it}" }
              }
            }
          }
        }
      }
    }

    // ── 5. SonarQube + Quality Gate ─────────────────────────────────
    stage('SonarQube') {
      steps {
        container('sonar') {
          withCredentials([string(credentialsId: 'sonarqube-token', variable: 'SONAR_TOKEN')]) {
            script {
              def args = "-Dsonar.host.url=${env.SONAR_URL} -Dsonar.token=${env.SONAR_TOKEN}"
              if (env.CHANGE_ID) {
                args += " -Dsonar.pullrequest.key=${env.CHANGE_ID}"
                args += " -Dsonar.pullrequest.branch=${env.CHANGE_BRANCH}"
                args += " -Dsonar.pullrequest.base=${env.CHANGE_TARGET}"
              } else if (env.BRANCH_NAME != 'main') {
                args += " -Dsonar.branch.name=${env.BRANCH_NAME}"
              }
              sh "sonar-scanner ${args}"
            }
          }
        }
      }
    }

    // ── 6. Quality Gate ───────────────────────────────────────────────
    stage('Quality Gate') {
      steps {
        container('sonar') {
          withCredentials([string(credentialsId: 'sonarqube-token', variable: 'SONAR_TOKEN')]) {
            sh '''
              sleep 10
              if [ -n "${CHANGE_ID}" ]; then
                QG_URL="${SONAR_URL}/api/qualitygates/project_status?projectKey=claude-usage-dashboard&pullRequest=${CHANGE_ID}"
              elif [ "${BRANCH_NAME}" = "main" ]; then
                QG_URL="${SONAR_URL}/api/qualitygates/project_status?projectKey=claude-usage-dashboard"
              else
                QG_URL="${SONAR_URL}/api/qualitygates/project_status?projectKey=claude-usage-dashboard&branch=${BRANCH_NAME}"
              fi
              STATUS=$(curl -sf -u "${SONAR_TOKEN}:" "$QG_URL" | python3 -c "import sys,json; print(json.load(sys.stdin)['projectStatus']['status'])")
              echo "Quality Gate: $STATUS"
              [ "$STATUS" = "OK" ] || { echo "Quality Gate FAILED"; exit 1; }
            '''
          }
        }
      }
    }

    // ── 7. Deploy ─────────────────────────────────────────────────────
    stage('Deploy') {
      when {
        expression {
          env.BUILD_DASHBOARD == 'true' || env.BUILD_GATEWAY == 'true'
        }
      }
      steps {
        container('kubectl') {
          script {
            def K = "kubectl --request-timeout=30s"
            def tag = env.IMAGE_TAG

            if (env.BUILD_DASHBOARD == 'true') {
              sh """
                if ${K} get deployment/claude-dashboard -n ${KUBE_NS} >/dev/null 2>&1; then
                  ${K} set image deployment/claude-dashboard dashboard=${HARBOR}/claude/dashboard:${tag} -n ${KUBE_NS}
                  ${K} rollout status deployment/claude-dashboard -n ${KUBE_NS} --timeout=3m
                else
                  echo 'deployment/claude-dashboard not found – skipping'
                fi
              """
            }

            if (env.BUILD_GATEWAY == 'true') {
              def gwImage = "${HARBOR}/claude/gateway:${tag}"
              sh """
                if ${K} get statefulset/gateway -n ${KUBE_NS} >/dev/null 2>&1; then
                  ${K} set image statefulset/gateway gateway=${gwImage} -n ${KUBE_NS}
                  ${K} rollout status statefulset/gateway -n ${KUBE_NS} --timeout=3m
                elif ${K} get deployment/claude-gateway -n ${KUBE_NS} >/dev/null 2>&1; then
                  CONTAINER=\$(${K} get deployment/claude-gateway -n ${KUBE_NS} -o jsonpath='{.spec.template.spec.containers[0].name}')
                  ${K} set image deployment/claude-gateway "\$CONTAINER=${gwImage}" -n ${KUBE_NS}
                  ${K} rollout status deployment/claude-gateway -n ${KUBE_NS} --timeout=3m
                else
                  echo 'gateway workload not found – skipping'
                fi
              """
            }
          }
        }
      }
    }

    // ── 8. Release + Mirror (parallel, nur main) ─────────────────────
    stage('Post') {
      when {
        branch 'main'
        not { changeRequest() }
      }
      parallel {

        stage('Auto Release') {
          steps {
            container('alpine') {
              withCredentials([string(credentialsId: 'gitea-api-token', variable: 'GITEA_TOKEN')]) {
                sh '''
                  apk add --no-cache -q jq nodejs npm git python3
                  git config --global --add safe.directory "$(pwd)"

                  API="${GITEA_URL}/api/v1/repos/${GITEA_REPO}"
                  LAST_TAG=$(wget -q -O- --header="Authorization: token ${GITEA_TOKEN}" "$API/tags?limit=1" \
                    | python3 -c "import sys,json; d=json.load(sys.stdin); print(d[0]['name'] if d else 'v0.0.0')")
                  TAG_SHA=$(wget -q -O- --header="Authorization: token ${GITEA_TOKEN}" "$API/tags?limit=1" \
                    | python3 -c "import sys,json; d=json.load(sys.stdin); print(d[0]['commit']['sha'] if d else '')")
                  HEAD_SHA=$(git rev-parse HEAD)

                  if [ "$TAG_SHA" = "$HEAD_SHA" ]; then
                    echo "HEAD already tagged - skipping"
                    exit 0
                  fi

                  COMMITS=$(wget -q -O- --header="Authorization: token ${GITEA_TOKEN}" "$API/commits?sha=main&limit=50" \
                    | python3 -c "
import sys,json
commits = json.load(sys.stdin)
stop = '$TAG_SHA'
for c in commits:
    if c['sha'] == stop: break
    msg = c['commit']['message'].split(chr(10))[0]
    if not msg.startswith('Merge ') and '[tx-log]' not in msg:
        print(msg)
")
                  if [ -z "$COMMITS" ]; then
                    echo "No real commits since $LAST_TAG - skipping"
                    exit 0
                  fi

                  BUMP=patch
                  echo "$COMMITS" | grep -qiE "BREAKING CHANGE" && BUMP=major || true
                  echo "$COMMITS" | grep -qE "^feat" && [ "$BUMP" != "major" ] && BUMP=minor || true

                  NEW_TAG=$(echo "$LAST_TAG" | python3 -c "
import sys, re
tag = sys.stdin.read().strip()
bump = '$BUMP'
m = re.match(r'v?(\\d+)\\.(\\d+)\\.(\\d+)', tag)
ma,mi,pa = int(m.group(1)),int(m.group(2)),int(m.group(3))
if bump=='major': print(f'v{ma+1}.0.0')
elif bump=='minor': print(f'v{ma}.{mi+1}.0')
else: print(f'v{ma}.{mi}.{pa+1}')
")
                  echo "Tag: $LAST_TAG -> $BUMP -> $NEW_TAG"

                  RESP=$(wget -q -O /tmp/tag.json --server-response \
                    --header="Authorization: token ${GITEA_TOKEN}" \
                    --header="Content-Type: application/json" \
                    --post-data="{\"tag_name\":\"$NEW_TAG\",\"target\":\"$HEAD_SHA\"}" \
                    "$API/tags" 2>&1 | grep 'HTTP/' | tail -1 | awk '{print $2}')
                  [ "$RESP" = "201" ] || { echo "Tag exists or error ($RESP)"; exit 0; }

                  node scripts/generate-release-notes.js "$NEW_TAG" --public > /tmp/rel-pub.md 2>/dev/null || echo "Release $NEW_TAG" > /tmp/rel-pub.md
                  node scripts/generate-release-notes.js "$NEW_TAG" > /tmp/rel-int.md 2>/dev/null || true
                  BODY=$(cat /tmp/rel-pub.md)

                  wget -q -O- \
                    --header="Authorization: token ${GITEA_TOKEN}" \
                    --header="Content-Type: application/json" \
                    --post-data="$(jq -n --arg tag "$NEW_TAG" --arg name "$NEW_TAG" --arg body "$BODY" \
                      '{tag_name:$tag,name:$name,body:$body,draft:true}')" \
                    "$API/releases"
                  echo "Draft release $NEW_TAG created"
                '''
              }
            }
          }
        }

        stage('Mirror to GitHub') {
          steps {
            container('ubuntu') {
              withCredentials([string(credentialsId: 'gh-pat-token', variable: 'GH_PAT')]) {
                sh '''
                  apt-get update -qq && apt-get install -y -qq git bash python3 > /dev/null 2>&1
                  git config --global --add safe.directory "$(pwd)"

                  git config user.email "public-mirror@users.noreply.local"
                  git config user.name "public-mirror"
                  git remote remove github 2>/dev/null || true
                  git remote add github "https://fgrosswig:${GH_PAT}@github.com/fgrosswig/claude-usage-dashboard.git"

                  SHORT=$(git rev-parse --short HEAD)
                  EXPORT_DIR="/tmp/mirror-${SHORT}"
                  rm -rf "${EXPORT_DIR}" && mkdir -p "${EXPORT_DIR}"
                  tar --exclude=.git -cf - . | (cd "${EXPORT_DIR}" && tar -xf -)
                  rm -rf "${EXPORT_DIR}/.gitea" "${EXPORT_DIR}/.woodpecker"
                  bash "${EXPORT_DIR}/scripts/scrub-for-public.sh" "${EXPORT_DIR}"

                  git fetch github "refs/heads/main:refs/remotes/github/main" 2>/dev/null || git fetch github || true
                  if git rev-parse --verify "github/main" >/dev/null 2>&1; then
                    git checkout -B public-publish "github/main"
                    git ls-files -z | xargs -0 -r git rm -f --
                    git clean -fdx
                  else
                    git checkout --orphan public-publish
                  fi
                  tar -C "${EXPORT_DIR}" -cf - . | tar -xf -
                  git add -A
                  git diff --cached --quiet && echo "No changes to mirror" && exit 0
                  git commit -m "chore(publish): public snapshot (internal ${SHORT})"
                  git push github "HEAD:refs/heads/main"
                  echo "Mirrored to GitHub"
                '''
              }
              // Mirror Gitea releases to GitHub
              withCredentials([string(credentialsId: 'gitea-api-token', variable: 'GITEA_TOKEN')]) {
                sh '''
                  python3 << 'PYEOF'
import json, os, re, sys, urllib.error, urllib.request

gitea_token = os.environ["GITEA_TOKEN"]
gh_token = os.environ["GH_PAT"]

req = urllib.request.Request(
    "https://gitea.grosswig-it.de/api/v1/repos/GRO/Claude-Usage-Dashboard/releases?limit=50",
    headers={"Authorization": "token " + gitea_token}
)
try:
    with urllib.request.urlopen(req, timeout=30) as r:
        releases = json.load(r)
except Exception as e:
    print("Failed to fetch Gitea releases:", e)
    sys.exit(0)

if not releases:
    print("No Gitea releases found, skip")
    sys.exit(0)

releases.reverse()

for rel in releases:
    tag = rel["tag_name"]
    if rel.get("prerelease"):
        continue

    check = urllib.request.Request(
        f"https://api.github.com/repos/fgrosswig/claude-usage-dashboard/releases/tags/{tag}",
        headers={"Authorization": "Bearer " + gh_token, "Accept": "application/vnd.github+json"}
    )
    try:
        urllib.request.urlopen(check, timeout=15)
        print(f"GitHub release {tag} exists, skip")
        continue
    except urllib.error.HTTPError as e:
        if e.code != 404:
            continue

    body = rel.get("body", "")
    if "<!--INTERNAL-->" in body:
        body = body.split("<!--INTERNAL-->", 1)[0].rstrip()
    body = re.sub(r"https?://gitea\\.grosswig-it\\.de[^\\s)]*", "https://github.com/fgrosswig/claude-usage-dashboard", body)
    body = re.sub(r"https?://ci\\.grosswig-it\\.de[^\\s)]*", "", body)
    body = re.sub(r"https?://claude-usage\\.grosswig-it\\.de[^\\s)]*", "", body)
    body = re.sub(r"https?://harbor\\.grosswig-it\\.de[^\\s)]*", "", body)
    body = re.sub(r"https?://sonar\\.grosswig-it\\.de[^\\s)]*", "", body)

    is_last = (rel == releases[-1])
    payload = json.dumps({
        "tag_name": tag, "target_commitish": "main",
        "name": rel["name"], "body": body,
        "draft": False, "prerelease": False,
        "make_latest": "true" if is_last else "false"
    }).encode()

    create = urllib.request.Request(
        "https://api.github.com/repos/fgrosswig/claude-usage-dashboard/releases",
        data=payload,
        headers={"Authorization": "Bearer " + gh_token, "Accept": "application/vnd.github+json", "Content-Type": "application/json"},
        method="POST"
    )
    try:
        with urllib.request.urlopen(create, timeout=30) as r:
            result = json.load(r)
            print(f"GitHub release created: {result.get('html_url', '')}")
    except Exception as e:
        print(f"Failed to create GitHub release {tag}: {e}")
PYEOF
                '''
              }
            }
          }
        }
      }
    }
  }

  post {
    always {
      container('docker') {
        sh 'docker logout ${HARBOR} || true'
      }
    }
    success {
      echo "Pipeline succeeded: ${env.APP_VERSION}"
    }
    failure {
      echo "Pipeline failed on branch ${env.BRANCH_NAME}"
    }
  }
}

// Returns tag list: main → ['latest', SHA], others → ['dev-SHA']
def buildTagList(String target) {
  if (env.IS_MAIN == 'true') {
    return ['latest', env.SHORT_SHA]
  }
  return [env.IMAGE_TAG]
}
