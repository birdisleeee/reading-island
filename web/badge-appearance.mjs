// Configuration is loaded by the recoverable startup flow, never during import.
export const readingConfig = {};
export async function refreshReadingConfig() {
  const response = await fetch('/api/config', { cache: 'no-store' });
  if (!response.ok) throw new Error('暂时无法读取共读岛配置，请重试。');
  const value = await response.json();
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('共读岛配置未能完整读取，请重试。');
  Object.assign(readingConfig, value);
}
export async function syncIslandBadgeAppearance() {
  if(document.documentElement.dataset.readingTheme==='active')return;
  const color = (value, fallback) => /^#[0-9a-f]{6}$/i.test(value || '') ? value : fallback;
  document.documentElement.style.setProperty('--assistant', color(readingConfig.accent, '#6b4f8a'));
  document.documentElement.style.setProperty('--assistant-on', color(readingConfig.accentText, '#ffffff'));
}
