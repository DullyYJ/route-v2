// gildongmu-ride — 서울(TOPIS)·경기(GBIS) 버스 위치 시험(모의 응답). 실행: node test/ride_vehicle_seoul_gbis.test.mjs [ride-vehicle/index.js 경로]
import assert from 'node:assert';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
const file = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve('ride-vehicle/index.js');
const W = await import(pathToFileURL(file).href);
let pass = 0, fail = 0;
const t = async (name, fn) => { try { await fn(); pass++; console.log('  ok  ', name); } catch (e) { fail++; console.log('  FAIL', name, '\n      ', String(e.message).split('\n')[0]); } };

const LAT = 37.5, LNG = 127.0;
const mvE = (m) => +(LNG + m / 111320 / Math.cos(LAT * Math.PI / 180)).toFixed(6);   // 동쪽 m → 경도
const calls = [];
let SEOUL_ROUTES = [], SEOUL_POS = [], SEOUL_FAIL = null, GG_ROUTES = [], GG_STATIONS = {}, GG_LOC = {}, TAGO_STOPS = [], TAGO_ROUTES = [], TAGO_VEH = [], GG_FAIL = false;
const xml = (items, code) => '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><ServiceResult><comMsgHeader/><msgHeader><headerCd>' + (code == null ? 0 : code) + '</headerCd><headerMsg>' + (code ? 'LIMITED NUMBER OF SERVICE REQUESTS EXCEEDS' : '정상적으로 처리되었습니다.') + '</headerMsg><itemCount>0</itemCount></msgHeader><msgBody>' + items.map((o) => '<itemList>' + Object.keys(o).map((k) => '<' + k + '>' + o[k] + '</' + k + '>').join('') + '</itemList>').join('') + '</msgBody></ServiceResult>';
const gj = (key, list) => JSON.stringify({ response: { comMsgHeader: '', msgHeader: { queryTime: 'x', resultCode: list.length ? 0 : 4, resultMessage: 'x' }, msgBody: list.length ? { [key]: list } : undefined } });
const tj = (items) => JSON.stringify({ response: { header: { resultCode: '00' }, body: { items: items.length ? { item: items } : '', totalCount: items.length } } });
const kst = (d) => { const x = new Date(d.getTime() + 9 * 3600e3); const p = (n) => String(n).padStart(2, '0'); return '' + x.getUTCFullYear() + p(x.getUTCMonth() + 1) + p(x.getUTCDate()) + p(x.getUTCHours()) + p(x.getUTCMinutes()) + p(x.getUTCSeconds()); };
async function reply(inner) {
  const x = new URL(inner); const op = x.pathname.split('/').pop(); calls.push(op);
  if (op === 'getBusRouteList') return xml(SEOUL_ROUTES);
  if (op === 'getBusPosByRtid') { if (SEOUL_FAIL != null) return xml([], SEOUL_FAIL); return xml(SEOUL_POS); }
  if (op === 'getBusRouteListv2') return GG_FAIL ? 'error' : gj('busRouteList', GG_ROUTES);
  if (op === 'getBusRouteStationListv2') return gj('busRouteStationList', GG_STATIONS[x.searchParams.get('routeId')] || []);
  if (op === 'getBusLocationListv2') return gj('busLocationList', GG_LOC[x.searchParams.get('routeId')] || []);
  if (op === 'getCrdntPrxmtSttnList') return tj(TAGO_STOPS);
  if (op === 'getRouteNoList') return tj(TAGO_ROUTES);
  if (op === 'getRouteAcctoBusLcList') return tj(TAGO_VEH);
  return tj([]);
}
globalThis.fetch = async () => new Response('direct not used', { status: 500 });
const BUSAPI = { fetch: async (req) => { const u = new URL(req.url); const inner = decodeURIComponent(u.searchParams.get('url')); return new Response(await reply(inner), { status: 200 }); } };
const env = { BUSAPI };
const reset = () => {
  calls.length = 0; for (const m of [W.MEM.veh, W.MEM.route, W.MEM.city, W.MEM.stn, W.MEM.inflight]) m.clear(); W.MEM.seoulRestUntil = 0;
  SEOUL_FAIL = null; GG_FAIL = false; TAGO_STOPS = []; TAGO_ROUTES = []; TAGO_VEH = [];
  SEOUL_ROUTES = [{ busRouteId: '100100075', busRouteNm: '472', busRouteAbrv: '472' }, { busRouteId: '100100999', busRouteNm: '4720', busRouteAbrv: '4720' }];
  const dm = kst(new Date(Date.now() - 20000));
  const sv = (no, east, extra) => Object.assign({ plainNo: no, gpsX: mvE(east), gpsY: LAT, lastStnId: '122000205', sectOrd: '7', isrunyn: '1', dataTm: dm, vehId: '1' + no.length }, extra || {});
  SEOUL_POS = [sv('서울70사1', 80), sv('서울70사2', 1800), sv('서울70사3', -2500), sv('서울70사4', 10, { isrunyn: '0' })];
  const stn = (seq, id, east) => ({ stationSeq: seq, stationId: Number(id), stationName: '정류소' + seq, x: mvE(east), y: LAT });
  GG_ROUTES = [{ routeId: 200000342, routeName: 9200, regionName: '성남,수원' }, { routeId: 200000100, routeName: 92, regionName: '수원' }, { routeId: 200000101, routeName: 92, regionName: '안산' }, { routeId: 200000102, routeName: '92-1', regionName: '수원' }];
  // 92(수원): 정류소 1..6, 동쪽으로 600m 간격. 승차 정류소 204000003 = seq 3(동쪽 1200m)
  GG_STATIONS = { '200000100': [1, 2, 3, 4, 5, 6].map((q) => stn(q, '20400000' + q, (q - 1) * 600)), '200000101': [1, 2, 3].map((q) => stn(q, '29900000' + q, (q - 1) * 600 + 90000)) };
  GG_LOC = { '200000100': [{ plateNo: '경기70바1', stationSeq: 3, stationId: 204000003, stateCd: 1, vehId: 1 }, { plateNo: '경기70바2', stationSeq: 6, stationId: 204000006, stateCd: 0, vehId: 2 }, { plateNo: '경기70바3', stationSeq: 1, stationId: 204000001, stateCd: 2, vehId: 3 }], '200000101': [{ plateNo: '경기70안1', stationSeq: 2, stationId: 299000002, stateCd: 1, vehId: 9 }] };
};
const FIX = { lat: LAT, lng: mvE(1200) };
const SEL = (o) => ({ fix: { lat: LAT, lng: mvE(60) }, cands: [{ busNo: '472', boardStopId: 'SEL122000205', lat: LAT, lng: mvE(0) }], ...o });
const GGB = (o) => ({ fix: FIX, cands: [{ busNo: '92', boardStopId: 'GGB204000003', lat: LAT, lng: mvE(1200) }], ...o });

console.log('[응답 해석]');
await t('parseSeoul: 정상 응답의 itemList 를 객체로', () => { const r = W.parseSeoul(xml([{ plainNo: 'A', gpsX: '127.1', gpsY: '37.5' }, { plainNo: 'B', gpsX: '127.2', gpsY: '37.6' }])); assert.ok(r.ok); assert.strictEqual(r.items.length, 2); assert.strictEqual(r.items[1].plainNo, 'B'); });
await t('parseSeoul: 결과 없음(4)은 빈 목록, 한도(5)는 seoul-limit, XML 이 아니면 실패', () => {
  assert.deepStrictEqual(W.parseSeoul(xml([], 4)).items, []);
  assert.strictEqual(W.parseSeoul(xml([], 5)).why, 'seoul-limit');
  assert.strictEqual(W.parseSeoul('Forbidden host').ok, false);
});
await t('parseGbis: 정상·결과없음(4)·인증 실패', () => {
  assert.strictEqual(W.parseGbis(gj('busLocationList', [{ a: 1 }]), 'busLocationList').items.length, 1);
  assert.deepStrictEqual(W.parseGbis(gj('busLocationList', []), 'busLocationList').items, []);
  assert.strictEqual(W.parseGbis('{"OpenAPI_ServiceResponse":{}}', 'x').why, 'auth');
});
await t('vehDist: 선분 거리 — 구간 가운데 점은 양 끝점보다 훨씬 가깝다', () => {
  const v = { lat: LAT, lng: mvE(0), pts: [{ lat: LAT, lng: mvE(0) }, { lat: LAT, lng: mvE(1000) }] };
  assert.ok(W.vehDist(v, { lat: LAT + 0.0009, lng: mvE(500) }) < 105);   // 북쪽 100m
  assert.ok(W.hav(LAT + 0.0009, mvE(500), LAT, mvE(0)) > 500);
});

console.log('[서울]');
reset();
await t('서울 정류소(SEL+9자리)는 TAGO 를 거치지 않고 서울 위치로 고른다', async () => {
  const r = await W.handleVehicle(SEL(), env);
  assert.strictEqual(r.ok, true); assert.strictEqual(r.match.vehicleno, '서울70사1'); assert.strictEqual(r.match.conf, 'sure'); assert.strictEqual(r.match.src, 'seoul');
  assert.strictEqual(r.match.routeKey, 'S_100100075'); assert.strictEqual(r.match.nodeid, 'SEL122000205'); assert.strictEqual(r.n, 3);   // 운행 아닌 차(isrunyn 0)는 뺀다
  assert.ok(!calls.includes('getCrdntPrxmtSttnList'), calls.join(','));
});
await t('노선번호가 정확히 같은 노선만(472 ≠ 4720)', async () => { assert.strictEqual(calls.filter((c) => c === 'getBusPosByRtid').length, 1); });
await t('자료 시각(dataTm) 20초 전이면 ageMs 에 반영된다', async () => { const r = await W.handleVehicle(SEL(), env); assert.ok(r.match.ageMs >= 19000 && r.match.ageMs < 30000, String(r.match.ageMs)); });
await t('같은 요청 반복은 상위 호출이 늘지 않는다(10초 캐시)·동시 요청은 합친다', async () => {
  reset(); await Promise.all([1, 2, 3, 4].map(() => W.handleVehicle(SEL(), env)));
  assert.strictEqual(calls.filter((c) => c === 'getBusPosByRtid').length, 1); assert.strictEqual(calls.filter((c) => c === 'getBusRouteList').length, 1);
});
await t('lock: 고른 서울 차가 내 근처면 found', async () => { const r = await W.handleVehicle(SEL({ lock: { vehicleno: '서울70사1', routeKey: 'S_100100075' } }), env); assert.strictEqual(r.lock.found, true); assert.ok(r.lock.dist < 100); });
await t('서울 호출 한도(headerCd 5)면 5분 쉰다 — 그 사이 상위 호출 없음, 앱엔 ok:true·match 없음', async () => {
  reset(); SEOUL_FAIL = 5;
  const r1 = await W.handleVehicle(SEL(), env); assert.strictEqual(r1.ok, true); assert.ok(!r1.match);
  const n0 = calls.length; const r2 = await W.handleVehicle(SEL(), env);
  assert.strictEqual(calls.length, n0, '쉬는 중에는 호출 없음'); assert.ok(!r2.match);
  assert.ok(W.MEM.seoulRestUntil > Date.now());
});
await t('SEOUL_POS=0 이면 서울 호출을 하지 않는다', async () => { reset(); const n0 = calls.length; const r = await W.handleVehicle(SEL(), { BUSAPI, SEOUL_POS: '0' }); assert.ok(!r.match); assert.strictEqual(calls.length, n0); });
await t('서울에 그 번호 노선이 없으면 unsupported', async () => { reset(); SEOUL_ROUTES = []; const r = await W.handleVehicle(SEL(), env); assert.strictEqual(r.unsupported, 1); assert.strictEqual(r.n, 0); });

console.log('[경기]');
reset();
await t('GGB 정류소: 그 정류소를 지나는 같은 번호 노선만 쓴다(92 수원 O, 92 안산 X, 92-1 X, 9200 X)', async () => {
  const r = await W.handleVehicle(GGB(), env);
  assert.strictEqual(r.ok, true); assert.strictEqual(r.n, 3); assert.ok(r.match.routeKey === 'G_200000100');
  assert.strictEqual(calls.filter((c) => c === 'getBusLocationListv2').length, 1, calls.join(','));
});
await t('정류소에 도착해 있는 차(stateCd 1)가 내 위치(그 정류소)와 일치하면 sure', async () => {
  const r = await W.handleVehicle(GGB(), env);
  assert.strictEqual(r.match.vehicleno, '경기70바1'); assert.strictEqual(r.match.conf, 'sure'); assert.strictEqual(r.match.src, 'gbis'); assert.strictEqual(r.match.nodeid, 'GGB204000003'); assert.strictEqual(r.match.nodeord, 3);
});
await t('정류소 좌표를 차량 좌표로 내보낸다(앱이 경로 위 위치를 맞춘다)', async () => { const r = await W.handleVehicle(GGB(), env); assert.ok(Math.abs(r.match.lng - mvE(1200)) < 1e-5 && r.match.lat === LAT); });
await t('두 번째 호출은 노선·정류소·위치 모두 캐시(상위 호출 늘지 않음)', async () => { const n0 = calls.length; await W.handleVehicle(GGB(), env); assert.strictEqual(calls.length, n0); });
await t('출발(stateCd 2) 차량은 그 정류소~다음 정류소 사이 어디든 — 구간 위 내 위치와 가까우면 고른다', async () => {
  reset(); GG_LOC['200000100'] = [{ plateNo: '경기70바1', stationSeq: 3, stationId: 204000003, stateCd: 2, vehId: 1 }, { plateNo: '경기70바2', stationSeq: 6, stationId: 204000006, stateCd: 1, vehId: 2 }];
  const r = await W.handleVehicle(GGB({ fix: { lat: LAT, lng: mvE(1200 + 250) } }), env);   // 내가 다음 정류소 쪽 250m 지점
  assert.strictEqual(r.match.vehicleno, '경기70바1'); assert.ok(r.match.dist < 20, String(r.match.dist)); assert.strictEqual(r.match.conf, 'sure');
});
await t('정류소 단위 위치는 더 보수적 — 같은 정류소 근처 차 두 대는 sure 아님', async () => {
  reset(); GG_LOC['200000100'] = [{ plateNo: '경기70바1', stationSeq: 3, stationId: 204000003, stateCd: 1, vehId: 1 }, { plateNo: '경기70바2', stationSeq: 4, stationId: 204000004, stateCd: 1, vehId: 2 }];
  const r = await W.handleVehicle(GGB({ fix: { lat: LAT, lng: mvE(1200 + 200) } }), env);   // 내 위치는 3번 정류소 200m 앞 — 4번 정류소까지 400m
  assert.notStrictEqual(r.match.conf, 'sure', JSON.stringify(r.match));
});
await t('lock: 최근 위치(fixes)를 함께 비교 — 자료가 늦어 차가 뒤처져 보여도 dist 가 작다', async () => {
  reset(); GG_LOC['200000100'] = [{ plateNo: '경기70바1', stationSeq: 3, stationId: 204000003, stateCd: 1, vehId: 1 }];
  const far = await W.handleVehicle(GGB({ fix: { lat: LAT, lng: mvE(1200 + 900) }, lock: { vehicleno: '경기70바1', routeKey: 'G_200000100' } }), env);
  assert.ok(far.lock.dist > 800, String(far.lock.dist));
  const near = await W.handleVehicle(GGB({ fix: { lat: LAT, lng: mvE(1200 + 900) }, fixes: [{ lat: LAT, lng: mvE(1200 + 100) }], lock: { vehicleno: '경기70바1', routeKey: 'G_200000100' } }), env);
  assert.ok(near.lock.dist < 150, String(near.lock.dist));
});
await t('TAGO 가 지원하는 경기 도시면 TAGO(좌표 정확)를 먼저 쓰고 GBIS 는 부르지 않는다', async () => {
  reset(); TAGO_STOPS = [{ citycode: 31010, nodeid: 'GGB204000003', nodenm: '가' }]; TAGO_ROUTES = [{ routeid: 'GGB200000100', routeno: 92 }];
  TAGO_VEH = [{ gpslati: LAT, gpslong: mvE(1210), nodeid: 'GGB204000003', nodenm: '정류소3', nodeord: 3, vehicleno: '경기70바1' }];
  const r = await W.handleVehicle(GGB(), env);
  assert.strictEqual(r.match.src, 'tago'); assert.ok(!calls.includes('getBusLocationListv2'), calls.join(','));
});
await t('TAGO 가 도시는 알지만 차량이 비어 있으면 GBIS 로 이어진다', async () => {
  reset(); TAGO_STOPS = [{ citycode: 31010, nodeid: 'GGB204000003', nodenm: '가' }]; TAGO_ROUTES = [{ routeid: 'GGB200000100', routeno: 92 }]; TAGO_VEH = [];
  const r = await W.handleVehicle(GGB(), env);
  assert.strictEqual(r.match.src, 'gbis');
});
await t('경기 API 가 실패해도 ok:true·match 없음(앱은 기존 방식)', async () => { reset(); GG_FAIL = true; const r = await W.handleVehicle(GGB(), env); assert.strictEqual(r.ok, true); assert.ok(!r.match); });
await t('경기에 그 정류소를 지나는 같은 번호 노선이 없으면 unsupported', async () => { reset(); GG_STATIONS['200000100'] = [{ stationSeq: 1, stationId: 1, stationName: 'x', x: LNG, y: LAT }]; const r = await W.handleVehicle(GGB(), env); assert.strictEqual(r.unsupported, 1); });

console.log('[섞인 후보]');
await t('후보가 서울·경기·인천 섞여도 각자 처리한다', async () => {
  reset(); TAGO_STOPS = []; 
  const r = await W.handleVehicle({ fix: { lat: LAT, lng: mvE(60) }, cands: [{ busNo: '472', boardStopId: 'SEL122000205', lat: LAT, lng: LNG }, { busNo: '92', boardStopId: 'GGB204000003', lat: LAT, lng: mvE(1200) }] }, env);
  assert.strictEqual(r.ok, true); assert.ok(r.n >= 6, String(r.n)); assert.ok(r.match);
});

console.log('\n' + pass + ' 통과 / ' + fail + ' 실패');
process.exit(fail ? 1 : 0);
