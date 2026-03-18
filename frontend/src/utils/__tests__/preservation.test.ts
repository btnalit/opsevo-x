/**
 * Preservation Property Tests
 *
 * Property 2: Preservation — 现有功能行为保持
 *
 * These tests verify that existing correct behavior is preserved.
 * They should PASS on unfixed code (confirming baseline behavior is captured).
 * They should CONTINUE TO PASS after the fix (confirming no regression).
 *
 * Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 3.6
 */

import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import { renderMarkdown } from '../markdown'

// ============================================================
// Generators for property-based testing
// ============================================================

/**
 * Generator for plain text content (no special Markdown syntax).
 * Uses alphanumeric characters to avoid Markdown syntax interference.
 * Ensures no leading/trailing spaces that could break bold/italic parsing.
 */
const plainTextArb = fc.stringOf(
  fc.constantFrom(
    'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm',
    'n', 'o', 'p', 'q', 'r', 's', 't', 'u', 'v', 'w', 'x', 'y', 'z',
    'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M',
    '0', '1', '2', '3', '4', '5', '6', '7', '8', '9',
    ' ', ',', '.', ':', ';', '?'
  ),
  { minLength: 1, maxLength: 30 }
).map(s => s.trim()).filter(s => s.length > 0)

/**
 * Generator for simple inline Markdown elements that don't include
 * table or hr syntax. These are the "normal" Markdown elements that
 * should be preserved across the fix.
 */
const normalMarkdownArb = fc.oneof(
  // Bold text
  fc.tuple(plainTextArb).map(([text]) => `**${text}**`),
  // Italic text
  fc.tuple(plainTextArb).map(([text]) => `*${text}*`),
  // Inline code
  fc.tuple(plainTextArb).map(([text]) => `\`${text}\``),
  // Plain text
  plainTextArb,
  // Headings (h1-h6)
  fc.tuple(
    fc.integer({ min: 1, max: 6 }),
    plainTextArb
  ).map(([level, text]) => `${'#'.repeat(level)} ${text}`),
  // Links
  fc.tuple(plainTextArb).map(([text]) => `[${text}](http://example.com)`),
  // Blockquote
  fc.tuple(plainTextArb).map(([text]) => `> ${text}`)
)

/**
 * Generator for dangerous inline event attributes.
 */
const dangerousAttrArb = fc.constantFrom(
  '<div onerror="alert(1)">test</div>',
  '<div onload="alert(1)">test</div>',
  '<div onclick="alert(1)">test</div>',
  '<a href="javascript:alert(1)">click</a>'
)

// ============================================================
// Property 2a: Normal Markdown content renders consistently
// ============================================================

describe('Preservation Property Tests - Property 2: Preservation', () => {

  describe('Property 2a: Normal Markdown rendering is preserved', () => {
    /**
     * Validates: Requirements 3.1
     *
     * For all normal Markdown content (not containing table/hr syntax),
     * renderMarkdown() output should be consistent and contain expected HTML tags.
     *
     * Observation: On unfixed code, bold text renders as <strong>, italic as <em>,
     * code as <code>, links as <a>, headings as <h1>-<h6>, blockquotes as <blockquote>.
     */
    it('bold text always renders with <strong> tag', () => {
      fc.assert(
        fc.property(plainTextArb, (text) => {
          const input = `**${text}**`
          const result = renderMarkdown(input)
          expect(result).toContain('<strong>')
          expect(result).toContain('</strong>')
        }),
        { numRuns: 50 }
      )
    })

    it('italic text always renders with <em> tag', () => {
      fc.assert(
        fc.property(plainTextArb, (text) => {
          const input = `*${text}*`
          const result = renderMarkdown(input)
          expect(result).toContain('<em>')
          expect(result).toContain('</em>')
        }),
        { numRuns: 50 }
      )
    })

    it('inline code always renders with <code> tag', () => {
      fc.assert(
        fc.property(plainTextArb, (text) => {
          const input = `\`${text}\``
          const result = renderMarkdown(input)
          expect(result).toContain('<code>')
          expect(result).toContain('</code>')
        }),
        { numRuns: 50 }
      )
    })

    it('links always render with <a> tag and href attribute', () => {
      fc.assert(
        fc.property(plainTextArb, (text) => {
          const input = `[${text}](http://example.com)`
          const result = renderMarkdown(input)
          expect(result).toContain('<a')
          expect(result).toContain('href=')
        }),
        { numRuns: 50 }
      )
    })

    it('headings always render with correct heading tag', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 1, max: 6 }),
          plainTextArb,
          (level, text) => {
            const input = `${'#'.repeat(level)} ${text}`
            const result = renderMarkdown(input)
            expect(result).toContain(`<h${level}`)
          }
        ),
        { numRuns: 30 }
      )
    })

    it('blockquotes always render with <blockquote> tag', () => {
      fc.assert(
        fc.property(plainTextArb, (text) => {
          const input = `> ${text}`
          const result = renderMarkdown(input)
          expect(result).toContain('<blockquote>')
        }),
        { numRuns: 50 }
      )
    })
  })

  // ============================================================
  // Property 2b: Dangerous tags are always filtered
  // ============================================================

  describe('Property 2b: Dangerous tags are always filtered', () => {
    /**
     * Validates: Requirements 3.3
     *
     * For all dangerous tags (script, iframe, style, form, object),
     * renderMarkdown() must always filter them out. This is a critical
     * security property that must be preserved across any fix.
     *
     * Observation: On unfixed code:
     * - <script> → empty string
     * - <iframe> → empty string
     * - <style> → empty string
     * - <form> → content only (tag removed)
     * - <object> → content wrapped in <p> (tag removed)
     */
    it('script tags are always removed from output', () => {
      fc.assert(
        fc.property(
          fc.stringOf(fc.char().filter(c => !/[<>]/.test(c)), { minLength: 0, maxLength: 30 }),
          (payload) => {
            const input = `<script>${payload}</script>`
            const result = renderMarkdown(input)
            expect(result).not.toContain('<script')
            expect(result).not.toContain('</script>')
          }
        ),
        { numRuns: 50 }
      )
    })

    it('iframe tags are always removed from output', () => {
      fc.assert(
        fc.property(
          fc.stringOf(fc.char().filter(c => !/[<>]/.test(c)), { minLength: 0, maxLength: 30 }),
          (payload) => {
            const input = `<iframe>${payload}</iframe>`
            const result = renderMarkdown(input)
            expect(result).not.toContain('<iframe')
            expect(result).not.toContain('</iframe>')
          }
        ),
        { numRuns: 50 }
      )
    })

    it('style tags are always removed from output', () => {
      fc.assert(
        fc.property(
          fc.stringOf(fc.char().filter(c => !/[<>]/.test(c)), { minLength: 0, maxLength: 30 }),
          (payload) => {
            const input = `<style>${payload}</style>`
            const result = renderMarkdown(input)
            expect(result).not.toContain('<style')
            expect(result).not.toContain('</style>')
          }
        ),
        { numRuns: 50 }
      )
    })

    it('form tags are always removed from output', () => {
      fc.assert(
        fc.property(
          fc.stringOf(fc.char().filter(c => !/[<>]/.test(c)), { minLength: 0, maxLength: 30 }),
          (payload) => {
            const input = `<form>${payload}</form>`
            const result = renderMarkdown(input)
            expect(result).not.toContain('<form')
            expect(result).not.toContain('</form>')
          }
        ),
        { numRuns: 50 }
      )
    })

    it('object tags are always removed from output', () => {
      fc.assert(
        fc.property(
          fc.stringOf(fc.char().filter(c => !/[<>]/.test(c)), { minLength: 0, maxLength: 30 }),
          (payload) => {
            const input = `<object>${payload}</object>`
            const result = renderMarkdown(input)
            expect(result).not.toContain('<object')
            expect(result).not.toContain('</object>')
          }
        ),
        { numRuns: 50 }
      )
    })

    it('inline event attributes (onerror, onload, onclick) are always removed', () => {
      fc.assert(
        fc.property(dangerousAttrArb, (input) => {
          const result = renderMarkdown(input)
          expect(result).not.toMatch(/\bon(error|load|click)\s*=/)
        }),
        { numRuns: 20 }
      )
    })
  })

  // ============================================================
  // Property 2c: renderMarkdown output consistency for non-bug inputs
  // ============================================================

  describe('Property 2c: Output consistency for normal Markdown', () => {
    /**
     * Validates: Requirements 3.1
     *
     * For all normal Markdown content (no table/hr), calling renderMarkdown()
     * twice with the same input should produce the same output.
     * This ensures deterministic behavior is preserved.
     */
    it('renderMarkdown is deterministic for normal Markdown content', () => {
      fc.assert(
        fc.property(normalMarkdownArb, (markdown) => {
          const result1 = renderMarkdown(markdown)
          const result2 = renderMarkdown(markdown)
          expect(result1).toBe(result2)
        }),
        { numRuns: 100 }
      )
    })

    /**
     * Validates: Requirements 3.1
     *
     * For all normal Markdown content, renderMarkdown() should always
     * return a non-empty string (the content is always rendered).
     */
    it('renderMarkdown always returns non-empty output for non-empty normal Markdown', () => {
      fc.assert(
        fc.property(normalMarkdownArb, (markdown) => {
          const result = renderMarkdown(markdown)
          expect(result.length).toBeGreaterThan(0)
        }),
        { numRuns: 100 }
      )
    })

    /**
     * Validates: Requirements 3.1
     *
     * Empty input should return empty string.
     */
    it('renderMarkdown returns empty string for empty input', () => {
      expect(renderMarkdown('')).toBe('')
    })
  })
})
