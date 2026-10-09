// 소통방 생성: flash-lite 가 429 여도 Gemma 로 이어지고, 깨진 문장(말줄임표 조각·이모지 범벅)은 저장·표시되지 않는다.
// 실행: node test/board_writer_gemma.test.mjs /절대경로/board-writer/index.js
import { DatabaseSync } from 'node:sqlite';
import assert from 'node:assert';
globalThis.caches = { default: { async match(){return undefined}, async put(){}, async delete(){return true} } };
const db = new DatabaseSync(':memory:');
db.exec("CREATE TABLE talks (id INTEGER PRIMARY KEY AUTOINCREMENT, nick TEXT, text TEXT, ts INTEGER)");
const mk = (sql) => { let stc=null; const S=()=>stc||(stc=db.prepare(sql)); let params=[];
  const o = { bind(...p){ params=p; return o; }, async run(){ const r=S().run(...params); return {meta:{last_row_id:r.lastInsertRowid}}; }, async all(){ return {results: S().all(...params)}; }, async first(){ return S().get(...params)||null; } }; return o; };
const DB = { prepare: mk, async batch(a){ for (const x of a) await x.run(); return []; } };
const realNow = Date.now.bind(Date);
const T0 = Date.UTC(2026, 9, 10, 5, 0);   // 2026-10-10 14:00 KST
Date.now = () => T0 + (realNow() % 1000);
const seen = { urls: [] }; 
globalThis.fetch = async (url, init) => {
  const u = String(url); seen.urls.push(u.replace(/key=.*/, ''));
  if (u.includes('open-meteo')) return new Response(JSON.stringify({ current: { temperature_2m: 18, weather_code: 0 } }), { status: 200 });
  if (u.includes('generativelanguage.googleapis.com/v1beta/models?')) return new Response(JSON.stringify({ models: [{ name: 'models/gemma-3-4b-it', supportedGenerationMethods: ['generateContent'] }, { name: 'models/embedding-001', supportedGenerationMethods: ['embedContent'] }] }), { status: 200 });
  if (u.includes(':generateContent')) {
    if (/gemini-/.test(u)) return new Response('{"error":{"code":429}}', { status: 429 });
    if (u.includes('gemma-3-27b-it')) {
      const bad = ['치맥… 🍗… 🤤', '…… 🙂 …'];
      const hang = '가나다라마바사아자차카타파하거너더러머버서어저처커터퍼허고노도로모보소오조초코토포호';
      const rs = (n) => { let o = ''; for (let k = 0; k < n; k++) o += hang[Math.floor(Math.random() * hang.length)]; return o; };
      const arr = []; for (let i = 0; i < 60; i++) arr.push({ n: '닉' + (i % 7), t: i % 6 === 3 ? bad[i % 2] : (rs(3) + ' ' + rs(4) + ' ' + rs(3) + ' ㅋㅋ'), d: 5 });
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '여기 있습니다:\n```json\n' + JSON.stringify(arr) + '\n```\n' }] } }] }), { status: 200 });
    }
    return new Response('{"error":{"code":404}}', { status: 404 });
  }
  throw new Error('blocked ' + u);
};
const mod = await import(process.argv[2]);
const w = mod.default;
const pend = []; const ctx = { waitUntil(p){ pend.push(p); } };
const env = { DB, GEMINI_KEY: 'test' };
await w.scheduled({}, env, ctx);
await Promise.all(pend);
const ai = db.prepare("SELECT text, ts FROM line_msgs WHERE ipk='ai'").all();
console.log('AI 행', ai.length, '예시', ai.slice(0, 3).map(r => r.text));
assert.ok(ai.length > 20, 'Gemma 로 소통방 글이 만들어진다(flash-lite 429): ' + ai.length);
assert.ok(!ai.some(r => (r.text.match(/…/g) || []).length >= 2), '깨진 말줄임표 문장은 저장되지 않는다');
assert.ok(!ai.some(r => /🍗|🤤|🙂/.test(r.text)), '이모지 범벅 문장은 저장되지 않는다');
assert.ok(seen.urls.some(u => u.includes('gemma-3-27b-it')), 'Gemma 호출');
const du = db.prepare("SELECT v FROM bw_diag WHERE k='gemuse'").all();
assert.ok(du.length >= 1 && /gemma-3-27b-it/.test(du[0].v), 'gemuse 기록: ' + JSON.stringify(du));
const dm = db.prepare("SELECT v FROM bw_diag WHERE k='gemmodels'").all();
assert.ok(dm.length >= 1, 'ListModels 기록');
// 읽기 단계: 예전에 저장된 깨진 AI 글은 가려지고, 이용자 글은 그대로
db.prepare("INSERT INTO line_msgs (line,kind,nick,text,stn,ipk,ts) VALUES ('2호선','chat','x','치맥… 🍗… 🤤',NULL,'ai',?)").run(T0 - 5000);
db.prepare("INSERT INTO line_msgs (line,kind,nick,text,stn,ipk,ts) VALUES ('2호선','chat','y','잠깐… 기다려… 보자',NULL,'userhash',?)").run(T0 - 4000);
db.prepare("INSERT INTO line_msgs (line,kind,nick,text,stn,ipk,ts) VALUES ('2호선','chat','z','정상 문장입니다',NULL,'ai',?)").run(T0 - 3000);
const r = await w.fetch(new Request('https://x.dev/lroom?line=' + encodeURIComponent('2호선')), env, ctx);
const j = await r.json();
const texts = j.msgs.map(m => m.text);
assert.ok(!texts.includes('치맥… 🍗… 🤤'), 'AI 깨진 글 숨김');
assert.ok(texts.includes('잠깐… 기다려… 보자'), '이용자 글은 유지');
assert.ok(texts.includes('정상 문장입니다'), '정상 글 유지');
const r2 = await w.fetch(new Request('https://x.dev/talks'), env, ctx);
const j2 = await r2.json();
assert.ok(!j2.talks.some(t => t.text === '치맥… 🍗… 🤤'), '/talks 도 숨김');
console.log('gemma test ok');
