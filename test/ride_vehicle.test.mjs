// gildongmu-ride 워커 시험 — 모의 TAGO. 실행: node test/ride_vehicle.test.mjs [ride-vehicle/index.js 경로]
import assert from 'node:assert';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
const file = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve('ride-vehicle/index.js');
const W = await import(pathToFileURL(file).href);
let pass = 0, fail = 0;
const t = async (name, fn) => { try { await fn(); pass++; console.log('  ok  ', name); } catch (e) { fail++; console.log('  FAIL', name, '\n      ', String(e.message).split('\n')[0]); } };

// ── 모의 TAGO ─────────────────────────────────────────────
const calls = [];
let SLOW_DIRECT_MS = 0, DIRECT_FAIL = false, VEHICLES = {}, ROUTES = {}, STOPS = {};
const okBody = (items) => JSON.stringify({ response: { header: { resultCode: '00' }, body: { items: items.length ? { item: items } : '', totalCount: items.length } } });
async function tagoReply(u, via) {
  const x = new URL(u); const op = x.pathname.split('/').pop(); calls.push(via + ':' + op);
  if (op === 'getCrdntPrxmtSttnList') return okBody(STOPS[x.searchParams.get('gpsLati')] || []);
  if (op === 'getRouteNoList') return okBody(ROUTES[x.searchParams.get('cityCode') + '|' + x.searchParams.get('routeNo')] || []);
  if (op === 'getRouteAcctoBusLcList') return okBody(VEHICLES[x.searchParams.get('cityCode') + '|' + x.searchParams.get('routeId')] || []);
  return okBody([]);
}
globalThis.fetch = async (u) => {
  if (DIRECT_FAIL) { await new Promise((r) => setTimeout(r, 50)); return new Response('error code: 522', { status: 522 }); }
  if (SLOW_DIRECT_MS) await new Promise((r) => setTimeout(r, SLOW_DIRECT_MS));
  return new Response(await tagoReply(String(u), 'direct'), { status: 200 });
};
const BUSAPI = { fetch: async (req) => { const u = new URL(req.url); const inner = decodeURIComponent(u.searchParams.get('url')); return new Response(await tagoReply(inner, 'binding'), { status: 200 }); } };

const LAT = 37.5, LNG = 126.7;
const mv = (m) => m / 111320 / Math.cos(LAT * Math.PI / 180);       // 동쪽 m → 경도
const veh = (no, eastM, ord) => ({ gpslati: LAT, gpslong: +(LNG + mv(eastM)).toFixed(6), nodeid: 'ICB1' + ord, nodenm: '정류장' + ord, nodeord: ord, routenm: 58, routetp: '간선버스', vehicleno: no });
const reset = () => { calls.length = 0; SLOW_DIRECT_MS = 0; DIRECT_FAIL = false; for (const m of [W.MEM.veh, W.MEM.route, W.MEM.city, W.MEM.inflight]) m.clear();
  STOPS = { [String(LAT)]: [{ citycode: 23, nodeid: 'ICB367000428', nodenm: '가' }] };
  ROUTES = { '23|58': [{ routeid: 'ICB361000007', routeno: 58 }, { routeid: 'ICB361000099', routeno: '58-1' }], '23|9': [{ routeid: 'R9A', routeno: '9(강화)' }, { routeid: 'R9B', routeno: 9 }] };
  VEHICLES = { '23|ICB361000007': [veh('인천72아1', 100, 5), veh('인천72아2', 2500, 9), veh('인천72아3', -3000, 2)] }; };
const REQ = (o) => ({ fix: { lat: LAT, lng: LNG }, cands: [{ busNo: '58', boardStopId: 'ICB367000428', lat: LAT, lng: LNG }], ...o });
const env = { TAGO_KEY: 'k', BUSAPI };

console.log('[순수 함수]');
await t('hav: 동쪽 1000m 는 1000m', () => assert.ok(Math.abs(W.hav(LAT, LNG, LAT, LNG + mv(1000)) - 1000) < 3));
await t('normVehicle: 문자열 좌표도 받고, 좌표·번호판이 없으면 버린다', () => {
  assert.strictEqual(W.normVehicle({ gpslati: '37.39', gpslong: '126.64', vehicleno: 'A' }).lat, 37.39);
  assert.strictEqual(W.normVehicle({ gpslati: 0, gpslong: 0, vehicleno: 'A' }), null);
  assert.strictEqual(W.normVehicle({ gpslati: 37.5, gpslong: 126.7, vehicleno: '' }), null);
});
const V = (no, d) => ({ vehicleno: no, lat: LAT, lng: LNG + mv(d) });
await t('pickVehicle: 150m 안의 한 대, 다음 차 2km → sure', () => assert.strictEqual(W.pickVehicle([V('a', 150), V('b', 2000)], { lat: LAT, lng: LNG }).conf, 'sure'));
await t('pickVehicle: 두 대가 비슷하게 붙어 있으면(100m·130m) sure 아님', () => { const r = W.pickVehicle([V('a', 100), V('b', 130)], { lat: LAT, lng: LNG }); assert.notStrictEqual(r.conf, 'sure'); assert.notStrictEqual(r.conf, 'likely'); });
await t('pickVehicle: 300m·500m → likely', () => assert.strictEqual(W.pickVehicle([V('a', 300), V('b', 500)], { lat: LAT, lng: LNG }).conf, 'likely'));
await t('pickVehicle: 가장 가까운 차도 800m 면 weak', () => assert.strictEqual(W.pickVehicle([V('a', 800)], { lat: LAT, lng: LNG }).conf, 'weak'));
await t('pickVehicle: 차량이 없으면 none', () => assert.strictEqual(W.pickVehicle([], { lat: LAT, lng: LNG }).conf, 'none'));

console.log('[요청 처리]');
reset();
await t('내 위치 근처 차량을 고른다(번호판·노선·정류장 순번)', async () => {
  const r = await W.handleVehicle(REQ(), env);
  assert.strictEqual(r.ok, true); assert.strictEqual(r.match.vehicleno, '인천72아1'); assert.strictEqual(r.match.conf, 'sure');
  assert.strictEqual(r.match.routeKey, '23_ICB361000007'); assert.strictEqual(r.match.nodeord, 5); assert.strictEqual(r.n, 3);
});
await t('노선번호가 정확히 같은 노선만 쓴다(58 ≠ 58-1)', async () => { assert.ok(!calls.some((c) => false)); const r = await W.handleVehicle(REQ(), env); assert.ok(r.match.routeKey.endsWith('ICB361000007')); });
await t('같은 요청을 다시 보내면 상위 호출은 늘지 않는다(캐시)', async () => { const n0 = calls.length; await W.handleVehicle(REQ(), env); assert.strictEqual(calls.length, n0); });
await t('동시에 여러 사용자가 보내도 상위 호출은 한 번씩', async () => {
  reset(); await Promise.all([1, 2, 3, 4, 5].map(() => W.handleVehicle(REQ(), env)));
  assert.strictEqual(calls.filter((c) => c.endsWith('getRouteAcctoBusLcList')).length, 1, calls.join(','));
});
await t('lock: 고른 차가 아직 내 근처면 found + dist', async () => {
  const r = await W.handleVehicle(REQ({ lock: { vehicleno: '인천72아1', routeKey: '23_ICB361000007' } }), env);
  assert.strictEqual(r.lock.found, true); assert.ok(r.lock.dist < 150);
});
await t('lock: 고른 차가 멀리 있으면 dist 가 커서 앱이 해제할 수 있다', async () => {
  const r = await W.handleVehicle(REQ({ lock: { vehicleno: '인천72아2', routeKey: '23_ICB361000007' } }), env);
  assert.strictEqual(r.lock.found, true); assert.ok(r.lock.dist > 2000);
});
await t('lock: 목록에 없는 번호판은 found:false', async () => { const r = await W.handleVehicle(REQ({ lock: { vehicleno: '없는차' } }), env); assert.strictEqual(r.lock.found, false); });
await t('차량 위치 자료가 늦어 지금 위치와 500m 떨어져 보여도, 20초 전 내 위치와는 가까우면 고른다', async () => {
  reset(); VEHICLES['23|ICB361000007'] = [veh('인천72아1', -200, 5), veh('인천72아2', 2500, 9)];
  const fixNow = { lat: LAT, lng: LNG + mv(300) };   // 지금은 차량보다 500m 앞
  const without = await W.handleVehicle(REQ({ fix: fixNow }), env);
  assert.notStrictEqual(without.match.conf, 'sure');
  const withTrail = await W.handleVehicle(REQ({ fix: fixNow, fixes: [{ lat: LAT, lng: LNG + mv(-120) }] }), env);
  assert.strictEqual(withTrail.match.conf, 'sure'); assert.strictEqual(withTrail.match.vehicleno, '인천72아1');
});
await t('후보 노선이 여럿이면 가까운 차가 속한 후보(cand)를 알려 준다', async () => {
  reset(); ROUTES['23|90'] = [{ routeid: 'R90', routeno: 90 }]; VEHICLES['23|R90'] = [veh('다른90', 60, 3)];
  VEHICLES['23|ICB361000007'] = [veh('인천72아1', 400, 5)];
  const r = await W.handleVehicle(REQ({ cands: [{ busNo: '58', boardStopId: 'ICB367000428', lat: LAT, lng: LNG }, { busNo: '90', boardStopId: 'ICB367000428', lat: LAT, lng: LNG }] }), env);
  assert.strictEqual(r.match.vehicleno, '다른90'); assert.strictEqual(r.match.cand, 1);
});
await t('"9" 는 9(강화) 가 아니라 9 노선을 쓴다', async () => {
  reset(); VEHICLES['23|R9A'] = [veh('강화차', 50, 1)]; VEHICLES['23|R9B'] = [veh('인천차', 80, 1)];
  const r = await W.handleVehicle(REQ({ cands: [{ busNo: '9', boardStopId: 'ICB367000428', lat: LAT, lng: LNG }] }), env);
  assert.strictEqual(r.match.vehicleno, '인천차');
});
await t('도시를 못 찾는 정류장(미지원 지역)은 unsupported 로 센다', async () => {
  reset(); STOPS = {};
  const r = await W.handleVehicle(REQ(), env); assert.strictEqual(r.ok, true); assert.strictEqual(r.unsupported, 1); assert.strictEqual(r.match, undefined);
});
await t('운행 중인 차가 없으면 match 없음', async () => { reset(); VEHICLES = {}; const r = await W.handleVehicle(REQ(), env); assert.strictEqual(r.n, 0); assert.strictEqual(r.match, undefined); });
await t('입력이 이상하면 ok:false', async () => { assert.strictEqual((await W.handleVehicle({ fix: { lat: 0, lng: 0 }, cands: [] }, env)).ok, false); assert.strictEqual((await W.handleVehicle({ fix: { lat: LAT, lng: LNG } }, env)).ok, false); });

console.log('[네트워크 길]');
await t('직접 호출이 522 로 막히면 바인딩으로 이어진다', async () => { reset(); DIRECT_FAIL = true; const r = await W.handleVehicle(REQ(), env); assert.strictEqual(r.match.vehicleno, '인천72아1'); assert.ok(calls.some((c) => c.startsWith('binding'))); });
await t('직접 호출이 느리면(1.2초) 800ms 뒤 바인딩이 먼저 답한다', async () => { reset(); SLOW_DIRECT_MS = 1200; const t0 = Date.now(); const r = await W.handleVehicle(REQ(), env); assert.strictEqual(r.match.vehicleno, '인천72아1'); assert.ok(Date.now() - t0 < 4000); });
await t('키도 바인딩도 없으면 후보마다 오류를 적고 ok:true, match 없음', async () => { reset(); const r = await W.handleVehicle(REQ(), {}); assert.strictEqual(r.ok, true); assert.strictEqual(r.match, undefined); assert.ok(r.dbg && r.dbg.length); });

console.log('[HTTP]');
await t('/health 는 버전과 키 유무만 알려 준다(키 값 없음)', async () => {
  const r = await W.handle(new Request('https://x/health'), env); const j = await r.json(); assert.strictEqual(j.ver, W.VER); assert.strictEqual(j.keys.direct, true); assert.ok(!JSON.stringify(j).includes('"k"'));
});
await t('POST /vehicle 가 동작하고 CORS 를 준다', async () => {
  reset(); const r = await W.handle(new Request('https://x/vehicle', { method: 'POST', body: JSON.stringify(REQ()) }), env);
  assert.strictEqual(r.headers.get('access-control-allow-origin'), '*'); assert.strictEqual((await r.json()).match.vehicleno, '인천72아1');
});
await t('깨진 JSON 은 400', async () => { const r = await W.handle(new Request('https://x/vehicle', { method: 'POST', body: '{' }), env); assert.strictEqual(r.status, 400); });
await t('OPTIONS 는 204', async () => { assert.strictEqual((await W.handle(new Request('https://x/vehicle', { method: 'OPTIONS' }), env)).status, 204); });

console.log('\n' + pass + ' 통과 / ' + fail + ' 실패');
process.exit(fail ? 1 : 0);
