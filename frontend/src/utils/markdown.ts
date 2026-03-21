import { marked } from 'marked'
import DOMPurify from 'dompurify'
import hljs from 'highlight.js'
import { DEVICE_SCRIPT_LANGUAGES } from './scriptExtractor'

/** Languages that support the "execute" action in code blocks */
const EXECUTABLE_LANGUAGES = new Set<string>(DEVICE_SCRIPT_LANGUAGES)

/**
 * Detect the language of a fenced code block string.
 * @param block - Raw fenced code block (e.g., "```bash\n...\n```")
 * @returns The detected language identifier, or 'plaintext' if unknown
 */
export function detectCodeBlockLanguage(block: string): string {
  const match = block.match(/^```(\w+)/)
  return match ? match[1].toLowerCase() : 'plaintext'
}

/**
 * Render a device code block as HTML with syntax highlighting.
 * @param code - The code content
 * @param language - The language identifier
 * @returns HTML string for the code block
 */
export function renderDeviceCodeBlock(code: string, language: string): string {
  const validLanguage = hljs.getLanguage(language) ? language : 'plaintext'
  const highlighted = hljs.highlight(code, { language: validLanguage }).value
  const isExecutable = EXECUTABLE_LANGUAGES.has(language.toLowerCase())
  const encodedText = encodeURIComponent(code)

  return `<div class="code-block${isExecutable ? ' device-script-block' : ''}">
      <div class="code-header">
        <span class="code-language">${language}</span>
        <div class="code-actions">
          <button class="code-action-btn copy-btn" data-code="${encodedText}" title="复制代码">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
              <path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/>
            </svg>
            复制
          </button>
          ${isExecutable ? `<button class="code-action-btn execute-btn" data-script="${encodedText}" data-language="${language.toLowerCase()}" title="执行脚本">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
              <path d="M8 5v14l11-7z"/>
            </svg>
            执行
          </button>` : ''}
        </div>
      </div>
      <pre><code class="hljs language-${validLanguage}">${highlighted}</code></pre>
    </div>`
}

/**
 * Configure marked options and custom renderer
 */
const configureMarked = () => {
  const renderer = new marked.Renderer()

  // Custom renderer for code blocks — supports multiple device script languages
  renderer.code = ({ text, lang }: { text: string; lang?: string }) => {
    const language = lang || 'plaintext'

    // Handle Mermaid explicitly
    if (language.toLowerCase() === 'mermaid') {
      return `<div class="mermaid">${text}</div>`
    }

    return renderDeviceCodeBlock(text, language)
  }

  marked.setOptions({
    breaks: true,
    gfm: true
  })

  marked.use({ renderer })
}

// Initial configuration
configureMarked()

/**
 * Render markdown content safely using DOMPurify
 * @param content Raw markdown string
 * @returns Sanitized HTML string
 */
export const renderMarkdown = (content: string): string => {
  if (!content) return ''

  try {
    const rawHtml = marked.parse(content) as string

    // Sanitize the HTML
    return DOMPurify.sanitize(rawHtml, {
      // Allow essential tags for markdown rendering
      ALLOWED_TAGS: [
        'p', 'br', 'strong', 'em', 'code', 'pre', 'ul', 'ol', 'li',
        'a', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote',
        'div', 'span', 'button', 'svg', 'path', 'line', 'circle', 'text', 'rect', 'polygon', 'g', 'marker', 'defs', 'clipPath', 'foreignObject', // Required for SVG and Mermaid charts
        'table', 'thead', 'tbody', 'tr', 'th', 'td', // Table support
        'hr' // Horizontal rule support
      ],
      // Allow essential attributes
      ALLOWED_ATTR: [
        'href', 'target', 'rel', 'class', 'style', 'title', 'data-code', 'data-script', 'data-language', 'id',
        'viewBox', 'width', 'height', 'fill', 'stroke', 'stroke-width', 'stroke-dasharray', 'x', 'y', 'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'd', 'transform', 'marker-end', 'preserveAspectRatio', // SVG and Mermaid generic attr
        'align', 'valign' // Table cell alignment
      ],
      // Ensure links are safe
      ADD_ATTR: ['target'],
      FORBID_TAGS: ['script', 'style', 'iframe', 'form', 'object'],
      FORBID_ATTR: ['onerror', 'onload', 'onclick'] // Prevent inline JS
    })
  } catch (err) {
    console.error('Failed to render markdown:', err)
    // Fallback to simple text with basic escaping
    return content
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/\n/g, '<br>')
  }
}
