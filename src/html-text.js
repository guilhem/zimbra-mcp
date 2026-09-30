import { Parser } from 'htmlparser2';

const OMIT = new Set(['head', 'script', 'style', 'noscript', 'template', 'iframe', 'object', 'embed', 'svg', 'math']);
const BLOCK = new Set(['address', 'article', 'aside', 'blockquote', 'div', 'dl', 'dt', 'dd', 'fieldset', 'figcaption',
  'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'li', 'main', 'ol', 'p', 'pre',
  'section', 'table', 'tbody', 'thead', 'tfoot', 'tr', 'ul']);

// Tokenization only: no DOM, browser, scripts, styles, URL resolution or fetch.
// The returned string remains untrusted mailbox data, not sanitized HTML.
export function htmlToText(html, limit = 100000) {
  const source = String(html);
  const input = source.slice(0, 500000);
  const stack = [];
  const output = [];
  let length = 0;
  let truncated = input.length < source.length;
  let parser;
  function append(value) {
    if (!value) return;
    const remaining = limit - length;
    if (value.length > remaining) {
      output.push(value.slice(0, remaining)); length = limit;
      truncated = true; parser.pause(); return;
    }
    output.push(value); length += value.length;
  }
  parser = new Parser({
    onopentag(name, attrs) {
      if (stack.length >= 200) { truncated = true; parser.pause(); return; }
      const parentHidden = stack.at(-1)?.hidden ?? false;
      const hidden = parentHidden || OMIT.has(name) || Object.hasOwn(attrs, 'hidden') ||
        attrs['aria-hidden']?.toLowerCase() === 'true' || /(?:display\s*:\s*none|visibility\s*:\s*hidden)/i.test(attrs.style ?? '');
      stack.push({ name, hidden });
      if (!hidden && (BLOCK.has(name) || name === 'br')) append('\n');
      if (!hidden && ['td', 'th'].includes(name)) append('\t');
    },
    ontext(value) {
      if (!stack.at(-1)?.hidden) append(value.replace(/[\t\r\n\f ]+/g, ' ').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ''));
    },
    onclosetag(name) {
      const element = stack.pop();
      if (element && !element.hidden && BLOCK.has(name)) append('\n');
    },
  }, { decodeEntities: true, lowerCaseTags: true, lowerCaseAttributeNames: true });
  parser.end(input);
  return { text: output.join('').replace(/[ \t]+\n/g, '\n').replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n').trim(), truncated };
}
