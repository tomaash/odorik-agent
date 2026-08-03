import MarkdownIt from 'markdown-it'

/**
 * Agent replies are markdown. html:false escapes any raw HTML the model emits;
 * only tags produced by the parser are rendered (no DOM sanitizer required).
 */
const md = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true,
})

export function renderMarkdown(source: string): string {
  const input = source ?? ''
  if (!input.trim()) return ''
  return md.render(input)
}
