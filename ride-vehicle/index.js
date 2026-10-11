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

const VER = 'ride-2026-10-11a';
const TAGO = 'https://apis.data.go.kr/1613000';
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

// 내 위치(fix)에서 가장 가까운 차량을 고른다.
//   vehicles: [{ routeKey, busNo, vehicleno, lat, lng, ... }]
//   반환: { best, second, conf }  conf = 'sure' | 'likely' | 'weak' | 'none'
//   sure   : 200m 안이고, 다음 차량이 120m 이상 더 멀거나 2배 이상 멀다
//   likely : 350m 안이고, 다음 차량이 80m 이상 더 멀다
//   weak   : 그 밖(앱은 쓰지 않는다)
function pickVehicle(vehicles, fix, opts) {
  const o = Object.assign({ sureM: 200, sureGap: 120, sureRatio: 2, likelyM: 350, likelyGap: 80 }, opts || {});
  if (!vehicles || !vehicles.length || !fix) return { best: null, second: null, conf: 'none' };
  // fix 는 한 점이거나 점 배열(지금·10초 전·20초 전…) — 버스 위치 자료는 수십 초 늦으므로 가장 가까운 점과의 거리를 쓴다
  const fixes = Array.isArray(fix) ? fix : [fix];
  const arr = vehicles.map((v) => Object.assign({}, v, { dist: Math.min.apply(null, fixes.map((f) => hav(f.lat, f.lng, v.lat, v.lng))) })).sort((a, b) => a.dist - b.dist);
  const best = arr[0], second = arr[1] || null;
  let conf = 'weak';
  const gap = second ? second.dist - best.dist : Infinity;
  if (best.dist <= o.sureM && (gap >= o.sureGap || (second && second.dist >= o.sureRatio * best.dist))) conf = 'sure';
  else if (best.dist <= o.likelyM && gap >= o.likelyGap) conf = 'likely';
  return { best, second, conf };
}

// ── 네트워크 ────────────────────────────────────────────────
const MEM = { veh: new Map(), route: new Map(), city: new Map(), inflight: new Map() };
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
// op 호출. 직접(키) → 800ms 안에 안 끝나면 바인딩도 같이 → 먼저 성공한 쪽.
async function tago(env, svc, op, params) {
  const qs = new URLSearchParams(Object.assign({ _type: 'json', numOfRows: '100', pageNo: '1' }, params)).toString();
  const inner = TAGO + '/' + svc + '/' + op + '?' + qs;
  const roads = [];
  const key = env && (env.TAGO_KEY || env.DATA_GO_KR_KEY);
  const key2 = env && env.TAGO_KEY2;
  if (key) roads.push(() => fetch(inner + '&serviceKey=' + encodeURIComponent(key)));
  if (env && env.BUSAPI && typeof env.BUSAPI.fetch === 'function') roads.push(() => env.BUSAPI.fetch(new Request('https://busapi.internal/tago?url=' + encodeURIComponent(inner + '&serviceKey='))));
  if (key2 && key2 !== key) roads.push(() => fetch(inner + '&serviceKey=' + encodeURIComponent(key2)));
  if (!roads.length) throw new Error('no key');
  return await new Promise((resolve, reject) => {
    let done = false, fin = 0, started = 0, timer = null; const errs = [];
    const launch = (i) => {
      if (done || i >= roads.length || started > i) return; started = i + 1;
      withTimeout(roads[i]().then(async (r) => { const t = await r.text(); const p = parseTago(t); if (!p.ok) throw new Error(p.why + ' ' + r.status); return p.items; }), FETCH_TIMEOUT_MS)
        .then((items) => { if (!done) { done = true; clearTimeout(timer); resolve(items); } })
        .catch((e) => { errs.push(String(e && e.message || e)); fin++; if (!done) { if (started < roads.length) launch(started); else if (fin >= roads.length) { done = true; clearTimeout(timer); reject(new Error(errs.join(' | '))); } } });
    };
    launch(0);
    if (roads.length > 1) timer = setTimeout(() => launch(started), HEDGE_MS);
  });
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

// ── 요청 처리 ───────────────────────────────────────────────
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
  await Promise.all(cands.map(async (cd, ci) => {
    try {
      const busNo = String(cd.busNo || ''); const sid = String(cd.boardStopId || '');
      const lat = num(cd.lat), lng = num(cd.lng);
      if (!busNo || !sid || !inKorea(lat, lng)) { dbg.push(ci + ':입력'); return; }
      const cc = await cityOf(env, sid, lat, lng);
      if (!cc) { unsupported++; dbg.push(ci + ':도시없음'); return; }
      const rs = await routesOf(env, cc, busNo);
      if (!rs.length) { unsupported++; dbg.push(ci + ':노선없음'); return; }
      await Promise.all(rs.map(async (r) => {
        const v = await vehiclesOf(env, cc, r.routeId);
        for (const x of v.list) all.push(Object.assign({ routeKey: cc + '_' + r.routeId, busNo, cand: ci, ageMs: now() - v.at }, x));
      }));
    } catch (e) { dbg.push(ci + ':' + String(e && e.message || e).slice(0, 60)); }
  }));
  const out = { ok: true, ver: VER, now: now(), n: all.length, unsupported, dbg: dbg.length ? dbg : undefined };
  // 이미 고른 차량이 있으면 그 차가 아직 내 근처인지 확인한다
  const lk = body.lock;
  if (lk && lk.vehicleno) {
    const hit = all.find((v) => v.vehicleno === lk.vehicleno && (!lk.routeKey || v.routeKey === lk.routeKey));
    out.lock = hit ? { found: true, dist: Math.round(hav(fl, fg, hit.lat, hit.lng)), vehicleno: hit.vehicleno, routeKey: hit.routeKey, busNo: hit.busNo, cand: hit.cand, lat: hit.lat, lng: hit.lng, nodeord: hit.nodeord, nodenm: hit.nodenm, nodeid: hit.nodeid, ageMs: hit.ageMs }
                    : { found: false };
  }
  // 최근 위치들(앱이 보낸 10~30초 전 점)도 함께 비교한다 — 차량 위치 자료가 늦는 만큼 보정
  const fixes = [{ lat: fl, lng: fg }];
  for (const f of (Array.isArray(body.fixes) ? body.fixes.slice(0, 4) : [])) { const a = num(f && f.lat), b = num(f && f.lng); if (inKorea(a, b)) fixes.push({ lat: a, lng: b }); }
  const pk = pickVehicle(all, fixes);
  if (pk.best) {
    const b = pk.best;
    out.match = { conf: pk.conf, dist: Math.round(b.dist), second: pk.second ? Math.round(pk.second.dist) : null, vehicleno: b.vehicleno, routeKey: b.routeKey, busNo: b.busNo, cand: b.cand, lat: b.lat, lng: b.lng, nodeord: b.nodeord, nodenm: b.nodenm, nodeid: b.nodeid, ageMs: b.ageMs };
  }
  return out;
}

async function handle(request, env) {
  const url = new URL(request.url);
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  const J = (o, st) => new Response(JSON.stringify(o), { status: st || 200, headers: Object.assign({ 'content-type': 'application/json; charset=utf-8' }, CORS) });
  if (url.pathname === '/' || url.pathname === '/health' || url.pathname === '/ver') {
    return J({ ok: true, ver: VER, keys: { direct: !!(env && (env.TAGO_KEY || env.DATA_GO_KR_KEY)), binding: !!(env && env.BUSAPI) }, cache: { veh: MEM.veh.size, route: MEM.route.size, city: MEM.city.size } });
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
export { hav, normNo, normVehicle, pickVehicle, handleVehicle, handle, MEM, VER };
