// 실시간 도착 조회: 동시 호출 상한 + 직전 성공값 보관 단위 시험 — 모의 fetch/caches, 네트워크 없음.  실행: node test/live_stale.test.js
const fs = require('fs'), assert = require('assert');
let src = fs.readFileSync(require('path').join(__dirname, '..', 'route-v2-worker.js'), 'utf8');
const ei = src.lastIndexOf('\nexport {'); assert.ok(ei > 0); src = src.slice(0, ei) + '\n';
const mk = (fetchImpl, cachesImpl) => new Function('fetch', 'caches', src + `
return { fetchStopArrivals, LIVE_CONC, LIVE_STALE_MS, LIVE_MAX_CALLS, resetBrk: function(){ LIVE_BRK.n = 0; LIVE_BRK.until = 0; _liveStaleSaved.clear(); }, setCtx: function(c){ _liveCtx = c; }, running: function(){ return _liveRun; } };`)(fetchImpl, cachesImpl);
const BODY = (items) => JSON.stringify({ response: { header: { resultCode: '00' }, body: { items: { item: items } } } });
const mkCaches = () => { const store = new Map(); return { store, default: {
  put: async (req, res) => { store.set(req.url, await res.text()); },
  match: async (req) => { const v = store.get(req.url); return v ? new Response(v) : undefined; } } }; };
const env = { TAGO_KEY: 'K1' };
const ok = (items) => async () => ({ status: 200, text: async () => BODY(items) });
let pass = 0; const t = async (name, fn) => { try { await fn(); pass++; console.log('  ok  ', name); } catch (e) { console.log('  FAIL', name, '\n      ', e.message); process.exitCode = 1; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  await t('성공하면 직전 성공값이 보관된다(캐시에 한 건)', async () => {
    const c = mkCaches(); const a = mk(ok([{ routeno: 'M6659', arrtime: 400 }]), c);
    const m = await a.fetchStopArrivals('23', 'ICB1', env, Date.now() + 4000, null);
    assert.deepStrictEqual(m['M6659'], [400]); await sleep(20); assert.strictEqual(c.store.size, 1);
  });
  await t('호출이 실패하면 4분 안의 보관값을 지난 시간만큼 빼서 쓴다', async () => {
    const c = mkCaches(); const a = mk(async () => ({ status: 522, text: async () => 'error code: 522' }), c);
    const key = 'https://live-cache.invalid/' + encodeURIComponent('23|ICB1');
    c.store.set(key, JSON.stringify({ at: Date.now() - 60000, m: { M6659: [400, 900], __names: ['M6659'] } }));
    const m = await a.fetchStopArrivals('23', 'ICB1', env, Date.now() + 4000, null);
    assert.deepStrictEqual(m['M6659'], [340, 840]); assert.ok(/^stale-/.test(m.__via));
  });
  await t('지난 시간보다 가까웠던 차는 목록에서 빠진다', async () => {
    const c = mkCaches(); const a = mk(async () => ({ status: 522, text: async () => 'x' }), c);
    c.store.set('https://live-cache.invalid/' + encodeURIComponent('23|ICB1'), JSON.stringify({ at: Date.now() - 100000, m: { '75': [50, 500], __names: ['75'] } }));
    const m = await a.fetchStopArrivals('23', 'ICB1', env, Date.now() + 4000, null);
    assert.deepStrictEqual(m['75'], [400]);
  });
  await t('4분을 넘은 보관값은 쓰지 않는다(오류 그대로)', async () => {
    const c = mkCaches(); const a = mk(async () => ({ status: 522, text: async () => 'x' }), c);
    c.store.set('https://live-cache.invalid/' + encodeURIComponent('23|ICB1'), JSON.stringify({ at: Date.now() - 241000, m: { '75': [500], __names: ['75'] } }));
    let err = null; try { await a.fetchStopArrivals('23', 'ICB1', env, Date.now() + 4000, null); } catch (e) { err = e; }
    assert.ok(err);
  });
  await t('요청당 호출 상한에 걸린 경우는 보관값을 쓰지 않는다', async () => {
    const c = mkCaches(); const a = mk(ok([{ routeno: '75', arrtime: 1 }]), c);
    c.store.set('https://live-cache.invalid/' + encodeURIComponent('23|ICB1'), JSON.stringify({ at: Date.now() - 1000, m: { '75': [500], __names: ['75'] } }));
    let err = null; try { await a.fetchStopArrivals('23', 'ICB1', env, Date.now() + 4000, { used: a.LIVE_MAX_CALLS }); } catch (e) { err = e; }
    assert.ok(err);
  });
  await t('서울(11)은 호출도 보관도 없이 건너뛴다', async () => {
    const c = mkCaches(); let calls = 0; const a = mk(async () => { calls++; return { status: 200, text: async () => BODY([]) }; }, c);
    const m = await a.fetchStopArrivals('11', 'SEL1', env, Date.now() + 4000, null);
    assert.strictEqual(calls, 0); assert.strictEqual(m.__via, 'skip-seoul'); assert.strictEqual(c.store.size, 0);
  });
  await t('동시에 진행되는 TAGO 호출은 LIVE_CONC 를 넘지 않고 모두 끝난다', async () => {
    const c = mkCaches(); let cur = 0, max = 0;
    const a = mk(async () => { cur++; max = Math.max(max, cur); await sleep(40); cur--; return { status: 200, text: async () => BODY([{ routeno: '75', arrtime: 100 }]) }; }, c);
    const ps = Array.from({ length: 14 }, (_, i) => a.fetchStopArrivals('23', 'ICB' + i, env, Date.now() + 4500, null));
    const r = await Promise.all(ps);
    assert.ok(max <= a.LIVE_CONC, 'max=' + max); assert.strictEqual(r.length, 14); assert.strictEqual(a.running(), 0);
  });
  await t('줄이 너무 길어 마감이 닥치면 기다리던 호출은 포기한다(오류), 실행 카운터는 새지 않는다', async () => {
    const c = mkCaches();
    const a = mk(() => new Promise(() => {}), c);   // 영원히 안 끝남
    const dl = Date.now() + 700;
    const ps = Array.from({ length: 9 }, (_, i) => a.fetchStopArrivals('23', 'ICB' + i, env, dl, null).then(() => 'ok', (e) => String(e.message)));
    const r = await Promise.all(ps);
    assert.ok(r.every((x) => x !== 'ok'));
    assert.ok(r.some((x) => x === 'live-queue' || x === 'timeout'));
    await sleep(50);
  });
  console.log(pass + '개 통과');
})();
