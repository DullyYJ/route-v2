// gildongmu-ride — "내가 타고 있는 차량"을 찾아 따라가는 작은 워커 (2026-10-11)
//
// 원칙: 경로·시각·정류장 판단은 엔진이 하고 앱은 그리기만 한다. 이 워커는 그 '엔진' 쪽에서 실시간 버스 위치를 맡는다.
//   · 앱이 보낸 후보 버스 노선(번호 + 승차 정류장 id)과 내 최근 위치를 받아서
//   · TAGO 버스위치(BusLcInfoInqireService/getRouteAcctoBusLcList)로 그 노선들의 모든 차량 위치를 읽고
//   · 내 위치에 가장 가까운 차량을 '내 차'로 고른다(번호판 vehicleno). 다음부터 앱은 번호판을 같이 보내 그 차를 따라간다.
//   · 확신이 없으면(두 차가 붙어 있거나 멀면) 고르지 않는다 — 앱은 그러면 지금처럼 GPS 만 쓴다.
// 이 워커가 꺼지거나 틀려도 앱 기존 동작(GPS·PF)이 그대로 돈다: 앱은 이 응답을 '추가 증거'로만 쓴다.
//
// 키: TAGO_KEY(선택, 시크릿) 와/또는 서비스 바인딩 BUSAPI(gildongmu-bus). 둘 중 하나는 있어야 한다.
//   Cloudflare→apis.data.go.kr 직접 호출이 간헐적으로 522 로 막히므로(엔진과 같은 문제) 직접 호출이 800ms 안에 안 끝나면 바인딩을 같이 부른다.
// 호출량: 노선 차량 목록은 노선별로 10초, 정류장→도시코드는 24시간, 노선번호→노선id 는 6시간 isolate 메모리에 둔다. 같은 요청은 합친다.
'use strict';

const VER = 'ride-2026-10-11b';
const TAGO = 'https://apis.data.go.kr/1613000';
const SEOUL = 'http://ws.bus.go.kr/api/rest';                 // 서울 TOPIS (같은 공공데이터포털 키, BUSAPI 바인딩이 키를 넣는다)
const GBIS = 'https://apis.data.go.kr/6410000';               // 경기도 버스 v2 (버스위치·노선정류소)
const SEOUL_REST_MS = 5 * 60e3;                               // 서울 호출 한도(하루 1만 건)에 걸리면 5분 쉰다
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS', 'access-control-allow-headers': 'content-type', 'cache-control': 'no-store' };
const VEH_TTL_MS = 10000, ROUTE_TTL_MS = 6 * 3600e3, CITY_TTL_MS = 24 * 3600e3, HEDGE_MS = 800, FETCH_TIMEOUT_MS = 6000;

// ── 순수 함수(시험용) ─────────────────────────────────────────
function hav(aLat, aLng, bLat, bLng) {
  const R = 6371000, r = Math.PI / 180;
  const dLat = (bLat - aLat) * r, dLng = (bLng - aLng) * r;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * r) * Math.cos(bLat * r) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}
const num = (v) => { const x = typeof v === 'string' ? parseFloat(v) : v; return typeof x === 'number' && isFinite(x) ? x : null; };
const inKorea = (lat, lng) => lat != null && lng != null && lat > 32 && lat < 39.5 && lng > 124 && lng < 132;
// 노선 번호 표기 통일: "9(강화)" 와 9 는 다른 노선이므로 괄호는 남기고 공백만 정리
const normNo = (s) => String(s == null ? '' : s).replace(/\s+/g, '').toUpperCase();

// TAGO 차량 한 건 → { vehicleno, lat, lng, nodeord, nodenm, nodeid }  (좌표가 없으면 null)
function normVehicle(it) {
  if (!it) return null;
  const lat = num(it.gpslati), lng = num(it.gpslong);
  if (!inKorea(lat, lng)) return null;
  const no = String(it.vehicleno == null ? '' : it.vehicleno).trim();
  if (!no) return null;
  return { vehicleno: no, lat, lng, nodeord: num(it.nodeord), nodenm: it.nodenm || '', nodeid: it.nodeid || '' };
}

// 점 → 선분 거리(m). 가까운 거리에서는 평면 근사로 충분하다.
function distSegM(pLat, pLng, aLat, aLng, bLat, bLng) {
  const ky = 111320, kx = 111320 * Math.cos(pLat * Math.PI / 180);
  const ax = (aLng - pLng) * kx, ay = (aLat - pLat) * ky, bx = (bLng - pLng) * kx, by = (bLat - pLat) * ky;
  const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
  const t = L2 > 0 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / L2)) : 0;
  return Math.hypot(ax + t * dx, ay + t * dy);
}
// 차량과 내 점 사이 거리: 좌표를 정확히 아는 차량은 점 거리, 정류소 단위로만 아는 차량(경기: pts = 있을 만한 구간)은 구간까지의 거리
function vehDist(v, f) {
  if (v.pts && v.pts.length) {
    if (v.pts.length === 1) return hav(f.lat, f.lng, v.pts[0].lat, v.pts[0].lng);
    let d = Infinity;
    for (let i = 0; i < v.pts.length - 1; i++) d = Math.min(d, distSegM(f.lat, f.lng, v.pts[i].lat, v.pts[i].lng, v.pts[i + 1].lat, v.pts[i + 1].lng));
    return d;
  }
  return hav(f.lat, f.lng, v.lat, v.lng);
}

// 내 위치(fix)에서 가장 가까운 차량을 고른다.
//   vehicles: [{ routeKey, busNo, vehicleno, lat, lng, ... }]
//   반환: { best, second, conf }  conf = 'sure' | 'likely' | 'weak' | 'none'
//   sure   : 200m 안이고, 다음 차량이 120m 이상 더 멀거나 2배 이상 멀다
//   likely : 350m 안이고, 다음 차량이 80m 이상 더 멀다
//   weak   : 그 밖(앱은 쓰지 않는다)
//   정류소 단위로만 위치를 아는 차량(coarse, 경기)은 더 보수적으로: 300m/350m 간격, 500m/300m 간격
function pickVehicle(vehicles, fix, opts) {
  const base = Object.assign({ sureM: 200, sureGap: 120, sureRatio: 2, likelyM: 350, likelyGap: 80 }, opts || {});
  if (!vehicles || !vehicles.length || !fix) return { best: null, second: null, conf: 'none' };
  // fix 는 한 점이거나 점 배열(지금·10초 전·20초 전…) — 버스 위치 자료는 수십 초 늦으므로 가장 가까운 점과의 거리를 쓴다
  const fixes = Array.isArray(fix) ? fix : [fix];
  const arr = vehicles.map((v) => Object.assign({}, v, { dist: Math.min.apply(null, fixes.map((f) => vehDist(v, f))) })).sort((a, b) => a.dist - b.dist);
  const best = arr[0], second = arr[1] || null;
  const o = (best.coarse && !(opts && opts.noCoarse)) ? Object.assign({}, base, { sureM: 300, sureGap: 350, sureRatio: 2.5, likelyM: 500, likelyGap: 300 }) : base;
  let conf = 'weak';
  const gap = second ? second.dist - best.dist : Infinity;
  if (best.dist <= o.sureM && (gap >= o.sureGap || (second && second.dist >= o.sureRatio * best.dist))) conf = 'sure';
  else if (best.dist <= o.likelyM && gap >= o.likelyGap) conf = 'likely';
  return { best, second, conf };
}

// ── 네트워크 ────────────────────────────────────────────────
const MEM = { veh: new Map(), route: new Map(), city: new Map(), stn: new Map(), inflight: new Map(), seoulRestUntil: 0 };
const now = () => Date.now();
function cacheGet(m, k) { const e = m.get(k); if (e && e.exp > now()) return e.v; if (e) m.delete(k); return undefined; }
function cachePut(m, k, v, ttl) { if (m.size > 2000) m.clear(); m.set(k, { v, exp: now() + ttl }); }
function joined(key, fn) {   // 같은 요청이 동시에 여러 번 와도 상위 호출은 한 번
  const f = MEM.inflight.get(key); if (f) return f;
  const p = fn().finally(() => MEM.inflight.delete(key));
  MEM.inflight.set(key, p); return p;
}
function parseTago(txt) {
  let j; try { j = JSON.parse(txt); } catch (e) { return { ok: false, why: 'json' }; }
  if (j && j.OpenAPI_ServiceResponse) return { ok: false, why: 'auth' };
  const body = j && j.response && j.response.body;
  if (!body) return { ok: false, why: 'nobody' };
  let items = body.items;
  items = items && items.item ? (Array.isArray(items.item) ? items.item : [items.item]) : [];
  return { ok: true, items };
}
async function withTimeout(p, ms) {
  let t; const to = new Promise((_, rej) => { t = setTimeout(() => rej(new Error('timeout')), ms); });
  try { return await Promise.race([p, to]); } finally { clearTimeout(t); }
}
// 응답 해석기: 각각 { ok:true, items } 또는 { ok:false, why }
function parseGbis(txt, listKey) {
  let j; try { j = JSON.parse(txt); } catch (e) { return { ok: false, why: 'json' }; }
  if (j && j.OpenAPI_ServiceResponse) return { ok: false, why: 'auth' };
  const r = j && j.response; if (!r) return { ok: false, why: 'nobody' };
  const code = r.msgHeader && r.msgHeader.resultCode;
  if (code != null && Number(code) !== 0) return Number(code) === 4 ? { ok: true, items: [] } : { ok: false, why: 'gbis' + code };   // 4 = 결과 없음
  const l = r.msgBody && r.msgBody[listKey];
  return { ok: true, items: l ? (Array.isArray(l) ? l : [l]) : [] };
}
const XML_TAG = /<([A-Za-z0-9_]+)>([^<]*)<\/\1>/g;
function parseSeoul(txt) {
  if (typeof txt !== 'string' || txt.indexOf('<') < 0) return { ok: false, why: 'xml' };
  const cd = /<headerCd>\s*(\d+)\s*<\/headerCd>/.exec(txt);
  if (!cd) return { ok: false, why: /LIMIT|EXCEED/i.test(txt) ? 'seoul-limit' : 'xml' };
  const code = Number(cd[1]);
  if (code !== 0 && code !== 4) { const msg = (/<headerMsg>([^<]*)<\/headerMsg>/.exec(txt) || [])[1] || ''; return { ok: false, why: (code === 5 || /LIMIT|EXCEED/i.test(msg)) ? 'seoul-limit' : 'seoul' + code }; }
  const items = []; const re = /<itemList>([\s\S]*?)<\/itemList>/g; let m;
  while ((m = re.exec(txt))) { const o = {}; let t; XML_TAG.lastIndex = 0; while ((t = XML_TAG.exec(m[1]))) o[t[1]] = t[2].trim(); items.push(o); }
  return { ok: true, items };
}
// 바깥 호출. inner 는 쿼리까지 붙은 원본 URL. 직접(키, apis.data.go.kr 만) → 800ms 안에 안 끝나면 바인딩도 같이 → 먼저 성공한 쪽.
//   bindingOnly: 서울(ws.bus.go.kr)은 바인딩(gildongmu-bus)이 키를 넣어 준다.
async function callRoads(env, inner, parse, bindingOnly) {
  const roads = [];
  const key = !bindingOnly && env && (env.TAGO_KEY || env.DATA_GO_KR_KEY);
  const key2 = !bindingOnly && env && env.TAGO_KEY2;
  if (key) roads.push(() => fetch(inner + '&serviceKey=' + encodeURIComponent(key)));
  if (env && env.BUSAPI && typeof env.BUSAPI.fetch === 'function') roads.push(() => env.BUSAPI.fetch(new Request('https://busapi.internal/tago?url=' + encodeURIComponent(bindingOnly ? inner : inner + '&serviceKey='))));
  if (key2 && key2 !== key) roads.push(() => fetch(inner + '&serviceKey=' + encodeURIComponent(key2)));
  if (!roads.length) throw new Error('no key');
  return await new Promise((resolve, reject) => {
    let done = false, fin = 0, started = 0, timer = null; const errs = [];
    const launch = (i) => {
      if (done || i >= roads.length || started > i) return; started = i + 1;
      withTimeout(roads[i]().then(async (r) => { const t = await r.text(); const p = parse(t); if (!p.ok) throw new Error(p.why + ' ' + r.status); return p.items; }), FETCH_TIMEOUT_MS)
        .then((items) => { if (!done) { done = true; clearTimeout(timer); resolve(items); } })
        .catch((e) => { errs.push(String(e && e.message || e)); fin++; if (!done) { if (started < roads.length) launch(started); else if (fin >= roads.length) { done = true; clearTimeout(timer); reject(new Error(errs.join(' | '))); } } });
    };
    launch(0);
    if (roads.length > 1) timer = setTimeout(() => launch(started), HEDGE_MS);
  });
}
async function tago(env, svc, op, params) {
  const qs = new URLSearchParams(Object.assign({ _type: 'json', numOfRows: '100', pageNo: '1' }, params)).toString();
  return callRoads(env, TAGO + '/' + svc + '/' + op + '?' + qs, parseTago, false);
}
async function gbis(env, svc, op, params, listKey) {
  const qs = new URLSearchParams(Object.assign({ format: 'json' }, params)).toString();
  return callRoads(env, GBIS + '/' + svc + '/' + op + '?' + qs, (t) => parseGbis(t, listKey), false);
}
async function seoul(env, svc, op, params) {
  if (now() < MEM.seoulRestUntil) throw new Error('seoul-rest');
  if (env && env.SEOUL_POS === '0') throw new Error('seoul-off');
  const qs = new URLSearchParams(params).toString();
  try { return await callRoads(env, SEOUL + '/' + svc + '/' + op + '?' + qs, parseSeoul, true); }
  catch (e) { if (/seoul-limit/.test(String(e && e.message))) MEM.seoulRestUntil = now() + SEOUL_REST_MS; throw e; }
}

// 승차 정류장 id → 도시코드 (좌표 근처 정류장 목록에서 같은 nodeid 를 찾는다)
async function cityOf(env, boardStopId, lat, lng) {
  const k = String(boardStopId);
  const c = cacheGet(MEM.city, k); if (c !== undefined) return c;
  return joined('city|' + k, async () => {
    const items = await tago(env, 'BusSttnInfoInqireService', 'getCrdntPrxmtSttnList', { gpsLati: String(lat), gpsLong: String(lng), numOfRows: '30' });
    const hit = items.find((it) => String(it.nodeid) === k);
    const cc = hit && hit.citycode != null ? String(hit.citycode) : null;
    cachePut(MEM.city, k, cc, cc ? CITY_TTL_MS : 600e3);
    return cc;
  });
}
// 도시코드 + 노선번호 → 노선id 목록 (번호가 정확히 같은 것만)
async function routesOf(env, cc, busNo) {
  const k = cc + '|' + normNo(busNo);
  const c = cacheGet(MEM.route, k); if (c !== undefined) return c;
  return joined('route|' + k, async () => {
    const base = String(busNo).replace(/\(.*\)/, '');
    const items = await tago(env, 'BusRouteInfoInqireService', 'getRouteNoList', { cityCode: cc, routeNo: base, numOfRows: '100' });
    const want = normNo(busNo);
    let list = items.filter((it) => normNo(it.routeno) === want);
    if (!list.length) list = items.filter((it) => normNo(String(it.routeno).replace(/\(.*\)/, '')) === normNo(base));
    const out = list.map((it) => ({ routeId: String(it.routeid), routeno: String(it.routeno) }));
    cachePut(MEM.route, k, out, out.length ? ROUTE_TTL_MS : 300e3);
    return out;
  });
}
async function vehiclesOf(env, cc, routeId) {
  const k = cc + '|' + routeId;
  const c = cacheGet(MEM.veh, k); if (c !== undefined) return c;
  return joined('veh|' + k, async () => {
    const items = await tago(env, 'BusLcInfoInqireService', 'getRouteAcctoBusLcList', { cityCode: cc, routeId: routeId, numOfRows: '200' });
    const out = items.map(normVehicle).filter(Boolean);
    cachePut(MEM.veh, k, { list: out, at: now() }, VEH_TTL_MS);
    return { list: out, at: now() };
  });
}

// ── 서울(TOPIS) · 경기(GBIS) 버스 위치 ──────────────────────────
// 서울: busRouteInfo/getBusRouteList(번호→노선id) + buspos/getBusPosByRtid(차량 좌표, 번호판 plainNo). 좌표를 알아서 TAGO 와 같게 쓴다.
// 경기: busrouteservice/v2/getBusRouteListv2(번호→노선id) + getBusRouteStationListv2(정류소 좌표) + buslocationservice/v2/getBusLocationListv2.
//   경기 차량 위치는 좌표 없이 '지금 있는 정류소 순번(stationSeq)'과 상태(0 교차로 통과·1 도착·2 출발)뿐이라, 그 정류소의 좌표를 차량 위치로 쓰고
//   '있을 만한 구간'(pts)까지의 거리로 비교한다(coarse — 고르는 기준을 더 보수적으로).
const kstMs = (s14) => { const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(String(s14 || '')); return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4] - 9, +m[5], +m[6]) : null; };
function normSeoulVehicle(it, at) {
  if (!it || String(it.isrunyn) === '0') return null;
  const lat = num(it.gpsY), lng = num(it.gpsX);
  if (!inKorea(lat, lng)) return null;
  const no = String(it.plainNo == null ? '' : it.plainNo).trim() || (it.vehId ? 'S' + it.vehId : '');
  if (!no) return null;
  const dm = kstMs(it.dataTm);
  const lag = dm != null ? Math.max(0, Math.min(180000, at - dm)) : 0;
  return { vehicleno: no, lat, lng, nodeord: num(it.sectOrd), nodenm: '', nodeid: it.lastStnId ? 'SEL' + it.lastStnId : '', lagMs: lag, src: 'seoul' };
}
function normGbisVehicle(it, stations) {
  if (!it) return null;
  const seq = num(it.stationSeq); if (seq == null) return null;
  const i = stations.findIndex((x) => x.seq === seq); if (i < 0) return null;
  const st = stations[i], nx = stations[i + 1] || null, pv = stations[i - 1] || null;
  const state = num(it.stateCd);
  // 1 도착: 그 정류소 · 2 출발: 그 정류소~다음 · 0(교차로 통과·그 밖): 앞뒤 정류소 사이 어디든
  let pts;
  if (state === 1) pts = [st];
  else if (state === 2) pts = nx ? [st, nx] : [st];
  else pts = [pv || st, st, nx || st].filter((x, k, a) => k === 0 || x !== a[k - 1]);
  const no = String(it.plateNo == null ? '' : it.plateNo).trim() || (it.vehId ? 'G' + it.vehId : '');
  if (!no) return null;
  return { vehicleno: no, lat: st.lat, lng: st.lng, pts: pts.map((x) => ({ lat: x.lat, lng: x.lng })), coarse: true, nodeord: seq, nodenm: st.name, nodeid: 'GGB' + st.id, src: 'gbis' };
}
async function seoulRoutesOf(env, busNo) {
  const k = 'S|' + normNo(busNo);
  const c = cacheGet(MEM.route, k); if (c !== undefined) return c;
  return joined('route|' + k, async () => {
    const base = String(busNo).replace(/\(.*\)/, '');
    const items = await seoul(env, 'busRouteInfo', 'getBusRouteList', { strSrch: base });
    const want = normNo(busNo), wb = normNo(base);
    const out = items.filter((it) => { const n = normNo(it.busRouteNm || it.busRouteAbrv); return n === want || n === wb; }).map((it) => ({ routeId: String(it.busRouteId), routeno: String(it.busRouteNm) })).slice(0, 6);
    cachePut(MEM.route, k, out, out.length ? ROUTE_TTL_MS : 300e3);
    return out;
  });
}
async function seoulVehiclesOf(env, routeId) {
  const k = 'S|' + routeId;
  const c = cacheGet(MEM.veh, k); if (c !== undefined) return c;
  return joined('veh|' + k, async () => {
    const items = await seoul(env, 'buspos', 'getBusPosByRtid', { busRouteId: routeId });
    const at = now();
    const v = { list: items.map((it) => normSeoulVehicle(it, at)).filter(Boolean), at };
    cachePut(MEM.veh, k, v, VEH_TTL_MS);
    return v;
  });
}
async function gbisStationsOf(env, routeId) {
  const k = 'G|' + routeId;
  const c = cacheGet(MEM.stn, k); if (c !== undefined) return c;
  return joined('stn|' + k, async () => {
    const items = await gbis(env, 'busrouteservice/v2', 'getBusRouteStationListv2', { routeId }, 'busRouteStationList');
    const out = items.map((it) => ({ seq: num(it.stationSeq), id: String(it.stationId), lat: num(it.y), lng: num(it.x), name: String(it.stationName || '') })).filter((x) => x.seq != null && inKorea(x.lat, x.lng)).sort((a, b) => a.seq - b.seq);
    cachePut(MEM.stn, k, out, out.length ? CITY_TTL_MS : 300e3);
    return out;
  });
}
// 번호 + 승차 정류소(9자리) → 그 정류소를 지나는 경기 노선 [{ routeId, stations }]
async function gbisRoutesOf(env, busNo, stationId) {
  const k = 'G|' + normNo(busNo) + '|' + stationId;
  const c = cacheGet(MEM.route, k); if (c !== undefined) return c;
  return joined('route|' + k, async () => {
    const base = String(busNo).replace(/\(.*\)/, '');
    const items = await gbis(env, 'busrouteservice/v2', 'getBusRouteListv2', { keyword: base }, 'busRouteList');
    const want = normNo(busNo), wb = normNo(base);
    const cand = items.filter((it) => { const n = normNo(it.routeName); return n === want || n === wb; }).slice(0, 8);
    const out = [];
    await Promise.all(cand.map(async (it) => {
      const stations = await gbisStationsOf(env, String(it.routeId));
      if (stations.some((x) => x.id === String(stationId))) out.push({ routeId: String(it.routeId), stations });
    }));
    cachePut(MEM.route, k, out, out.length ? ROUTE_TTL_MS : 300e3);
    return out;
  });
}
async function gbisVehiclesOf(env, routeId, stations) {
  const k = 'G|' + routeId;
  const c = cacheGet(MEM.veh, k); if (c !== undefined) return c;
  return joined('veh|' + k, async () => {
    const items = await gbis(env, 'buslocationservice/v2', 'getBusLocationListv2', { routeId }, 'busLocationList');
    const v = { list: items.map((it) => normGbisVehicle(it, stations)).filter(Boolean), at: now() };
    cachePut(MEM.veh, k, v, VEH_TTL_MS);
    return v;
  });
}

// ── 요청 처리 ───────────────────────────────────────────────
// 후보 한 건의 차량들을 all 에 담는다. 반환: 담은 차량 수.
//   · 인천·그 밖 TAGO 도시: TAGO. 서울(SEL+9자리): 서울 TOPIS. 경기(GGB+9자리): TAGO 도시면 TAGO(좌표 정확), 아니면(또는 비면) GBIS.
async function candVehicles(env, cd, ci, all, dbg) {
  const busNo = String(cd.busNo || ''); const sid = String(cd.boardStopId || '');
  const lat = num(cd.lat), lng = num(cd.lng);
  if (!busNo || !sid || !inKorea(lat, lng)) { dbg.push(ci + ':입력'); return 0; }
  const mS = /^SEL([0-9]{9})$/.exec(sid), mG = /^GGB([0-9]{9})$/.exec(sid);
  let n = 0;
  if (!mS) {
    try {
      const cc = await cityOf(env, sid, lat, lng);
      if (!cc) dbg.push(ci + ':도시없음');
      else {
        const rs = await routesOf(env, cc, busNo);
        if (!rs.length) dbg.push(ci + ':노선없음');
        await Promise.all(rs.map(async (r) => {
          const v = await vehiclesOf(env, cc, r.routeId);
          for (const x of v.list) { all.push(Object.assign({ routeKey: cc + '_' + r.routeId, busNo, cand: ci, ageMs: now() - v.at, src: 'tago' }, x)); n++; }
        }));
      }
    } catch (e) { dbg.push(ci + ':' + String(e && e.message || e).slice(0, 60)); }
  }
  if (n) return n;
  try {
    if (mS) {
      const rs = await seoulRoutesOf(env, busNo);
      if (!rs.length) { dbg.push(ci + ':서울노선없음'); return 0; }
      await Promise.all(rs.map(async (r) => {
        const v = await seoulVehiclesOf(env, r.routeId);
        for (const x of v.list) { all.push(Object.assign({}, x, { routeKey: 'S_' + r.routeId, busNo, cand: ci, ageMs: now() - v.at + (x.lagMs || 0) })); n++; }
      }));
    } else if (mG) {
      const rs = await gbisRoutesOf(env, busNo, mG[1]);
      if (!rs.length) { dbg.push(ci + ':경기노선없음'); return 0; }
      await Promise.all(rs.map(async (r) => {
        const v = await gbisVehiclesOf(env, r.routeId, r.stations);
        for (const x of v.list) { all.push(Object.assign({}, x, { routeKey: 'G_' + r.routeId, busNo, cand: ci, ageMs: now() - v.at })); n++; }
      }));
    }
  } catch (e) { dbg.push(ci + ':' + String(e && e.message || e).slice(0, 60)); }
  return n;
}

// body: { fix:{lat,lng}, fixes?:[{lat,lng}…최근 점], cands:[{busNo, boardStopId, lat, lng}], lock?:{routeKey, vehicleno} }
async function handleVehicle(body, env) {
  const fix = body && body.fix;
  const fl = num(fix && fix.lat), fg = num(fix && fix.lng);
  if (!inKorea(fl, fg)) return { ok: false, error: 'fix' };
  const cands = Array.isArray(body.cands) ? body.cands.slice(0, 5) : [];
  if (!cands.length) return { ok: false, error: 'cands' };
  const dbg = [];
  const all = [];
  let unsupported = 0;
  await Promise.all(cands.map(async (cd, ci) => { const n = await candVehicles(env, cd, ci, all, dbg); if (!n && dbg.some((d) => d.indexOf(ci + ':') === 0 && /도시없음|노선없음/.test(d))) unsupported++; }));
  const out = { ok: true, ver: VER, now: now(), n: all.length, unsupported, dbg: dbg.length ? dbg : undefined };
  // 최근 위치들(앱이 보낸 10~30초 전 점)도 함께 비교한다 — 차량 위치 자료가 늦는 만큼 보정
  const fixes = [{ lat: fl, lng: fg }];
  for (const f of (Array.isArray(body.fixes) ? body.fixes.slice(0, 4) : [])) { const a = num(f && f.lat), b = num(f && f.lng); if (inKorea(a, b)) fixes.push({ lat: a, lng: b }); }
  // 이미 고른 차량이 있으면 그 차가 아직 내 근처인지 확인한다
  const lk = body.lock;
  if (lk && lk.vehicleno) {
    const hit = all.find((v) => v.vehicleno === lk.vehicleno && (!lk.routeKey || v.routeKey === lk.routeKey));
    out.lock = hit ? { found: true, dist: Math.round(Math.min.apply(null, (hit.coarse ? fixes : [fixes[0]]).map((f) => vehDist(hit, f)))), vehicleno: hit.vehicleno, routeKey: hit.routeKey, busNo: hit.busNo, cand: hit.cand, lat: hit.lat, lng: hit.lng, nodeord: hit.nodeord, nodenm: hit.nodenm, nodeid: hit.nodeid, ageMs: hit.ageMs, src: hit.src }
                    : { found: false };
  }
  const pk = pickVehicle(all, fixes);
  if (pk.best) {
    const b = pk.best;
    out.match = { conf: pk.conf, dist: Math.round(b.dist), second: pk.second ? Math.round(pk.second.dist) : null, vehicleno: b.vehicleno, routeKey: b.routeKey, busNo: b.busNo, cand: b.cand, lat: b.lat, lng: b.lng, nodeord: b.nodeord, nodenm: b.nodenm, nodeid: b.nodeid, ageMs: b.ageMs, src: b.src };
  }
  return out;
}

async function handle(request, env) {
  const url = new URL(request.url);
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  const J = (o, st) => new Response(JSON.stringify(o), { status: st || 200, headers: Object.assign({ 'content-type': 'application/json; charset=utf-8' }, CORS) });
  if (url.pathname === '/' || url.pathname === '/health' || url.pathname === '/ver') {
    return J({ ok: true, ver: VER, keys: { direct: !!(env && (env.TAGO_KEY || env.DATA_GO_KR_KEY)), binding: !!(env && env.BUSAPI) }, cache: { veh: MEM.veh.size, route: MEM.route.size, city: MEM.city.size, stn: MEM.stn.size }, seoulRest: MEM.seoulRestUntil > now() });
  }
  if (url.pathname === '/vehicle') {
    let body = null;
    try {
      if (request.method === 'POST') body = await request.json();
      else body = JSON.parse(url.searchParams.get('q') || 'null');
    } catch (e) { return J({ ok: false, error: 'json' }, 400); }
    if (!body) return J({ ok: false, error: 'body' }, 400);
    try { return J(await handleVehicle(body, env)); } catch (e) { return J({ ok: false, error: String(e && e.message || e).slice(0, 120) }, 200); }
  }
  return J({ ok: false, error: 'not found' }, 404);
}

export default { fetch: (request, env, ctx) => handle(request, env, ctx) };
export { hav, normNo, normVehicle, pickVehicle, vehDist, parseSeoul, parseGbis, normSeoulVehicle, normGbisVehicle, handleVehicle, handle, MEM, VER };
