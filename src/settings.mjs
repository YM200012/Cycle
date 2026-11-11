export const analysisDefaults = { ftpHistory: [], effortThresholdPct: 90, effortMinSeconds: 60, effortRecoverySeconds: 15 };

const invalid = message => { const error = Error(message); error.status = 400; throw error; };
function historyDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value < '1900-01-01' || value > '2200-12-31' || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) invalid('FTP 生效日期必须为有效的 YYYY-MM-DD');
  return value;
}
function numeric(value, label, min, max, fallback, integer = false) {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) invalid(`${label} 必须为 ${min}–${max} 范围内的${integer ? '整数' : '数值'}`);
  return value;
}
export function normalizeAnalysisSettings(value = {}) {
  const history = value.ftpHistory === undefined ? [] : value.ftpHistory;
  if (!Array.isArray(history) || history.length > 1000) invalid('FTP 历史必须为最多 1000 项的数组');
  const seen = new Set();
  const ftpHistory = history.map(entry => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) invalid('FTP 历史条目格式无效');
    const date = historyDate(entry.date);
    if (seen.has(date)) invalid('FTP 历史不能包含重复生效日期');
    seen.add(date);
    return { date, ftp: numeric(entry.ftp, '历史 FTP', 1, 1000, undefined) ?? invalid('请填写历史 FTP') };
  }).sort((a, b) => a.date.localeCompare(b.date));
  return { ftpHistory,
    effortThresholdPct: numeric(value.effortThresholdPct, '努力段阈值 / % FTP', 30, 300, analysisDefaults.effortThresholdPct),
    effortMinSeconds: numeric(value.effortMinSeconds, '努力段最短高强度秒数', 5, 3600, analysisDefaults.effortMinSeconds, true),
    effortRecoverySeconds: numeric(value.effortRecoverySeconds, '努力段恢复连接秒数', 0, 300, analysisDefaults.effortRecoverySeconds, true) };
}

/** Latest historical setting effective on the activity date; otherwise current FTP. */
export function resolveFtp(activity = {}, settings = {}) {
  let latest = null;
  if (typeof activity.date === 'string') for (const row of settings.ftpHistory || []) {
    if (typeof row?.date === 'string' && row.date <= activity.date && Number.isFinite(row.ftp) && row.ftp > 0 && (!latest || row.date > latest.date)) latest = row;
  }
  return latest ? { ftp: latest.ftp, source: 'history', effectiveDate: latest.date }
    : { ftp: Number.isFinite(settings.ftp) && settings.ftp > 0 ? settings.ftp : null, source: 'current', effectiveDate: null };
}
