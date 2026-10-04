'use strict';

/**
 * 说话人归属与署名版导出：
 *
 * 说话人：
 *   - 项目内维护 编号 code（唯一、创建后不可变）与 显示名 name；
 *   - 显示名会写入 WebVTT <v 显示名> 说话人标签，因此拒绝含换行或标签界定符（<、>）的名字；
 *   - 说话人新增/改名都推进项目级归属版本 attr_version。
 *
 * 归属（字幕 → 说话人）：
 *   - 归属提交按字幕 ID 携带读取时行版本 cue_version 与归属版本 attr_version；
 *   - 说话人编号必须已存在；锁定行也可标注；同批字幕 ID 不得重复；
 *   - 任一过期（归属版本/行版本）整批不生效，返回当前值与逐行原因；
 *   - 归属只锚定字幕 ID：重排保留 ID 的行归属继续有效（文本/时间/锁定/展示顺序变化不影响）；
 *     源行删除后归属留作历史（subtitle_id 置空），新行待标注，不按展示序号转移。
 *
 * 署名版导出：
 *   - 请求携带字幕集版本 sub_version 与归属版本 attr_version（任一漂移 → 409）；
 *   - 同一事务内核对：源整版结构/规则通过、每条当前字幕均有有效归属、显示名可写入标签；
 *   - 可选择原文（省略 lang）或一种目标语言；选择译文时携带逐行译文版本，
 *     译文须逐行 current、版本未变且满足现行字数/字速，否则按行列原因且不生成快照；
 *   - 原文与译文共用同一时间轴（译文沿用源行起止）；快照不可变，另存于
 *     attributed_exports（项目内单序列），可查询、可下载；
 *   - 普通导出（exports / translation_exports）及旧下载内容保持兼容、互不影响。
 */

const { validateStructure, validateRules } = require('./layout');
const { normalizeLang, checkTranslationText } = require('./translation');
const { getAttrVersion, bumpAttrVersion } = require('./db');

function isInt(v) {
  return typeof v === 'number' && Number.isInteger(v);
}

const MAX_CODE_LEN = 32;
const CODE_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const MAX_NAME_LEN = 64;
const MAX_ATTR_ITEMS = 5000;

/** 说话人编号：非空、≤32 字、字母或数字开头（字母/数字/-/_），如 S1、speaker-01；非法返回 null */
function normalizeSpeakerCode(raw) {
  if (typeof raw !== 'string') return null;
  const code = raw.trim();
  if (code === '' || code.length > MAX_CODE_LEN || !CODE_RE.test(code)) return null;
  return code;
}

/**
 * 显示名校验：非空、≤64 字，且不得包含换行或 WebVTT 标签界定符（<、>）——
 * 显示名会写入 <v 显示名> 说话人标签，换行/界定符会破坏文件语法。
 * 返回中文原因列表，空数组表示通过。
 */
function speakerNameErrors(name) {
  const errors = [];
  if (typeof name !== 'string' || name.trim() === '') {
    errors.push('显示名必须是非空字符串');
    return errors;
  }
  if (name.length > MAX_NAME_LEN) {
    errors.push(`显示名长度 ${name.length} 超过上限 ${MAX_NAME_LEN} 字`);
  }
  if (/[\r\n]/.test(name)) {
    errors.push('显示名不能包含换行：WebVTT 说话人标签 <v 显示名> 为单行语法');
  }
  if (/[<>]/.test(name)) {
    errors.push('显示名不能包含标签界定符 < 或 >：会破坏 WebVTT 说话人标签语法');
  }
  return errors;
}

/** 新建说话人请求：{code, name}（name 去首尾空白后存储） */
function parseSpeakerBody(body) {
  const errors = [];
  const b = body || {};
  const code = normalizeSpeakerCode(b.code);
  if (!code) {
    errors.push('code（说话人编号）非法：须非空、≤32 字、字母或数字开头（字母/数字/-/_），如 S1、speaker-01');
  } else if (code !== b.code) {
    errors.push(`code 含首尾空白，请提交规范化形式 "${code}"`);
  }
  const name = typeof b.name === 'string' ? b.name.trim() : b.name;
  errors.push(...speakerNameErrors(name).map((e) => `name（显示名）：${e}`));
  return { ok: errors.length === 0, errors, speaker: errors.length === 0 ? { code, name } : null };
}

/** 说话人改名请求：{name, attr_version?}（attr_version 可选，携带时用于防呆） */
function parseRenameBody(body) {
  const errors = [];
  const b = body || {};
  const name = typeof b.name === 'string' ? b.name.trim() : b.name;
  errors.push(...speakerNameErrors(name).map((e) => `name（显示名）：${e}`));
  let attrVersion = null;
  if (b.attr_version !== undefined && b.attr_version !== null) {
    if (!isInt(b.attr_version) || b.attr_version < 0) {
      errors.push('attr_version（读取时归属版本）必须是 ≥0 的整数');
    } else {
      attrVersion = b.attr_version;
    }
  }
  return {
    ok: errors.length === 0,
    errors,
    name: errors.length === 0 ? name : null,
    attr_version: attrVersion,
  };
}

/**
 * 归属提交请求：{attr_version, items:[{subtitle_id, cue_version, speaker}]}
 * - attr_version：读取时归属版本（项目级乐观锁）；
 * - 每项按字幕 ID 携带读取时行版本 cue_version 与说话人编号 speaker；
 * - 同批 subtitle_id 不得重复。
 */
function parseAttributionBody(body) {
  const errors = [];
  const b = body || {};
  if (!isInt(b.attr_version) || b.attr_version < 0) {
    errors.push('attr_version（读取时归属版本）必须是 ≥0 的整数');
  }
  const items = [];
  if (!Array.isArray(b.items)) {
    errors.push('items 必须是非空数组：逐行归属 [{subtitle_id, cue_version, speaker}]');
  } else if (b.items.length === 0) {
    errors.push('items 不能为空：一次归属提交至少标注一行');
  } else if (b.items.length > MAX_ATTR_ITEMS) {
    errors.push(`items 数量 ${b.items.length} 超过上限 ${MAX_ATTR_ITEMS}`);
  } else {
    const seen = new Set();
    b.items.forEach((it, i) => {
      if (!it || typeof it !== 'object' || Array.isArray(it)) {
        errors.push(`items[${i}] 必须是对象 {subtitle_id, cue_version, speaker}`);
        return;
      }
      const itemErrors = [];
      if (!isInt(it.subtitle_id) || it.subtitle_id < 1) {
        itemErrors.push('subtitle_id 必须是 ≥1 的整数');
      }
      if (!isInt(it.cue_version) || it.cue_version < 1) {
        itemErrors.push('cue_version（读取时源字幕行版本）必须是 ≥1 的整数');
      }
      const code = normalizeSpeakerCode(it.speaker);
      if (!code) {
        itemErrors.push('speaker（说话人编号）非法：须为已创建的编号（字母/数字/-/_，≤32 字）');
      }
      if (itemErrors.length > 0) {
        errors.push(`items[${i}]：${itemErrors.join('；')}`);
        return;
      }
      if (seen.has(it.subtitle_id)) {
        errors.push(`items 中字幕 ${it.subtitle_id} 重复出现：同批每行只能标注一次`);
        return;
      }
      seen.add(it.subtitle_id);
      items.push({ subtitle_id: it.subtitle_id, cue_version: it.cue_version, speaker: code });
    });
  }
  return {
    ok: errors.length === 0,
    errors,
    request: errors.length === 0 ? { attr_version: b.attr_version, items } : null,
  };
}

/** 项目说话人列表（视图用，不含内部 id） */
function listSpeakers(db, projectId) {
  return db.prepare(
    'SELECT code, name, created_at, updated_at FROM speakers WHERE project_id = ? ORDER BY code'
  ).all(projectId);
}

/** 项目说话人 Map(code → 行)，归属写入时需要 speaker_id */
function speakersByCode(db, projectId) {
  const rows = db.prepare('SELECT * FROM speakers WHERE project_id = ?').all(projectId);
  return new Map(rows.map((r) => [r.code, r]));
}

const mapAttributionRow = (r) => ({
  id: r.id,
  subtitle_id: r.subtitle_id,
  speaker: r.speaker_code,
  speaker_name: r.speaker_name,
  status: r.status,
  cue_version_snapshot: r.cue_version_snapshot,
  created_at: r.created_at,
  updated_at: r.updated_at,
});

/** 项目当前有效归属 Map(subtitle_id → 行，含说话人编号与显示名) */
function activeAttributions(db, projectId) {
  const rows = db.prepare(
    `SELECT a.*, s.code AS speaker_code, s.name AS speaker_name
       FROM attributions a JOIN speakers s ON s.id = a.speaker_id
      WHERE a.project_id = ? AND a.status = 'current' ORDER BY a.id`
  ).all(projectId);
  const byCue = new Map();
  for (const r of rows) byCue.set(r.subtitle_id, r);
  return byCue;
}

/**
 * 源字幕删除后的归属对账（与 syncTranslations 同点调用）：
 * 失去源行的归属转 history（subtitle_id 置空），不按展示序号挪用到新行；
 * 有归属转入历史时推进归属版本（归属状态已变化）。返回本次转入历史的条数。
 */
function syncAttributions(db, projectId) {
  const orphaned = db.prepare(
    `UPDATE attributions
        SET status = 'history', subtitle_id = NULL, updated_at = datetime('now')
      WHERE project_id = ? AND status = 'current'
        AND (subtitle_id IS NULL
             OR NOT EXISTS (SELECT 1 FROM subtitles s WHERE s.id = subtitle_id))`
  ).run(projectId).changes;
  if (orphaned > 0) bumpAttrVersion(db, projectId);
  return orphaned;
}

/**
 * 归属视图：按展示顺序列出每条当前字幕 + 说话人归属 + 状态。
 * entries[].state：attributed（已标注）/ missing（待标注）；
 * 附说话人列表、归属版本与历史归属（源行已删除）。
 */
function buildAttributionView(db, projectId) {
  const project = db.prepare('SELECT sub_version FROM projects WHERE id = ?').get(projectId);
  const cues = db.prepare(
    `SELECT id, idx, word_start, word_end, text, start_ms, end_ms, locked, version
     FROM subtitles WHERE project_id = ? ORDER BY idx`
  ).all(projectId);
  const byCue = activeAttributions(db, projectId);
  const entries = cues.map((cue) => {
    const row = byCue.get(cue.id);
    return {
      cue,
      attribution: row ? mapAttributionRow(row) : null,
      state: row ? 'attributed' : 'missing',
    };
  });
  const counts = { cues: cues.length, attributed: 0, missing: 0 };
  for (const e of entries) counts[e.state]++;
  const history = db.prepare(
    `SELECT a.*, s.code AS speaker_code, s.name AS speaker_name
       FROM attributions a JOIN speakers s ON s.id = a.speaker_id
      WHERE a.project_id = ? AND a.status = 'history' ORDER BY a.id DESC`
  ).all(projectId).map(mapAttributionRow);
  return {
    project_id: projectId,
    sub_version: project.sub_version,
    attr_version: getAttrVersion(db, projectId),
    speakers: listSpeakers(db, projectId),
    counts,
    entries,
    history,
  };
}

/**
 * 事务内逐行核对归属提交（对权威当前状态执行）：
 *   attr_version 漂移 → attr_version_stale；
 *   逐行：cue_missing（源行已消失）/ cue_version_stale（行版本过期）。
 * 锁定行可以标注（不检查 locked）。全部 ok 时由路由写入。
 */
function evaluateAttributionItems(project, request) {
  const cueById = new Map(project.subtitles.map((c) => [c.id, c]));
  const items = request.items.map((it, ord) => {
    const out = {
      ord,
      subtitle_id: it.subtitle_id,
      cue_version: it.cue_version,
      speaker: it.speaker,
      state: 'ok',
      cue: null,
      reasons: [],
    };
    const cue = cueById.get(it.subtitle_id);
    if (!cue) {
      out.state = 'cue_missing';
      out.reasons.push(
        `字幕 ${it.subtitle_id} 在当前字幕集（v${project.sub_version}）中不存在（可能已被重排删除），请刷新后重新提交`
      );
      return out;
    }
    out.cue = cue;
    if (it.cue_version !== cue.version) {
      out.state = 'cue_version_stale';
      out.reasons.push(`源字幕行版本过期：提交基于 v${it.cue_version}，当前已是 v${cue.version}`);
    }
    return out;
  });
  return {
    attr_version_stale: request.attr_version !== project.attr_version,
    attr_version_current: project.attr_version,
    items,
  };
}

/**
 * 署名版导出请求：{sub_version, attr_version, lang?, translations?}
 * - sub_version / attr_version 必填（导出与读取一致的乐观锁）；
 * - lang 省略/null 表示导出原文；否则为一种目标语言代号；
 * - 选择译文时必须携带 translations：逐行译文版本 [{subtitle_id, version}]；
 *   未选译文时不得携带 translations。
 */
function parseAttributedExportBody(body) {
  const errors = [];
  const b = body || {};
  if (!isInt(b.sub_version) || b.sub_version < 0) {
    errors.push('sub_version（读取时字幕集版本）必须是 ≥0 的整数');
  }
  if (!isInt(b.attr_version) || b.attr_version < 0) {
    errors.push('attr_version（读取时归属版本）必须是 ≥0 的整数');
  }
  let lang = null;
  if (b.lang !== undefined && b.lang !== null) {
    const normalized = normalizeLang(b.lang);
    if (!normalized) {
      errors.push(`lang（目标语言代号）${JSON.stringify(b.lang)} 非法：须非空、≤32 字、字母开头（如 en、ja-JP）`);
    } else if (normalized !== b.lang) {
      errors.push(`lang 含首尾空白，请提交规范化形式 "${normalized}"`);
    } else {
      lang = normalized;
    }
  }
  const items = [];
  if (lang) {
    if (!Array.isArray(b.translations)) {
      errors.push(`选择译文（lang="${lang}"）时必须携带 translations：逐行译文版本 [{subtitle_id, version}]`);
    } else if (b.translations.length === 0) {
      errors.push('translations 不能为空：须逐行覆盖当前每条字幕');
    } else {
      const seen = new Set();
      b.translations.forEach((it, i) => {
        if (!it || typeof it !== 'object' || Array.isArray(it)) {
          errors.push(`translations[${i}] 必须是对象 {subtitle_id, version}`);
          return;
        }
        if (!isInt(it.subtitle_id) || it.subtitle_id < 1) {
          errors.push(`translations[${i}].subtitle_id 必须是 ≥1 的整数`);
          return;
        }
        if (!isInt(it.version) || it.version < 1) {
          errors.push(`translations[${i}].version（译文版本）必须是 ≥1 的整数`);
          return;
        }
        if (seen.has(it.subtitle_id)) {
          errors.push(`translations 中字幕 ${it.subtitle_id} 重复出现：逐行清单每行只能出现一次`);
          return;
        }
        seen.add(it.subtitle_id);
        items.push({ subtitle_id: it.subtitle_id, version: it.version });
      });
    }
  } else if (b.translations !== undefined && b.translations !== null) {
    errors.push('未选择译文（无 lang）时不得携带 translations：导出原文只需 sub_version 与 attr_version');
  }
  return {
    ok: errors.length === 0,
    errors,
    request: errors.length === 0
      ? { sub_version: b.sub_version, attr_version: b.attr_version, lang, items }
      : null,
  };
}

/**
 * 署名版导出前核对（事务内对权威当前状态执行）：
 *   1) sub_version / attr_version 仍是当前值；
 *   2) 源整版结构（词覆盖/不重叠/不跨切点/不缩短词时段）与现行规则通过；
 *   3) 每条当前字幕都有当前有效归属，且说话人显示名可写入 WebVTT 标签；
 *   4) 选择译文时：逐行译文 current、版本与提交一致、满足现行字数/字速。
 * project 为 loadProject 结果；activeByCue 为 activeAttributions 结果；
 * translationsByCue 为 activeTranslationsByLang 结果（仅选择译文时）。
 */
function evaluateAttributedExport(project, request, activeByCue, translationsByCue) {
  const conflicts = [
    ...validateStructure(project.subtitles, project.words, project.cuts),
    ...validateRules(project.subtitles, project.rules),
  ];

  // 归属覆盖：每条当前字幕都必须有有效归属；显示名防御性复核（写入时已校验）
  const missingAttribution = [];
  const invalidSpeakers = [];
  const badNameSeen = new Set();
  for (const cue of project.subtitles) {
    const attr = activeByCue.get(cue.id);
    if (!attr) {
      missingAttribution.push({
        subtitle_id: cue.id, idx: cue.idx, text: cue.text,
        reasons: ['该字幕尚未标注说话人：每条当前字幕都必须有有效归属才能导出署名版'],
      });
      continue;
    }
    const nameErrs = speakerNameErrors(attr.speaker_name);
    if (nameErrs.length > 0 && !badNameSeen.has(attr.speaker_code)) {
      badNameSeen.add(attr.speaker_code);
      invalidSpeakers.push({ code: attr.speaker_code, name: attr.speaker_name, reasons: nameErrs });
    }
  }

  // 译文逐行核对（仅选择译文时）：缺译 / 待复核 / 无效 / 版本漂移，按行列原因
  let translation = null;
  if (request.lang) {
    const lang = request.lang;
    const submitted = new Map(request.items.map((it) => [it.subtitle_id, it.version]));
    const cueById = new Map(project.subtitles.map((c) => [c.id, c]));
    const missing = [];
    const review = [];
    const invalid = [];
    const versionStale = [];

    // 清单指向当前字幕集不存在行的兜底（正常会被 sub_version 漂移先拦截）
    for (const [sid, version] of submitted) {
      if (!cueById.has(sid)) {
        missing.push({
          subtitle_id: sid, idx: null, text: null, submitted_version: version,
          reasons: [`字幕 ${sid} 在当前字幕集（v${project.sub_version}）中不存在（可能已被重排删除），请刷新后重新提交`],
        });
      }
    }

    for (const cue of project.subtitles) {
      const submittedVersion = submitted.get(cue.id);
      const row = translationsByCue.get(cue.id);
      if (submittedVersion === undefined) {
        missing.push({
          subtitle_id: cue.id, idx: cue.idx, text: cue.text,
          reasons: ['逐行译文版本清单缺少该字幕行'],
        });
        continue;
      }
      if (!row) {
        missing.push({
          subtitle_id: cue.id, idx: cue.idx, text: cue.text, submitted_version: submittedVersion,
          reasons: [`语言 ${lang} 在字幕 ${cue.id} 上没有当前译文（源行可能已重排删除，旧译文留作历史且不按序号挪用）`],
        });
        continue;
      }
      if (row.version !== submittedVersion) {
        versionStale.push({
          subtitle_id: cue.id, idx: cue.idx, text: cue.text,
          submitted_version: submittedVersion,
          current: { version: row.version, status: row.status, text: row.text },
          reasons: [`译文版本漂移：提交基于 v${submittedVersion}，当前已是 v${row.version}，请刷新后重新提交`],
        });
        continue;
      }
      if (row.status === 'review') {
        review.push({
          subtitle_id: cue.id, idx: cue.idx, text: cue.text,
          current: { version: row.version, text: row.text },
          reasons: ['该译文为待复核状态：保存后源字幕文本/时间/词区间已变化，须确认或重新保存后再导出'],
        });
        continue;
      }
      const ruleReasons = checkTranslationText(row.text, cue, project.rules);
      if (ruleReasons.length > 0) {
        invalid.push({
          subtitle_id: cue.id, idx: cue.idx, text: cue.text,
          current: { version: row.version, text: row.text },
          reasons: ruleReasons,
        });
      }
    }
    translation = {
      lang,
      missing, review, invalid, version_stale: versionStale,
      problem_count: missing.length + review.length + invalid.length + versionStale.length,
    };
  }

  const ok =
    conflicts.length === 0 &&
    missingAttribution.length === 0 &&
    invalidSpeakers.length === 0 &&
    (!translation || translation.problem_count === 0);
  return {
    ok,
    sub_version_stale: request.sub_version !== project.sub_version,
    attr_version_stale: request.attr_version !== project.attr_version,
    sub_version_current: project.sub_version,
    attr_version_current: project.attr_version,
    conflicts,
    missing_attribution: missingAttribution,
    invalid_speakers: invalidSpeakers,
    translation,
  };
}

const mapExportRow = (r) => ({
  version: r.version,
  lang: r.lang,
  cue_count: r.cue_count,
  sub_version: r.sub_version,
  attr_version: r.attr_version,
  created_at: r.created_at,
  download_url: `/api/projects/${r.project_id}/attributed-exports/${r.version}`,
});

/** 署名版导出快照列表（项目内单序列，倒序；原文 lang 为 null） */
function listAttributedExports(db, projectId) {
  return db.prepare(
    'SELECT * FROM attributed_exports WHERE project_id = ? ORDER BY version DESC'
  ).all(projectId).map(mapExportRow);
}

module.exports = {
  MAX_CODE_LEN,
  MAX_NAME_LEN,
  normalizeSpeakerCode,
  speakerNameErrors,
  parseSpeakerBody,
  parseRenameBody,
  parseAttributionBody,
  listSpeakers,
  speakersByCode,
  activeAttributions,
  syncAttributions,
  buildAttributionView,
  evaluateAttributionItems,
  parseAttributedExportBody,
  evaluateAttributedExport,
  listAttributedExports,
};
