export const readingConfig = await fetch('/api/config', {cache:'no-store'}).then(r=>{if(!r.ok)throw new Error('Configuration unavailable');return r.json();});
export async function refreshReadingConfig(){Object.assign(readingConfig,await fetch('/api/config',{cache:'no-store'}).then(r=>r.json()));}
export async function syncIslandBadgeAppearance() {
  const color = (value, fallback) => /^#[0-9a-f]{6}$/i.test(value || '') ? value : fallback;
  document.documentElement.style.setProperty('--assistant', color(readingConfig.accent, '#6b4f8a'));
  document.documentElement.style.setProperty('--assistant-on', color(readingConfig.accentText, '#ffffff'));
}
