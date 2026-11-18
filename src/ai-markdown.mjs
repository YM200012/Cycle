import { Marked } from 'marked';

const markdown = new Marked({gfm:true, breaks:true, renderer:{
  html() { return ''; },
  link({tokens}) { return this.parser.parseInline(tokens); },
  image({text}) { return escapeText(text); },
  heading({tokens,depth}) {
    const level=Math.min(6,depth+2);
    return `<h${level}>${this.parser.parseInline(tokens)}</h${level}>`;
  }
}});
function escapeText(value) {
  return String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
}
export function formatReview(text) {
  const unwrapped=text.replace(/^\s*```(?:markdown|md)\s*\r?\n([\s\S]*?)\r?\n```\s*$/i,'$1');
  try { return markdown.parse(unwrapped); }
  catch { return `<p>${escapeText(unwrapped)}</p>`; }
}
