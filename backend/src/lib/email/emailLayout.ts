/** Escapes text for HTML, so a name such as "<b>" shows as typed instead of becoming markup. */
export function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

interface EmailContent {
  /** Shown by mail clients next to the subject. */
  previewText: string;
  heading: string;
  /** Plain-text paragraphs. They are escaped here. */
  paragraphs: string[];
  button?: { label: string; href: string };
  /** Smaller notes under the button, also plain text. */
  footnotes?: string[];
}

const paragraphHtml = (text: string, color = '#334155', size = 14) =>
  `<p style="margin:0 0 12px;font-size:${size}px;line-height:1.6;color:${color};">${escapeHtml(text)}</p>`;

function buttonHtml({ label, href }: { label: string; href: string }): string {
  const safeHref = escapeHtml(href);
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:24px 0;"><tr>
<td style="border-radius:8px;background-color:#0b5cab;"><a href="${safeHref}" style="display:inline-block;padding:12px 28px;font-size:14px;font-weight:600;color:#ffffff;text-decoration:none;">${escapeHtml(label)}</a></td>
</tr></table>
${paragraphHtml("If the button doesn't work, paste this link into your browser:", '#64748b', 12)}
<p style="margin:0 0 12px;font-size:12px;word-break:break-all;"><a href="${safeHref}" style="color:#0b5cab;">${safeHref}</a></p>`;
}

/**
 * The HTML and text versions of one email. Inline styles and tables, because mail clients drop style sheets and
 * modern layout unpredictably.
 */
export function renderEmail(content: EmailContent): { html: string; text: string } {
  const body = [
    `<h1 style="margin:0 0 16px;font-size:20px;font-weight:600;color:#0f172a;">${escapeHtml(content.heading)}</h1>`,
    ...content.paragraphs.map((paragraph) => paragraphHtml(paragraph)),
    content.button ? buttonHtml(content.button) : '',
    ...(content.footnotes ?? []).map((note) => paragraphHtml(note, '#94a3b8', 12)),
  ].join('\n');

  const html = `<!doctype html>
<html><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /><title>TwinTrack</title></head>
<body style="margin:0;padding:0;background-color:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(content.previewText)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f1f5f9;padding:32px 16px;"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background-color:#ffffff;border-radius:12px;overflow:hidden;">
<tr><td style="background-color:#0b5cab;padding:20px 32px;color:#ffffff;font-size:18px;font-weight:600;">TwinTrack</td></tr>
<tr><td style="padding:32px;">${body}</td></tr>
<tr><td style="padding:16px 32px;background-color:#f8fafc;border-top:1px solid #e2e8f0;font-size:12px;line-height:1.6;color:#94a3b8;">An automated message from TwinTrack. Please don't reply to it.</td></tr>
</table></td></tr></table></body></html>`;

  const text = [
    content.heading,
    '',
    ...content.paragraphs,
    ...(content.button ? ['', `${content.button.label}: ${content.button.href}`] : []),
    ...(content.footnotes?.length ? ['', ...content.footnotes] : []),
  ].join('\n');

  return { html, text };
}
