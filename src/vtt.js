'use strict';

/** 毫秒 -> WebVTT 时间戳 HH:MM:SS.mmm */
function formatTimestamp(ms) {
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const milli = ms % 1000;
  const pad = (v, n) => String(v).padStart(n, '0');
  return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)}.${pad(milli, 3)}`;
}

/**
 * 生成 WebVTT 文件内容。cues 需已按时间升序：
 * [{ start_ms, end_ms, text }]
 */
function toWebVtt(cues) {
  const sorted = [...cues].sort((a, b) => a.start_ms - b.start_ms || a.end_ms - b.end_ms);
  const blocks = ['WEBVTT', ''];
  sorted.forEach((c, i) => {
    blocks.push(
      String(i + 1),
      `${formatTimestamp(c.start_ms)} --> ${formatTimestamp(c.end_ms)}`,
      c.text,
      ''
    );
  });
  return blocks.join('\n');
}

/**
 * 生成带说话人标签的 WebVTT（署名版）。cues 需已按时间升序：
 * [{ start_ms, end_ms, text, speaker }]
 * 每条 cue 文本按 WebVTT 语音语法写作 <v 显示名>文本</v>；
 * 显示名在说话人创建/改名时已校验（不含换行与标签界定符 <、>），导出前再复核。
 */
function toWebVttWithSpeakers(cues) {
  const sorted = [...cues].sort((a, b) => a.start_ms - b.start_ms || a.end_ms - b.end_ms);
  const blocks = ['WEBVTT', ''];
  sorted.forEach((c, i) => {
    blocks.push(
      String(i + 1),
      `${formatTimestamp(c.start_ms)} --> ${formatTimestamp(c.end_ms)}`,
      `<v ${c.speaker}>${c.text}</v>`,
      ''
    );
  });
  return blocks.join('\n');
}

module.exports = { toWebVtt, toWebVttWithSpeakers, formatTimestamp };
