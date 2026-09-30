import test from 'node:test';
import assert from 'node:assert/strict';
import { htmlToText } from '../src/html-text.js';

test('HTML extraction decodes entities and retains readable paragraphs and table text', () => {
  const r = htmlToText('<p>Hello &amp; welcome&nbsp;!</p><p>Line<br>two &#x1F642;</p><table><tr><td>A</td><td>B</td></tr></table>');
  assert.match(r.text, /Hello & welcome\u00a0!/);
  assert.match(r.text, /Line\ntwo 🙂/);
  assert.match(r.text, /A\tB/);
  assert.equal(r.truncated, false);
});

test('HTML extraction ignores active elements, comments, hidden regions and resource URLs', () => {
  const r = htmlToText(`<head><title>HIDDEN_HEAD</title></head><script>HIDDEN_SCRIPT</script><style>HIDDEN_STYLE</style>
    <p>Visible <a href="https://unapproved.invalid/?secret=x" onclick="HIDDEN_EVENT">link</a></p>
    <img src="https://tracking.invalid/pixel" onerror="HIDDEN_IMAGE"><!-- HIDDEN_COMMENT -->
    <iframe src="https://unapproved.invalid">HIDDEN_IFRAME</iframe><svg>HIDDEN_SVG</svg>
    <div hidden>HIDDEN_ATTR</div><div style="display:none">HIDDEN_CSS</div><p aria-hidden="true">HIDDEN_ARIA</p>
    <p>Done</p>`);
  assert.match(r.text, /Visible link/); assert.match(r.text, /Done/);
  assert.doesNotMatch(r.text, /HIDDEN|unapproved|tracking|secret=|<|>/);
});

test('malformed HTML is tokenized as text without evaluating code', () => {
  const r = htmlToText('<p>First<p>Second<br/>Third<script>doNotRun()<broken');
  assert.match(r.text, /First/); assert.match(r.text, /Second/); assert.match(r.text, /Third/);
  assert.doesNotMatch(r.text, /doNotRun|broken/);
});

test('HTML extraction bounds input and output and reports truncation', () => {
  assert.equal(htmlToText('<p>' + 'a'.repeat(101000) + '</p>').truncated, true);
  assert.ok(htmlToText('<p>' + 'a'.repeat(101000) + '</p>').text.length <= 100000);
  assert.equal(htmlToText('<script>' + 'a'.repeat(500001) + '</script>').truncated, true);
  assert.equal(htmlToText('<div>'.repeat(300) + 'deep').truncated, true);
});
