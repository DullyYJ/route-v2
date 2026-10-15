// /scene (혼잡도 카드 장면 엔진) — 워커 연결(HTTP·날씨 받기·버전) 시험.  실행: node test/scene.test.js
// 판정 로직 시험은 앱 저장소 test/scene_engine.test.js(engine/scene.js 가 단일 출처). 여기서는 워커에 붙인 판정 함수가 그 파일과 같은지도 본다.
const fs = require('fs'), assert = require('assert'), path = require('path');
let src = fs.readFileSync(path.join(__dirname, '..', 'route-v2-worker.js'), 'utf8');
const ei = src.lastIndexOf('\nexport {'); src = src.slice(0, ei) + '\n';
let wxMode = 'ok', wxBody = { ok: true, temp: 12, rain: 10, txt: '맑음' }, wxCalls = 0;
const fakeFetch = async (u) => { if (String(u).includes('/weather')) { wxCalls++; if (wxMode === 'fail') throw new Error('x'); return new Response(JSON.stringify(wxBody), { status: 200 }); } throw new Error('unexpected fetch ' + u); };
const caches = { default: { async match() { return undefined; }, async put() {} } };
const W = new Function('caches', 'fetch', src + '\nreturn { w: route_v2_worker_default, decide: sceneDecide, V: ENGINE_VERSION, hint: SCENE_HINT_BUS };');
const { w, decide, V, hint } = W(caches, fakeFetch);
const env = { DATA_GO_KR_KEY: 'x' };
const ms = (s) => Date.parse(s + '+09:00');
const post = async (b) => JSON.parse(await (await w.fetch(new Request('https://x.test/scene', { method: 'POST', body: JSON.stringify(b) }), env, { waitUntil() {} })).text());
let pass = 0, fail = 0;
const t = async (n, f) => { try { await f(); pass++; console.log('  ok  ', n); } catch (e) { fail++; console.log('  FAIL', n, '\n      ', String(e.message || e).slice(0, 500)); } };
(async () => {
  await t('버전 s27', () => assert.strictEqual(V, 'route-v2-2026-10-15s27'));
  await t('워커의 판정 함수 = 앱 저장소 engine/scene.js (단일 출처 복사본 일치)', () => {
    const p = ['/home/claude/work/app/Subway-app/engine/scene.js', path.join(__dirname, '..', '..', 'Subway-app', 'engine', 'scene.js')].find(f => fs.existsSync(f));
    if (!p) { console.log('       (engine/scene.js 가 없어 건너뜀)'); return; }
    const e = fs.readFileSync(p, 'utf8'), a = e.indexOf('var SCENE_CHARS'), b = e.indexOf('\nif (typeof module'), pure = e.slice(a, b).trim();
    assert(src.includes(pure), '워커 안의 장면 판정 코드가 engine/scene.js 와 다르다');
  });
  await t('판정 요약: 버스 대기→wait·탑승→ride·지하철 탑승 확정→혼잡도', () => {
    const N = (o) => Object.assign({ name: '', isSub: false, isBus: false, isWalk: false, isOrigin: false, lineName: '', hasLoc: true }, o);
    const nodes = [N({ isOrigin: true, name: 'o' }), N({ isWalk: true, name: 'w' }), N({ isBus: true, name: 'a', lineName: '1' }), N({ isBus: true, name: 'b', lineName: '1' }), N({ isBus: true, name: 'c', lineName: '1' }), N({ isSub: true, name: 's', lineName: '2호선' }), N({ isSub: true, name: 't', lineName: '2호선' })];
    assert.strictEqual(decide({ locked: true, here: 1, nodes }, null).mode, 'wait'); assert.strictEqual(decide({ locked: true, here: 2, boarded: true, nodes }, null).mode, 'ride');
    assert.strictEqual(decide({ locked: true, here: 5, boarded: true, nodes }, null).mode, 'wait'); assert.strictEqual(decide({ locked: true, here: 6, boarded: true, nodes }, null).cong.kind, 'sub'); assert.strictEqual(hint, '지하철 탑승시 혼잡도가 나와요!');
  });
  await t('HTTP: 날씨를 엔진이 직접 받아 장면에 싣는다 · 10분 캐시 · 실패하면 날씨를 지어내지 않는다 · POST 만', async () => {
    wxBody = { ok: true, temp: -2, rain: 80, txt: '눈' }; wxMode = 'ok';
    const r = await post({ nowMs: ms('2026-12-01T19:00:00'), lat: 37.5, lng: 127.0, locked: false });
    assert.strictEqual(r.ok, true); assert.strictEqual(r.look.wk, 'snow'); assert.strictEqual(r.look.slot, 'evening'); assert.strictEqual(r.v, V); assert(/눈/.test(r.tag));
    const n0 = wxCalls; await post({ nowMs: ms('2026-12-01T19:05:00'), lat: 37.5, lng: 127.0, locked: false }); assert.strictEqual(wxCalls, n0, '10분 안에는 다시 받지 않는다');
    wxMode = 'fail'; const f = await post({ nowMs: ms('2026-12-01T19:00:00'), lat: 35.1, lng: 129.0, locked: false }); assert.strictEqual(f.look.wxKnown, false);
    const g = await post({ nowMs: ms('2026-12-01T19:00:00'), locked: false }); assert.strictEqual(g.look.wxKnown, false);
    const bad = await w.fetch(new Request('https://x.test/scene'), env, { waitUntil() {} }); assert.strictEqual(bad.status, 405);
  });
  console.log(pass + ' pass, ' + fail + ' fail'); process.exit(fail ? 1 : 0);
})();
