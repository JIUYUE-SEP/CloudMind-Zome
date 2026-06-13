import { marked, type Tokens } from 'marked'
import DOMPurify from 'dompurify'
import hljs from 'highlight.js/lib/core'

// Dark theme for code blocks
import 'highlight.js/styles/atom-one-dark.css'

// Register common languages
import python from 'highlight.js/lib/languages/python'
import javascript from 'highlight.js/lib/languages/javascript'
import typescript from 'highlight.js/lib/languages/typescript'
import bash from 'highlight.js/lib/languages/bash'
import json from 'highlight.js/lib/languages/json'
import yaml from 'highlight.js/lib/languages/yaml'
import sql from 'highlight.js/lib/languages/sql'
import vue from 'highlight.js/lib/languages/xml' // vue syntax is close to xml/html
import html from 'highlight.js/lib/languages/xml'
import css from 'highlight.js/lib/languages/css'

hljs.registerLanguage('python', python)
hljs.registerLanguage('javascript', javascript)
hljs.registerLanguage('typescript', typescript)
hljs.registerLanguage('bash', bash)
hljs.registerLanguage('json', json)
hljs.registerLanguage('yaml', yaml)
hljs.registerLanguage('sql', sql)
hljs.registerLanguage('vue', vue)
hljs.registerLanguage('html', html)
hljs.registerLanguage('css', css)

marked.setOptions({
  breaks: true,
  gfm: true,
})

const renderer = new marked.Renderer()

renderer.code = ({ text, lang }: Tokens.Code): string => {
  const language = lang || 'plaintext'
  let highlighted = text
  try {
    highlighted = hljs.highlight(text, { language: language === 'plaintext' ? 'plaintext' : language }).value
  } catch {
    highlighted = hljs.highlightAuto(text).value
  }
  return `<pre><code class="hljs language-${language}">${highlighted}</code></pre>`
}

renderer.codespan = ({ text }: Tokens.Codespan): string => {
  return `<code>${text}</code>`
}

marked.use({ renderer })

export interface ParsedSegment {
  type: 'text' | 'image' | 'file'
  value: string
  label?: string
}

export function parseContent(text: string): ParsedSegment[] {
  if (!text) return []
  const re = /\[image:([^\]]+)\]|\[file:([^\]]+)\]/g
  const segments: ParsedSegment[] = []
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) segments.push({ type: 'text', value: text.slice(last, m.index) })
    if (m[1]) {
      segments.push({ type: 'image', value: m[1] })
    } else if (m[2]) {
      const fn = m[2].split('/').pop() || 'file'
      segments.push({ type: 'file', value: m[2], label: fn })
    }
    last = re.lastIndex
  }
  if (last < text.length) segments.push({ type: 'text', value: text.slice(last) })
  return segments
}

export function renderMarkdown(text: string): string {
  if (!text) return ''
  try {
    const html = marked.parse(text, { async: false }) as string
    return DOMPurify.sanitize(html)
  } catch {
    return text
  }
}

export function useMarkdownRenderer() {
  return { renderMarkdown, parseContent }
}
