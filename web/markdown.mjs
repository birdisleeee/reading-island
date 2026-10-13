import { Marked } from './vendor/marked.mjs';
const escape = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const parser = new Marked({ gfm: true, breaks: true, renderer: {
  html({text}) { return escape(text); },
  link({href, tokens}) {
    const text = this.parser.parseInline(tokens);
    if (!/^https?:\/\//i.test(href) || /[\u0000-\u0020]/.test(href)) return text;
    return `<a href="${escape(href)}" target="_blank" rel="noopener noreferrer">${text}</a>`;
  },
  image({text}) { return escape(text); },
} });
export function renderMarkdown(text) { return parser.parse(String(text || '')); }
