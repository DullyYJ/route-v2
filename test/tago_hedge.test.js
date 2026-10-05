// TAGO 도착정보 경로 경쟁(hedge) 단위 시험 — 모의 fetch/BUSAPI 사용, 네트워크 없음.  실행: node test/tago_hedge.test.js
const fs = require('fs'), assert = require('assert');
let src = fs.readFileSync(require('path').join(__dirname, '..', 'route-v2-worker.js'), 'utf8');
const ei = src.lastIndexOf('\nexport {'); assert.ok(ei > 0); src = src.slice(0, ei) + '\n';
const mk = (fetchImpl) => new Function('fetch', src + `
return { tagoFetch, tagoOrder, getPref: function(){ return TAGO_PREF; }, setPref: function(v){ TAGO_PREF = v; }, HEDGE: TAGO_HEDGE_MS };`)(fetchImpl);
const OKBODY = (no, t) => JSON.stringify({ response: { header: { resultCode: '00' }, body: { items: { item: [{ routeno: no, arrtime: t }] } } } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0; const t = async (name, fn) => { try { await fn(); pass++; console.log('  ok  ', name); } catch (e) { console.log('  FAIL', name, '\n      ', e.message); process.exitCode = 1; } };
const mkEnv = (busapi) => ({ TAGO_KEY: 'K1', BUSAPI: { fetch: busapi } });
(async () => {
  await t('직접 호출이 빠르면 직접 결과를 쓰고 선호 경로는 바뀌지 않는다', async () => {
    const api = mk(async () => ({ status: 200, text: async () => OKBODY('75', 300) }));
    const r = await api.tagoFetch(mkEnv(async () => { throw new Error('안 불려야 함'); }), 'a=1');
    assert.strictEqual(r.via, 'env-key'); assert.strictEqual(api.getPref().via, null);
  });
  await t('직접 호출이 멈추면(522 대기) 바인딩이 HEDGE 뒤 동시에 출발해 먼저 성공한다', async () => {
    const api = mk(() => new Promise(() => {}));   // 영원히 안 끝남
    const t0 = Date.now();
    const r = await api.tagoFetch(mkEnv(async () => ({ status: 200, text: async () => OKBODY('M6659', 500) })), 'a=1');
    const ms = Date.now() - t0;
    assert.strictEqual(r.via, 'binding'); assert.ok(ms < api.HEDGE + 400, 'ms=' + ms);
    assert.strictEqual(api.getPref().via, 'binding');
  });
  await t('직접 호출이 즉시 실패하면 기다리지 않고 바로 다음 경로', async () => {
    const api = mk(async () => ({ status: 522, text: async () => 'error code: 522' }));
    const t0 = Date.now();
    const r = await api.tagoFetch(mkEnv(async () => ({ status: 200, text: async () => OKBODY('1101', 100) })), 'a=1');
    assert.strictEqual(r.via, 'binding'); assert.ok(Date.now() - t0 < 300);
    assert.ok(r.tried.some((x) => /env-key/.test(x)));
  });
  await t('선호 경로가 있으면 그것을 먼저 부른다(바인딩 먼저)', async () => {
    const calls = [];
    const api = mk(async () => { calls.push('direct'); return { status: 200, text: async () => OKBODY('75', 1) }; });
    api.setPref({ via: 'binding', until: Date.now() + 60000 });
    const r = await api.tagoFetch(mkEnv(async () => { calls.push('binding'); return { status: 200, text: async () => OKBODY('75', 2) }; }), 'a=1');
    assert.strictEqual(r.via, 'binding'); assert.strictEqual(calls[0], 'binding');
  });
  await t('선호 경로(바인딩)로 연달아 성공해도 선호가 유지된다', async () => {
    const api = mk(async () => { throw new Error('직접은 막힘'); });
    api.setPref({ via: 'binding', until: Date.now() + 60000 });
    const env = mkEnv(async () => ({ status: 200, text: async () => OKBODY('75', 2) }));
    await api.tagoFetch(env, 'a=1'); await api.tagoFetch(env, 'a=1');
    assert.strictEqual(api.getPref().via, 'binding');
  });
  await t('선호 경로가 만료되면 원래 순서', async () => {
    const api = mk(async () => ({ status: 200, text: async () => OKBODY('75', 1) }));
    api.setPref({ via: 'binding', until: Date.now() - 1 });
    const r = await api.tagoFetch(mkEnv(async () => { throw new Error('x'); }), 'a=1');
    assert.strictEqual(r.via, 'env-key');
  });
  await t('모든 경로가 실패하면 사유를 모아 오류', async () => {
    const api = mk(async () => ({ status: 522, text: async () => 'error code: 522' }));
    let err = null; try { await api.tagoFetch(mkEnv(async () => ({ status: 500, text: async () => 'no' })), 'a=1'); } catch (e) { err = e; }
    assert.ok(err && /env-key/.test(err.message) && /binding/.test(err.message));
  });
  await t('선호 경로(바인딩)가 실패하면 직접 호출로 넘어가고 직접 성공 시 선호가 풀린다', async () => {
    const api = mk(async () => ({ status: 200, text: async () => OKBODY('75', 1) }));
    api.setPref({ via: 'binding', until: Date.now() + 60000 });
    const r = await api.tagoFetch(mkEnv(async () => ({ status: 500, text: async () => 'x' })), 'a=1');
    assert.strictEqual(r.via, 'env-key');
  });
  const mkEnv2 = (busapi) => ({ TAGO_KEY: 'K1', TAGO_KEY2: 'K2', BUSAPI: { fetch: busapi } });
  const keyOf = (u) => (/serviceKey=K2/.test(u) ? 'K2' : /serviceKey=K1/.test(u) ? 'K1' : '?');
  await t('키1 이 멈춰도(느려도) 키2 를 동시에 부르지 않고 다른 길(바인딩)만 부른다', async () => {
    const used = [];
    const api = mk((u) => { used.push(keyOf(String(u))); return new Promise(() => {}); });
    const r = await api.tagoFetch(mkEnv2(async () => { used.push('binding'); return { status: 200, text: async () => OKBODY('75', 5) }; }), 'a=1');
    assert.strictEqual(r.via, 'binding'); assert.deepStrictEqual(used, ['K1', 'binding']);
  });
  await t('키1 이 호출량 초과 응답 오류를 내면 그때만 순서대로 키2 를 쓴다', async () => {
    const used = [];
    const api = mk(async (u) => { const k = keyOf(String(u)); used.push(k); if (k === 'K1') return { status: 200, text: async () => JSON.stringify({ OpenAPI_ServiceResponse: { cmmMsgHeader: { errMsg: 'SERVICE ERROR', returnAuthMsg: 'LIMITED_NUMBER_OF_SERVICE_REQUESTS_EXCEEDS_ERROR' } } }) }; return { status: 200, text: async () => OKBODY('75', 7) }; });
    const r = await api.tagoFetch(mkEnv2(async () => { used.push('binding'); throw new Error('안 불려야 함'); }), 'a=1');
    assert.strictEqual(r.via, 'env-key2'); assert.deepStrictEqual(used, ['K1', 'K2']);
  });
  await t('키1 이 522 로 즉시 실패해도 키2 로 넘기지 않고 바인딩으로 간다', async () => {
    const used = [];
    const api = mk(async (u) => { used.push(keyOf(String(u))); return { status: 522, text: async () => 'error code: 522' }; });
    const r = await api.tagoFetch(mkEnv2(async () => { used.push('binding'); return { status: 200, text: async () => OKBODY('75', 9) }; }), 'a=1');
    assert.strictEqual(r.via, 'binding'); assert.deepStrictEqual(used, ['K1', 'binding']);
  });
  console.log(pass + '개 통과');
})();
