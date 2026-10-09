# route-v2 (길동무 엔진) · board-writer

**이 저장소는 자동 배포되지 않습니다.** (2026-10-09 Cloudflare Workers Builds 연결을 껐습니다.)
저장소에 푸시해도 Cloudflare 워커는 바뀌지 않습니다. 배포는 Cloudflare 대시보드에서 직접 합니다.

- `route-v2-worker.js` — 현재 운영 중인 엔진(빌드 결과물, 버전 `route-v2-2026-10-09s17`). 엔진 소스·빌드 방법은 앱 저장소 `DullyYJ/Subway-app`의 `tools/route-speed/make.sh`(HANDOFF.md 참조). 새 엔진을 만들면 이 파일도 같은 것으로 맞춰 둔다.
- `board-writer/index.js` — 게시판 글쓰기 워커. 대시보드의 board-writer 에 붙여넣어 Deploy.
- 시험: `node test/*.test.js` (루트의 `alight_delta`·`pick_edge` 시험은 `test/` 안으로 옮겨야 돈다).

배포를 다시 자동으로 켜려면 대시보드(Workers → route-v2 → Settings → Builds)에서 저장소를 연결하세요. 켜기 전에 이 저장소의 `route-v2-worker.js` 가 운영 엔진과 같은지 먼저 확인하세요.
