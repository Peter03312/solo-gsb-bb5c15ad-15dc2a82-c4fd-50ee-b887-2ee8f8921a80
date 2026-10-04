'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { initDb } = require('../src/db');
const { createApp } = require('../src/routes');

let db;
let server;
let base;

before(async () => {
  db = initDb(':memory:');
  const app = createApp(db);
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

async function api(path, method = 'GET', body) {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json, headers: res.headers };
}

const GOOD_WORDS = [
  { text: '你好', start_ms: 0, end_ms: 500 },
  { text: '世界', start_ms: 550, end_ms: 1000 },
  { text: '欢迎', start_ms: 1500, end_ms: 2000 },
  { text: '光临', start_ms: 2050, end_ms: 2500 },
];

const SIX_WORDS = [
  { text: '一', start_ms: 0, end_ms: 400 },
  { text: '二', start_ms: 450, end_ms: 800 },
  { text: '三', start_ms: 850, end_ms: 1200 },
  { text: '四', start_ms: 1250, end_ms: 1600 },
  { text: '五', start_ms: 1650, end_ms: 2000 },
  { text: '六', start_ms: 2050, end_ms: 2400 },
];

/** 建项目 + 排版，返回 { pid, cues, sub_version, attr_version } */
async function setupProject(words = GOOD_WORDS, cuts = [1200]) {
  const created = await api('/api/projects', 'POST', { name: '说话人测试', words, cuts });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const pid = created.body.id;
  assert.equal(created.body.attr_version, 0);
  const layout = await api(`/api/projects/${pid}/layout`, 'POST', { sub_version: 0 });
  assert.equal(layout.status, 200, JSON.stringify(layout.body));
  return { pid, cues: layout.body.subtitles, sub_version: layout.body.sub_version };
}

/** 建两个说话人 S1=张三 / S2=李四，返回当前 attr_version（=2） */
async function addSpeakers(pid) {
  const r1 = await api(`/api/projects/${pid}/speakers`, 'POST', { code: 'S1', name: '张三' });
  assert.equal(r1.status, 201, JSON.stringify(r1.body));
  const r2 = await api(`/api/projects/${pid}/speakers`, 'POST', { code: 'S2', name: '李四' });
  assert.equal(r2.status, 201, JSON.stringify(r2.body));
  return r2.body.attr_version;
}

/** 隔行标注 S1/S2 */
async function attributeAll(pid, cues, attrVersion) {
  return api(`/api/projects/${pid}/attributions`, 'POST', {
    attr_version: attrVersion,
    items: cues.map((c, i) => ({
      subtitle_id: c.id, cue_version: c.version, speaker: i % 2 === 0 ? 'S1' : 'S2',
    })),
  });
}

/** 从快照正文提取全部时间轴行（开始 --> 结束） */
function timelineOf(content) {
  return [...content.matchAll(/^(\d{2}:\d{2}:\d{2}\.\d{3}) --> (\d{2}:\d{2}:\d{2}\.\d{3})$/gm)]
    .map((m) => `${m[1]} --> ${m[2]}`);
}

// ---------- 说话人管理 ----------

test('说话人：创建推进归属版本；编号/显示名校验；重复编号 409', async () => {
  const { pid } = await setupProject();

  const badCode = await api(`/api/projects/${pid}/speakers`, 'POST', { code: '张 三', name: '张三' });
  assert.equal(badCode.status, 400);
  const emptyName = await api(`/api/projects/${pid}/speakers`, 'POST', { code: 'S1', name: '  ' });
  assert.equal(emptyName.status, 400);
  const newlineName = await api(`/api/projects/${pid}/speakers`, 'POST', { code: 'S1', name: '张\n三' });
  assert.equal(newlineName.status, 400);
  assert.ok(newlineName.body.errors.some((e) => e.includes('换行')));
  const tagName = await api(`/api/projects/${pid}/speakers`, 'POST', { code: 'S1', name: '张<v>三' });
  assert.equal(tagName.status, 400);
  assert.ok(tagName.body.errors.some((e) => e.includes('标签界定符')));
  const gtName = await api(`/api/projects/${pid}/speakers`, 'POST', { code: 'S1', name: '张三>' });
  assert.equal(gtName.status, 400);

  const ok = await api(`/api/projects/${pid}/speakers`, 'POST', { code: 'S1', name: '张三' });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.attr_version, 1);
  assert.deepEqual(ok.body.speaker, { code: 'S1', name: '张三' });

  const dup = await api(`/api/projects/${pid}/speakers`, 'POST', { code: 'S1', name: '别人' });
  assert.equal(dup.status, 409);
  assert.ok(dup.body.error.includes('已存在'));

  const list = await api(`/api/projects/${pid}/speakers`);
  assert.equal(list.body.attr_version, 1);
  assert.deepEqual(list.body.speakers.map((s) => s.code), ['S1']);
});

test('说话人：改名推进归属版本；携带过期归属版本 409；名字不变不推进；未知编号 404', async () => {
  const { pid } = await setupProject();
  await addSpeakers(pid); // attr_version = 2

  const renamed = await api(`/api/projects/${pid}/speakers/S1`, 'PATCH', { name: '张三丰', attr_version: 2 });
  assert.equal(renamed.status, 200, JSON.stringify(renamed.body));
  assert.equal(renamed.body.attr_version, 3);
  assert.equal(renamed.body.speaker.name, '张三丰');

  const stale = await api(`/api/projects/${pid}/speakers/S1`, 'PATCH', { name: '张四', attr_version: 2 });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.current.attr_version, 3);

  const same = await api(`/api/projects/${pid}/speakers/S1`, 'PATCH', { name: '张三丰' });
  assert.equal(same.status, 200);
  assert.equal(same.body.unchanged, true);
  assert.equal(same.body.attr_version, 3, '名字不变不推进归属版本');

  const badName = await api(`/api/projects/${pid}/speakers/S1`, 'PATCH', { name: '张>三' });
  assert.equal(badName.status, 400);

  const missing = await api(`/api/projects/${pid}/speakers/NOPE`, 'PATCH', { name: '某人' });
  assert.equal(missing.status, 404);
});

// ---------- 归属提交 ----------

test('归属：锁定行也可标注；视图逐行状态；改标覆盖', async () => {
  const { pid, cues } = await setupProject();
  const attrVersion = await addSpeakers(pid); // 2

  // 锁定第一行（行版本 +1 → v2）
  const locked = await api(`/api/projects/${pid}/subtitles/${cues[0].id}`, 'PATCH', { version: 1, locked: true });
  assert.equal(locked.status, 200);
  assert.equal(locked.body.subtitle.locked, 1);
  assert.equal(locked.body.subtitle.version, 2);

  // 锁定行也可标注：携带锁定后的行版本
  const r = await api(`/api/projects/${pid}/attributions`, 'POST', {
    attr_version: attrVersion,
    items: [
      { subtitle_id: cues[0].id, cue_version: 2, speaker: 'S1' },
      { subtitle_id: cues[1].id, cue_version: 1, speaker: 'S2' },
    ],
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.attr_version, 3);
  assert.deepEqual(r.body.applied.map((a) => a.action), ['created', 'created']);
  assert.deepEqual(r.body.counts, { cues: 2, attributed: 2, missing: 0 });

  const view = await api(`/api/projects/${pid}/attributions`);
  assert.equal(view.body.attr_version, 3);
  assert.equal(view.body.speakers.length, 2);
  assert.deepEqual(view.body.entries.map((e) => e.state), ['attributed', 'attributed']);
  assert.equal(view.body.entries[0].attribution.speaker, 'S1');
  assert.equal(view.body.entries[0].attribution.speaker_name, '张三');
  assert.equal(view.body.entries[0].attribution.cue_version_snapshot, 2);
  assert.equal(view.body.history.length, 0);

  // 改标：第一行改给 S2（携带最新行版本与归属版本）
  const re = await api(`/api/projects/${pid}/attributions`, 'POST', {
    attr_version: 3,
    items: [{ subtitle_id: cues[0].id, cue_version: 2, speaker: 'S2' }],
  });
  assert.equal(re.status, 200);
  assert.equal(re.body.applied[0].action, 'updated');
  const view2 = await api(`/api/projects/${pid}/attributions`);
  assert.equal(view2.body.entries[0].attribution.speaker, 'S2');
});

test('归属：形状/编号/字幕非法 → 400；归属版本或行版本过期 → 409 带当前值', async () => {
  const { pid, cues } = await setupProject();
  const attrVersion = await addSpeakers(pid); // 2

  const empty = await api(`/api/projects/${pid}/attributions`, 'POST', { attr_version: 2, items: [] });
  assert.equal(empty.status, 400);
  const noAttrVersion = await api(`/api/projects/${pid}/attributions`, 'POST', {
    items: [{ subtitle_id: cues[0].id, cue_version: 1, speaker: 'S1' }],
  });
  assert.equal(noAttrVersion.status, 400);
  const dup = await api(`/api/projects/${pid}/attributions`, 'POST', {
    attr_version: 2,
    items: [
      { subtitle_id: cues[0].id, cue_version: 1, speaker: 'S1' },
      { subtitle_id: cues[0].id, cue_version: 1, speaker: 'S2' },
    ],
  });
  assert.equal(dup.status, 400);
  assert.ok(dup.body.errors.some((e) => e.includes('重复')));

  const unknownSpeaker = await api(`/api/projects/${pid}/attributions`, 'POST', {
    attr_version: 2,
    items: [{ subtitle_id: cues[0].id, cue_version: 1, speaker: 'GHOST' }],
  });
  assert.equal(unknownSpeaker.status, 400);
  assert.ok(unknownSpeaker.body.errors[0].includes('GHOST'));

  const unknownCue = await api(`/api/projects/${pid}/attributions`, 'POST', {
    attr_version: 2,
    items: [{ subtitle_id: 99999, cue_version: 1, speaker: 'S1' }],
  });
  assert.equal(unknownCue.status, 400);
  assert.ok(unknownCue.body.errors[0].includes('不存在'));

  // 归属版本过期 → 409 带当前值
  const staleAttr = await api(`/api/projects/${pid}/attributions`, 'POST', {
    attr_version: 99,
    items: [{ subtitle_id: cues[0].id, cue_version: 1, speaker: 'S1' }],
  });
  assert.equal(staleAttr.status, 409);
  assert.equal(staleAttr.body.attr_version_stale, true);
  assert.equal(staleAttr.body.current.attr_version, attrVersion);
  assert.ok(staleAttr.body.current.subtitles.length === 2);

  // 行版本过期 → 409 逐行原因（先成功标注一次使归属版本推进到 3）
  const ok = await attributeAll(pid, cues, attrVersion);
  assert.equal(ok.status, 200);
  const staleCue = await api(`/api/projects/${pid}/attributions`, 'POST', {
    attr_version: 3,
    items: [{ subtitle_id: cues[0].id, cue_version: 99, speaker: 'S2' }],
  });
  assert.equal(staleCue.status, 409);
  assert.equal(staleCue.body.items.length, 1);
  assert.equal(staleCue.body.items[0].state, 'cue_version_stale');
  assert.equal(staleCue.body.items[0].cue.version, 1);
  // 整批不生效：归属未被改动
  const view = await api(`/api/projects/${pid}/attributions`);
  assert.equal(view.body.entries[0].attribution.speaker, 'S1');
});

// ---------- 重排 / 导入联动 ----------

test('联动：重排保留 ID 的归属继续有效且归属版本不变', async () => {
  const { pid, cues, sub_version } = await setupProject();
  const attrVersion = await addSpeakers(pid);
  const ok = await attributeAll(pid, cues, attrVersion);
  assert.equal(ok.status, 200);
  const before = await api(`/api/projects/${pid}/attributions`);

  // 改规则（最短时长 800→900，分段不变）后重排：词区间与内容一致 → 全部保留 ID
  await api(`/api/projects/${pid}/rules`, 'PUT', {
    version: 1, max_chars: 30, min_duration_ms: 900, max_cps: 20,
  });
  const relayout = await api(`/api/projects/${pid}/layout`, 'POST', { sub_version });
  assert.equal(relayout.status, 200, JSON.stringify(relayout.body));
  assert.deepEqual(relayout.body.subtitles.map((c) => c.id), cues.map((c) => c.id));

  const afterView = await api(`/api/projects/${pid}/attributions`);
  assert.deepEqual(afterView.body.entries.map((e) => e.state), ['attributed', 'attributed']);
  assert.equal(afterView.body.attr_version, before.body.attr_version, '无归属转历史则归属版本不变');
  assert.equal(afterView.body.history.length, 0);
});

test('联动：重排删除原行 → 归属留作历史并推进归属版本；新行待标注，不按展示序号转移', async () => {
  // 6 词默认规则排成 1 行；收紧 max_chars=3 后重排为 2 行（原行删除，新行新 ID）
  const { pid, cues, sub_version } = await setupProject(SIX_WORDS, []);
  assert.equal(cues.length, 1);
  const attrVersion = await addSpeakers(pid);
  const ok = await api(`/api/projects/${pid}/attributions`, 'POST', {
    attr_version: attrVersion,
    items: [{ subtitle_id: cues[0].id, cue_version: 1, speaker: 'S1' }],
  });
  assert.equal(ok.status, 200);

  await api(`/api/projects/${pid}/rules`, 'PUT', {
    version: 1, max_chars: 3, min_duration_ms: 800, max_cps: 20,
  });
  const relayout = await api(`/api/projects/${pid}/layout`, 'POST', { sub_version });
  assert.equal(relayout.status, 200, JSON.stringify(relayout.body));
  assert.equal(relayout.body.subtitles.length, 2);
  assert.notDeepEqual(relayout.body.subtitles.map((c) => c.id), [cues[0].id]);

  const view = await api(`/api/projects/${pid}/attributions`);
  assert.deepEqual(view.body.entries.map((e) => e.state), ['missing', 'missing'], '新行待标注，不按展示序号转移');
  assert.equal(view.body.history.length, 1);
  assert.equal(view.body.history[0].speaker, 'S1');
  assert.equal(view.body.history[0].subtitle_id, null);
  assert.ok(view.body.attr_version > ok.body.attr_version, '归属转历史推进归属版本');
});

test('联动：重新导入清空字幕 → 全部归属留作历史', async () => {
  const { pid, cues } = await setupProject();
  const attrVersion = await addSpeakers(pid);
  await attributeAll(pid, cues, attrVersion);

  const reimport = await api(`/api/projects/${pid}/import`, 'POST', {
    words: GOOD_WORDS, cuts: [1200], force: true,
  });
  assert.equal(reimport.status, 200);
  const view = await api(`/api/projects/${pid}/attributions`);
  assert.equal(view.body.history.length, 2);
  assert.equal(view.body.counts.attributed, 0);
  assert.ok(view.body.attr_version > 3);
});

// ---------- 署名版导出（原文） ----------

test('署名导出：缺归属 → 422 逐行；字幕集/归属版本漂移 → 409；成功后生成不可变快照', async () => {
  const { pid, cues, sub_version } = await setupProject();
  const attrVersion = await addSpeakers(pid); // 2

  // 只标注一行 → 导出 422 指出另一行缺归属
  await api(`/api/projects/${pid}/attributions`, 'POST', {
    attr_version: attrVersion,
    items: [{ subtitle_id: cues[0].id, cue_version: 1, speaker: 'S1' }],
  });
  const missing = await api(`/api/projects/${pid}/attributed-exports`, 'POST', {
    sub_version, attr_version: 3,
  });
  assert.equal(missing.status, 422);
  assert.equal(missing.body.missing_attribution.length, 1);
  assert.equal(missing.body.missing_attribution[0].subtitle_id, cues[1].id);
  assert.equal((await api(`/api/projects/${pid}/attributed-exports`)).body.length, 0);

  // 补齐第二行
  await api(`/api/projects/${pid}/attributions`, 'POST', {
    attr_version: 3,
    items: [{ subtitle_id: cues[1].id, cue_version: 1, speaker: 'S2' }],
  });

  // 版本漂移 → 409
  const staleSub = await api(`/api/projects/${pid}/attributed-exports`, 'POST', {
    sub_version: 99, attr_version: 4,
  });
  assert.equal(staleSub.status, 409);
  assert.equal(staleSub.body.sub_version_stale, true);
  const staleAttr = await api(`/api/projects/${pid}/attributed-exports`, 'POST', {
    sub_version, attr_version: 1,
  });
  assert.equal(staleAttr.status, 409);
  assert.equal(staleAttr.body.attr_version_stale, true);
  assert.equal(staleAttr.body.current.attr_version, 4);

  // 成功导出原文署名版
  const ok = await api(`/api/projects/${pid}/attributed-exports`, 'POST', {
    sub_version, attr_version: 4,
  });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.equal(ok.body.version, 1);
  assert.equal(ok.body.lang, null);
  assert.equal(ok.body.cue_count, 2);
  assert.equal(ok.body.sub_version, sub_version);
  assert.equal(ok.body.attr_version, 4);
  assert.ok(ok.body.content.startsWith('WEBVTT'));
  assert.ok(ok.body.content.includes('<v 张三>你好世界</v>'));
  assert.ok(ok.body.content.includes('<v 李四>欢迎光临</v>'));

  // 列表与下载（内容一致、不可变）
  const list = await api(`/api/projects/${pid}/attributed-exports`);
  assert.equal(list.body.length, 1);
  assert.equal(list.body[0].download_url, ok.body.download_url);
  const dl = await api(ok.body.download_url);
  assert.equal(dl.status, 200);
  assert.equal(dl.headers.get('content-type'), 'text/vtt; charset=utf-8');
  assert.equal(dl.body, ok.body.content);

  // 后续改标与改名不影响旧快照；再次导出取新版本
  await api(`/api/projects/${pid}/attributions`, 'POST', {
    attr_version: 4,
    items: [{ subtitle_id: cues[0].id, cue_version: 1, speaker: 'S2' }],
  });
  const again = await api(`/api/projects/${pid}/attributed-exports`, 'POST', {
    sub_version, attr_version: 5,
  });
  assert.equal(again.status, 201);
  assert.equal(again.body.version, 2);
  assert.ok(again.body.content.includes('<v 李四>你好世界</v>'));
  const oldDl = await api(ok.body.download_url);
  assert.ok(oldDl.body.includes('<v 张三>你好世界</v>'), '旧快照内容不变');
  assert.equal((await api(`/api/projects/${pid}/attributed-exports`)).body.length, 2);
});

test('署名导出：显示名含换行/界定符的存量数据 → 422 invalid_speakers 防御', async () => {
  const { pid, cues, sub_version } = await setupProject();
  const attrVersion = await addSpeakers(pid);
  await attributeAll(pid, cues, attrVersion);

  // 模拟绕过 API 校验的存量非法显示名（API 本身拒绝此类名字）
  db.prepare("UPDATE speakers SET name = '张>三' WHERE project_id = ? AND code = 'S1'").run(pid);
  const r = await api(`/api/projects/${pid}/attributed-exports`, 'POST', {
    sub_version, attr_version: 3,
  });
  assert.equal(r.status, 422);
  assert.equal(r.body.invalid_speakers.length, 1);
  assert.equal(r.body.invalid_speakers[0].code, 'S1');
  assert.ok(r.body.invalid_speakers[0].reasons.some((e) => e.includes('标签界定符')));
  assert.equal((await api(`/api/projects/${pid}/attributed-exports`)).body.length, 0);
});

test('署名导出：形状非法 → 400；无字幕 → 422', async () => {
  const { pid, cues } = await setupProject();
  const attrVersion = await addSpeakers(pid);
  await attributeAll(pid, cues, attrVersion);

  const noSub = await api(`/api/projects/${pid}/attributed-exports`, 'POST', { attr_version: 3 });
  assert.equal(noSub.status, 400);
  const noAttr = await api(`/api/projects/${pid}/attributed-exports`, 'POST', { sub_version: 1 });
  assert.equal(noAttr.status, 400);
  const badLang = await api(`/api/projects/${pid}/attributed-exports`, 'POST', {
    sub_version: 1, attr_version: 3, lang: 'bad lang',
  });
  assert.equal(badLang.status, 400);
  const transNoLang = await api(`/api/projects/${pid}/attributed-exports`, 'POST', {
    sub_version: 1, attr_version: 3,
    translations: [{ subtitle_id: cues[0].id, version: 1 }],
  });
  assert.equal(transNoLang.status, 400);
  assert.ok(transNoLang.body.errors.some((e) => e.includes('不得携带 translations')));
  const langNoTrans = await api(`/api/projects/${pid}/attributed-exports`, 'POST', {
    sub_version: 1, attr_version: 3, lang: 'en',
  });
  assert.equal(langNoTrans.status, 400);
  assert.ok(langNoTrans.body.errors.some((e) => e.includes('translations')));

  const empty = await api('/api/projects', 'POST', { name: '空项目' });
  const noCues = await api(`/api/projects/${empty.body.id}/attributed-exports`, 'POST', {
    sub_version: 0, attr_version: 0,
  });
  assert.equal(noCues.status, 422);
  assert.ok(noCues.body.error.includes('没有字幕'));
});

// ---------- 署名版导出（译文） ----------

async function setupTranslated() {
  const { pid, cues, sub_version } = await setupProject();
  const attrVersion = await addSpeakers(pid);
  await attributeAll(pid, cues, attrVersion); // attr_version → 3
  for (const [i, text] of ['Hello world', 'Welcome'].entries()) {
    const r = await api(`/api/projects/${pid}/translations/en/subtitles/${cues[i].id}`,
      'PUT', { text, cue_version: 1 });
    assert.equal(r.status, 201, JSON.stringify(r.body));
  }
  const transList = cues.map((c) => ({ subtitle_id: c.id, version: 1 }));
  return { pid, cues, sub_version, attr_version: 3, transList };
}

test('署名导出译文：逐行译文须有效且版本未变，否则按行列原因且不生成快照', async () => {
  const { pid, cues, sub_version, attr_version, transList } = await setupTranslated();

  // 清单行数不对应 → 400
  const short = await api(`/api/projects/${pid}/attributed-exports`, 'POST', {
    sub_version, attr_version, lang: 'en', translations: [transList[0]],
  });
  assert.equal(short.status, 400);

  // 缺译（ja 无译文）→ 422 missing
  const missing = await api(`/api/projects/${pid}/attributed-exports`, 'POST', {
    sub_version, attr_version, lang: 'ja',
    translations: cues.map((c) => ({ subtitle_id: c.id, version: 1 })),
  });
  assert.equal(missing.status, 422);
  assert.equal(missing.body.translation.lang, 'ja');
  assert.equal(missing.body.translation.missing.length, 2);

  // 译文版本漂移 → 422 version_stale（英语第一行更新到 v2，仍提交 v1）
  await api(`/api/projects/${pid}/translations/en/subtitles/${cues[0].id}`,
    'PUT', { text: 'Hi world', cue_version: 1, version: 1 });
  const stale = await api(`/api/projects/${pid}/attributed-exports`, 'POST', {
    sub_version, attr_version, lang: 'en', translations: transList,
  });
  assert.equal(stale.status, 422);
  assert.equal(stale.body.translation.version_stale.length, 1);
  assert.equal(stale.body.translation.version_stale[0].submitted_version, 1);
  assert.equal(stale.body.translation.version_stale[0].current.version, 2);

  // 待复核 → 422 review（改源行文本使译文失效）
  const edit = await api(`/api/projects/${pid}/subtitles/${cues[1].id}`, 'PATCH', { version: 1, text: '欢迎呀光临' });
  assert.equal(edit.status, 200);
  const review = await api(`/api/projects/${pid}/attributed-exports`, 'POST', {
    sub_version: edit.body.sub_version, attr_version, lang: 'en',
    translations: [
      { subtitle_id: cues[0].id, version: 2 },
      { subtitle_id: cues[1].id, version: 1 },
    ],
  });
  assert.equal(review.status, 422);
  assert.equal(review.body.translation.review.length, 1);
  assert.equal(review.body.translation.review[0].subtitle_id, cues[1].id);

  // 确认待复核后，收紧规则使译文超字数 → 422 invalid
  await api(`/api/projects/${pid}/translations/en/subtitles/${cues[1].id}/confirm`,
    'POST', { version: 1 });
  await api(`/api/projects/${pid}/rules`, 'PUT', {
    version: 1, max_chars: 3, min_duration_ms: 800, max_cps: 20,
  });
  const subNow = (await api(`/api/projects/${pid}`)).body.sub_version;
  const invalid = await api(`/api/projects/${pid}/attributed-exports`, 'POST', {
    sub_version: subNow, attr_version, lang: 'en',
    translations: [
      { subtitle_id: cues[0].id, version: 2 },
      { subtitle_id: cues[1].id, version: 2 },
    ],
  });
  assert.equal(invalid.status, 422);
  assert.ok(invalid.body.translation.invalid.length >= 1);
  assert.ok(invalid.body.translation.invalid[0].reasons.some((e) => e.includes('最大字数')));

  // 任何失败都不生成快照
  assert.equal((await api(`/api/projects/${pid}/attributed-exports`)).body.length, 0);
});

test('署名导出译文成功：与原文共用时间轴，译文文本 + 说话人标签，快照不可变', async () => {
  const { pid, cues, sub_version, attr_version, transList } = await setupTranslated();

  const src = await api(`/api/projects/${pid}/attributed-exports`, 'POST', {
    sub_version, attr_version,
  });
  assert.equal(src.status, 201);
  const en = await api(`/api/projects/${pid}/attributed-exports`, 'POST', {
    sub_version, attr_version, lang: 'en', translations: transList,
  });
  assert.equal(en.status, 201, JSON.stringify(en.body));
  assert.equal(en.body.version, 2, '原文与译文共用项目内同一序列');
  assert.equal(en.body.lang, 'en');
  assert.deepEqual(timelineOf(en.body.content), timelineOf(src.body.content), '原文与译文共用时间轴');
  assert.ok(en.body.content.includes('<v 张三>Hello world</v>'));
  assert.ok(en.body.content.includes('<v 李四>Welcome</v>'));
  assert.ok(!en.body.content.includes('你好'));

  // 下载一致且不可变
  const dl = await api(en.body.download_url);
  assert.equal(dl.body, en.body.content);
  assert.match(dl.headers.get('content-disposition'), /attributed-en-v2\.vtt/);

  // 译文更新后旧快照不变
  await api(`/api/projects/${pid}/translations/en/subtitles/${cues[0].id}`,
    'PUT', { text: 'Hi there', cue_version: 1, version: 1 });
  const dl2 = await api(en.body.download_url);
  assert.ok(dl2.body.includes('<v 张三>Hello world</v>'));
});

// ---------- 兼容性 ----------

test('兼容：普通导出与旧下载内容不含说话人标签，署名版另存独立序列', async () => {
  const { pid, cues, sub_version, attr_version, transList } = await setupTranslated();

  // 普通原文导出（不含说话人标签）
  const plain = await api(`/api/projects/${pid}/exports`, 'POST', { sub_version });
  assert.equal(plain.status, 201);
  assert.ok(!plain.body.content.includes('<v'), '普通导出不含说话人标签');
  assert.ok(plain.body.content.includes('你好世界'));

  // 普通译文导出（不含说话人标签）
  const plainEn = await api(`/api/projects/${pid}/translations/en/exports`, 'POST', { sub_version });
  assert.equal(plainEn.status, 201);
  assert.ok(!plainEn.body.content.includes('<v'));

  // 署名版导出（原文 + 译文）
  const attrSrc = await api(`/api/projects/${pid}/attributed-exports`, 'POST', {
    sub_version, attr_version,
  });
  assert.equal(attrSrc.status, 201);
  const attrEn = await api(`/api/projects/${pid}/attributed-exports`, 'POST', {
    sub_version, attr_version, lang: 'en', translations: transList,
  });
  assert.equal(attrEn.status, 201);

  // 序列互不影响：署名版 v1/v2；普通导出序列仍是各自 v1
  assert.equal(attrSrc.body.version, 1);
  assert.equal(attrEn.body.version, 2);
  assert.equal((await api(`/api/projects/${pid}/exports`)).body.length, 1);
  assert.equal((await api(`/api/projects/${pid}/translations/en/exports`)).body.length, 1);
  assert.equal((await api(`/api/projects/${pid}/attributed-exports`)).body.length, 2);

  // 旧下载内容不变
  const plainDl = await api(`/api/projects/${pid}/exports/1`);
  assert.equal(plainDl.body, plain.body.content);
  const missing = await api(`/api/projects/${pid}/attributed-exports/99`);
  assert.equal(missing.status, 404);
});
