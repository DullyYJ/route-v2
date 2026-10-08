// board-writer 사용자 글 등록·신고·삭제 시험 — node:sqlite 로 D1 을 흉내 낸다.
// 실행: node board_writer_userposts.test.mjs [워커 경로]
import { DatabaseSync } from 'node:sqlite';
import assert from 'node:assert';
import path from 'node:path';
const file = path.resolve(process.argv[2] || '../board-writer/index.js');
globalThis.caches = { default: { _m: new Map(), async match(r){ return this._m.get(r.url) || undefined; }, async put(r, v){ this._m.set(r.url, v); }, async delete(r){ return this._m.delete(r.url); } } };
const db = new DatabaseSync(':memory:');
db.exec("CREATE TABLE posts (id INTEGER PRIMARY KEY AUTOINCREMENT, nick TEXT, title TEXT, body TEXT, cat TEXT, ts INTEGER, likes INTEGER, lols INTEGER, sads INTEGER)");
db.exec("CREATE TABLE comments (id INTEGER PRIMARY KEY AUTOINCREMENT, post_id INTEGER, nick TEXT, body TEXT, ts INTEGER)");
db.prepare("INSERT INTO posts (nick,title,body,cat,ts,likes,lols,sads) VALUES ('AI닉','AI 글 제목','AI 본문','정보',?,0,0,0)").run(Date.now() - 1000);
const norm = (a) => a.map((x) => (x === undefined ? null : x));
const DB = { prepare(sql) { let params = []; const st = db.prepare(sql.replace(/\?(\d+)/g, '?$1'));
  const o = { bind(...a) { params = norm(a); return o; },
    async run() { const r = st.run(...params); return { meta: { last_row_id: Number(r.lastInsertRowid), changes: r.changes } }; },
    async all() { return { results: st.all(...params) }; }, async first() { return st.get(...params) || null; } }; return o; } };
const env = { DB, ADMIN_TOKEN: 'adm' };
const w = (await import(file)).default;
const call = async (method, p, body, ip) => { const r = await w.fetch(new Request('https://bw.test' + p, { method, headers: { 'content-type': 'application/json', 'CF-Connecting-IP': ip || '1.1.1.1' }, body: body ? JSON.stringify(body) : undefined }), env, {}); let j = null; try { j = await r.json(); } catch (e) {} return { st: r.status, j }; };
let pass = 0, fail = 0;
const t = async (n, f) => { try { await f(); pass++; console.log('  ok  ', n); } catch (e) { fail++; console.log('  FAIL', n, '\n      ', e.message.split('\n')[0]); } };
const P = (o) => Object.assign({ nick: '테스터', title: '오늘 2호선 어때요', body: '신도림에서 사람이 많네요', cat: '잡담' }, o || {});

await t('정상 글 등록 → id 반환, GET /posts 에 user=1 로 내려온다', async () => {
  const r = await call('POST', '/post', P()); assert.strictEqual(r.st, 200, JSON.stringify(r)); assert.ok(r.j.ok && r.j.id > 1);
  const g = await call('GET', '/posts?limit=50'); const mine = g.j.posts.find((p) => p.id === r.j.id);
  assert.ok(mine && mine.user === 1 && mine.nick === '테스터' && mine.title === '오늘 2호선 어때요', JSON.stringify(g.j.posts));
  assert.ok(g.j.posts.find((p) => p.title === 'AI 글 제목'), 'AI 글도 그대로');
});
await t('등록하면 /posts 캐시가 비워져 바로 보인다(캐시된 뒤에 등록해도)', async () => {
  await call('GET', '/posts?limit=50'); const r = await call('POST', '/post', P({ title: '캐시 확인 글' }), '2.2.2.2');
  const g = await call('GET', '/posts?limit=50'); assert.ok(g.j.posts.some((p) => p.id === r.j.id));
});
await t('욕설은 거부(400)', async () => { const r = await call('POST', '/post', P({ title: '시발 뭐냐', body: 'x' }), '3.3.3.3'); assert.strictEqual(r.st, 400); });
await t('링크·전화번호 거부(400)', async () => {
  for (const body of ['여기 보세요 https://spam.example', 'www.abc.com 방문', 'naver.com/abc', '연락주세요 010-1234-5678', '01012345678 문자']) { const r = await call('POST', '/post', P({ title: '링크 ' + Math.random(), body }), '4.4.4.4'); assert.strictEqual(r.st, 400, body); }
});
await t('평범한 숫자·시각(2호선 5분 지연, 09:30, 3.5km)은 막지 않는다', async () => { const r = await call('POST', '/post', P({ title: '5분 지연 09:30 기준', body: '2호선 5분 지연, 3.5km 구간, 1,200원' }), '5.5.5.5'); assert.strictEqual(r.st, 200, JSON.stringify(r.j)); });
await t('제목/내용/아이디 누락 거부, 길이는 잘라서 저장', async () => {
  assert.strictEqual((await call('POST', '/post', P({ title: '' }), '6.6.6.6')).st, 400);
  assert.strictEqual((await call('POST', '/post', P({ body: '' }), '6.6.6.6')).st, 400);
  assert.strictEqual((await call('POST', '/post', P({ nick: '' }), '6.6.6.6')).st, 400);
  const r = await call('POST', '/post', P({ title: 'ㄱ'.repeat(200), body: 'ㅏ'.repeat(5000), nick: 'n'.repeat(50) }), '6.6.6.6');
  const row = db.prepare('SELECT * FROM posts WHERE id=?').get(r.j.id); assert.ok(row.title.length === 60 && row.body.length === 800 && row.nick.length === 16);
});
await t('허용되지 않은 카테고리(뉴스)는 잡담으로 저장 — 뉴스 칸을 사칭 못 한다', async () => {
  const r = await call('POST', '/post', P({ title: '뉴스 사칭', cat: '뉴스' }), '7.7.7.7'); assert.strictEqual(db.prepare('SELECT cat FROM posts WHERE id=?').get(r.j.id).cat, '잡담');
});
await t('같은 닉+제목은 하루 한 번만', async () => {
  const a = await call('POST', '/post', P({ title: '중복 확인' }), '8.8.8.8'); const b = await call('POST', '/post', P({ title: '중복 확인' }), '8.8.8.8');
  assert.strictEqual(a.st, 200); assert.strictEqual(b.st, 400);
});
await t('한 IP 는 한 시간에 5건까지, 6번째는 429', async () => {
  const res = []; for (let i = 0; i < 7; i++) res.push((await call('POST', '/post', P({ title: '도배 ' + i }), '9.9.9.9')).st);
  assert.deepStrictEqual(res, [200, 200, 200, 200, 200, 429, 429]);
});
await t('신고: 사용자 글이 아닌 AI 글은 신고 불가', async () => { assert.strictEqual((await call('POST', '/report', { post_id: 1 }, '10.0.0.1')).st, 400); });
await t('신고: 같은 IP 가 여러 번 해도 1건, 서로 다른 3곳이 하면 숨김', async () => {
  const r = await call('POST', '/post', P({ title: '신고 대상' }), '11.1.1.1'); const id = r.j.id;
  await call('POST', '/report', { post_id: id }, '12.0.0.1'); await call('POST', '/report', { post_id: id }, '12.0.0.1'); await call('POST', '/report', { post_id: id }, '12.0.0.1');
  let g = await call('GET', '/posts?limit=50'); assert.ok(g.j.posts.some((p) => p.id === id), '1곳 신고로는 안 숨김');
  await call('POST', '/report', { post_id: id }, '12.0.0.2'); const last = await call('POST', '/report', { post_id: id }, '12.0.0.3'); assert.strictEqual(last.j.hidden, true);
  g = await call('GET', '/posts?limit=50'); assert.ok(!g.j.posts.some((p) => p.id === id), '숨김');
});
await t('관리자: 토큰 없으면 401, 신고 목록 조회, 삭제(댓글 포함)', async () => {
  assert.strictEqual((await call('GET', '/post/delete?id=1')).st, 401); assert.strictEqual((await call('GET', '/reports')).st, 401);
  const rp = await call('GET', '/reports?token=adm'); assert.ok(rp.j.ok && rp.j.reports.length >= 1 && rp.j.reports[0].n >= 3);
  const r = await call('POST', '/post', P({ title: '삭제 대상' }), '13.1.1.1'); db.prepare("INSERT INTO comments (post_id,nick,body,ts) VALUES (?,?,?,?)").run(r.j.id, 'a', 'c', 1);
  const d = await call('GET', '/post/delete?id=' + r.j.id + '&token=adm'); assert.ok(d.j.ok);
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM posts WHERE id=?').get(r.j.id).n, 0); assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM comments WHERE post_id=?').get(r.j.id).n, 0);
});
await t('기존 /comment 는 사용자 글에도 그대로 동작', async () => {
  const r = await call('POST', '/post', P({ title: '댓글 받을 글' }), '14.1.1.1'); const c = await call('POST', '/comment', { post_id: r.j.id, nick: '남', body: '좋은 글' }); assert.ok(c.j.ok);
  const l = await call('GET', '/comments?post_id=' + r.j.id); assert.strictEqual(l.j.comments.length, 1);
});
await t('본인 삭제: 등록 때의 비밀키가 맞아야만 지워지고, owner 값은 /posts 로 노출되지 않는다', async () => {
  const key = 'k'.repeat(24); const r = await call('POST', '/post', P({ title: '내가 지울 글', owner_key: key }), '15.1.1.1');
  const g = await call('GET', '/posts?limit=50'); const mine = g.j.posts.find((p) => p.id === r.j.id); assert.ok(mine && !('owner' in mine), 'owner 노출');
  assert.strictEqual((await call('POST', '/post/mine-delete', { post_id: r.j.id, owner_key: 'x'.repeat(24) })).st, 403);
  assert.strictEqual((await call('POST', '/post/mine-delete', { post_id: r.j.id })).st, 400);
  const ok = await call('POST', '/post/mine-delete', { post_id: r.j.id, owner_key: key }); assert.ok(ok.j.ok && ok.j.deleted);
  assert.ok(!(await call('GET', '/posts?limit=50')).j.posts.some((p) => p.id === r.j.id));
  assert.strictEqual((await call('POST', '/post/mine-delete', { post_id: 1, owner_key: key })).j.deleted, false);   // AI 글(user=0)은 안 지워진다
});
await t('비밀키 없이 올린 글은 본인 삭제 불가(관리자만)', async () => {
  const r = await call('POST', '/post', P({ title: '키 없는 글' }), '16.1.1.1'); assert.strictEqual((await call('POST', '/post/mine-delete', { post_id: r.j.id, owner_key: 'z'.repeat(24) })).st, 403);
});
await t('컬럼이 이미 있어도(두 번째 호출) 오류 없이 동작하고 posts 에 user/hidden 이 한 번만 생긴다', async () => {
  const cols = db.prepare("SELECT name FROM pragma_table_info('posts')").all().map((r) => r.name); assert.strictEqual(cols.filter((c) => c === 'user').length, 1); assert.strictEqual(cols.filter((c) => c === 'hidden').length, 1); assert.strictEqual(cols.filter((c) => c === 'owner').length, 1);
});
console.log('\n' + pass + ' 통과 / ' + fail + ' 실패'); process.exit(fail ? 1 : 0);
