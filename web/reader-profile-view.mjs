import {escapeHTML as escape} from './visual.mjs';
import {avatarData,readerAvatarContent} from './reader-avatar-view.mjs';

const count=value=>Number.isSafeInteger(value)&&value>=0?value:0;
export function readerProfileView(profile,{counts={},hosted=false}={}){
 const name=String(profile.username||'读者'),login=profile.login_id||profile.user_id||'',avatar=avatarData(profile.avatar_data);
 return `<div class="profile-center">
  <header class="profile-hero">
   <div class="profile-avatar-control"><button type="button" class="profile-avatar" data-avatar-choose aria-label="${avatar?'调整或更换头像':'选择头像图片'}" aria-expanded="false" aria-controls="profile-avatar-actions" ${avatar?'aria-haspopup="menu"':''}><span data-avatar-preview>${readerAvatarContent(profile)}</span><span class="profile-avatar-edit" aria-hidden="true">＋</span></button>
    <div id="profile-avatar-actions" class="profile-avatar-menu" data-avatar-menu role="menu" aria-label="头像操作" hidden><button type="button" role="menuitem" tabindex="-1" data-avatar-adjust>调整当前头像</button><button type="button" role="menuitem" tabindex="-1" data-avatar-replace>选择新图片</button></div>
   </div>
   <span class="profile-avatar-hint" data-avatar-hint>${avatar?'点击头像，调整或更换':'点击头像，从相册选图'}</span>
   <input type="file" data-avatar-file accept="image/png,image/jpeg,image/webp" aria-label="选择头像图片" hidden>
   <h3 class="profile-display-name">${escape(name)}</h3><span class="profile-session-badge">已登录</span>
   <p class="profile-login-id" aria-label="注册账号，不可修改">ID · <span>${escape(login)}</span></p>
  </header>
  <dl class="profile-stats" aria-label="我的阅读"><div><dd>${count(counts.books)}</dd><dt>书籍</dt></div><div><dd>${count(counts.notes)}</dd><dt>摘录</dt></div><div><dd>${count(counts.threads)}</dd><dt>讨论</dt></div></dl>
  <section class="profile-card"><div class="profile-card-head"><h3>阅读资料</h3></div><label class="profile-name-field"><span>阅读称呼</span><input name="username" value="${escape(name)}" maxlength="60" autocomplete="nickname" required></label><p class="profile-card-note">AI 会使用这个称呼与你共读。注册账号保持固定。</p></section>
  ${hosted?'<section class="profile-card"><div class="profile-card-head"><h3>账户与配额</h3></div><button type="button" class="profile-quota-link" data-action="public-account"><span>查看额度 / 申请增加</span><span aria-hidden="true">›</span></button><p class="profile-card-note">书籍 · 议题 · 存储</p></section>':''}
  <input type="hidden" name="avatar_data" value="${avatar}"><input type="hidden" name="revision" value="${count(profile.revision)}">
 </div>`;
}
