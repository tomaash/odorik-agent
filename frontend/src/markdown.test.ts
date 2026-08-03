import { describe, expect, it } from 'vitest'
import { renderMarkdown } from './markdown'

describe('renderMarkdown', () => {
  it('renders bold and leaves citation markers intact', () => {
    const html = renderMarkdown(
      'Your email address appears to be **tom@gug.cz**, as shown in the recipient field of your stored emails [C2].',
    )
    expect(html).toContain('<strong>')
    expect(html).toContain('tom@gug.cz')
    expect(html).toContain('[C2]')
    expect(html).not.toContain('**tom@gug.cz**')
  })

  it('turns single newlines into line breaks', () => {
    const html = renderMarkdown('line one\nline two')
    expect(html).toContain('<br')
  })

  it('renders lists', () => {
    const html = renderMarkdown('- first\n- second')
    expect(html).toMatch(/<ul>/i)
    expect(html).toMatch(/<li>/i)
    expect(html).toContain('first')
  })

  it('escapes raw HTML instead of executing it', () => {
    const html = renderMarkdown('safe <script>alert(1)</script> text')
    expect(html).not.toMatch(/<script/i)
    expect(html).toContain('safe')
    expect(html).toContain('&lt;script&gt;')
    expect(html).toContain('text')
  })

  it('returns empty string for blank input', () => {
    expect(renderMarkdown('')).toBe('')
    expect(renderMarkdown('   ')).toBe('')
  })
})
