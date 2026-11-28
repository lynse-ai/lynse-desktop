import * as React from 'react'
import { cn } from '@lynse/ui/lib/utils'
import { Markdown, type RenderMode } from './Markdown'
import { completeStreamingMarkdown } from './complete-streaming-markdown'

export interface StreamingMarkdownProps {
  content: string
  isStreaming: boolean
  mode?: RenderMode
  className?: string
  onUrlClick?: (url: string) => void
  onFileClick?: (path: string) => void
  renderMention?: (props: { type: string; id: string }) => React.ReactNode
  cdnDomain?: string
}

interface Block {
  content: string
  closingFence?: string
  completionStart?: number
}

interface CodeFence {
  indent: string
  marker: string
}

type ListKind = 'unordered' | 'ordered'

const CODE_FENCE_OPEN_RE = /^([ \t]*)(`{3,}|~{3,})/
const UNORDERED_LIST_ITEM_RE = /^[ \t]*[-*+][ \t]+/
const ORDERED_LIST_ITEM_RE = /^[ \t]*\d+[.)][ \t]+/
const INDENTED_CONTINUATION_RE = /^(?:[ \t]{2,}|\t)\S/
const REF_DEF_RE = /^[ \t]*\[[^\]]+\]:[ \t]*\S/

function isPipeTableRow(line: string): boolean {
  return line.trimStart().startsWith('|')
}

function isGfmTableSeparator(line: string): boolean {
  return /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line)
}

function startsGfmTable(lines: string[], index: number): boolean {
  return isPipeTableRow(lines[index] ?? '') && isGfmTableSeparator(lines[index + 1] ?? '')
}

function listKindOfLine(line: string): ListKind | null {
  if (UNORDERED_LIST_ITEM_RE.test(line)) return 'unordered'
  if (ORDERED_LIST_ITEM_RE.test(line)) return 'ordered'
  return null
}

function parseCodeFenceOpen(line: string): CodeFence | null {
  const match = CODE_FENCE_OPEN_RE.exec(line)
  if (!match?.[2]) return null
  return { indent: match[1] ?? '', marker: match[2] }
}

function isMatchingCodeFenceClose(line: string, fence: CodeFence): boolean {
  const trimmed = line.trim()
  if (trimmed.length < fence.marker.length) return false
  for (let i = 0; i < trimmed.length; i += 1) {
    if (trimmed[i] !== fence.marker[0]) return false
  }
  return true
}

function hasReferenceDefinitions(content: string): boolean {
  const lines = content.split('\n')
  let codeFence: CodeFence | null = null
  for (const line of lines) {
    if (codeFence) {
      if (isMatchingCodeFenceClose(line, codeFence)) codeFence = null
      continue
    }
    const open = parseCodeFenceOpen(line)
    if (open) {
      codeFence = open
      continue
    }
    if (REF_DEF_RE.test(line)) return true
  }
  return false
}

function normalizeGfmTableBoundaries(content: string): string {
  const lines = content.split('\n')
  const normalizedLines: string[] = []
  let codeFence: CodeFence | null = null
  let inMathBlock = false

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''

    if (codeFence) {
      if (isMatchingCodeFenceClose(line, codeFence)) codeFence = null
      normalizedLines.push(line)
      continue
    }

    if (!inMathBlock) {
      const open = parseCodeFenceOpen(line)
      if (open) {
        codeFence = open
        normalizedLines.push(line)
        continue
      }
    }

    if (line.trim() === '$$') {
      inMathBlock = !inMathBlock
      normalizedLines.push(line)
      continue
    }

    if (!inMathBlock && startsGfmTable(lines, i)) {
      normalizedLines.push(line)
      i += 1
      while (i < lines.length && isPipeTableRow(lines[i] ?? '')) {
        normalizedLines.push(lines[i] ?? '')
        i += 1
      }
      if (i < lines.length && (lines[i] ?? '') !== '') {
        normalizedLines.push('')
      }
      i -= 1
      continue
    }

    normalizedLines.push(line)
  }

  return normalizedLines.join('\n')
}

/**
 * Split content into top-level Markdown blocks (paragraphs, lists, tables,
 * fenced code blocks, display math blocks).
 *
 * Loose lists (list items separated by blank lines) stay in a single block so
 * ordered numbering and list indentation remain continuous during and after
 * streaming.
 */
function splitIntoBlocks(content: string): Block[] {
  const blocks: Block[] = []
  const lines = content.split('\n')
  let blockLines: string[] = []
  let currentListKind: ListKind | null = null
  let codeFence: CodeFence | null = null
  let lastFenceEnd = 0
  let inMathBlock = false

  const flushCurrent = (): void => {
    const raw = blockLines.join('\n')
    if (raw.trim()) {
      blocks.push({
        content: codeFence || inMathBlock ? raw : raw.trimEnd(),
        closingFence: codeFence ? codeFence.indent + codeFence.marker : undefined,
        completionStart: lastFenceEnd > 0 ? blockLines.slice(0, lastFenceEnd).join('\n').length + 1 : undefined
      })
    }
    blockLines = []
    currentListKind = null
    lastFenceEnd = 0
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    const isBlank = line.trim() === ''
    const isListContinuation = currentListKind !== null && INDENTED_CONTINUATION_RE.test(line)

    if (codeFence) {
      if (currentListKind !== null && !isBlank && !isListContinuation) {
        // A dedent ends an unclosed fence inside a list item.
        codeFence = null
        lastFenceEnd = blockLines.length
      } else {
        blockLines.push(line)
        if (isMatchingCodeFenceClose(line, codeFence)) {
          codeFence = null
          lastFenceEnd = blockLines.length
          if (currentListKind === null) flushCurrent()
        }
        continue
      }
    }

    if (inMathBlock) {
      blockLines.push(line)
      if (line.trim() === '$$') {
        inMathBlock = false
        flushCurrent()
      }
      continue
    }

    const openFence = parseCodeFenceOpen(line)
    if (openFence) {
      if (!isListContinuation) flushCurrent()
      codeFence = openFence
      blockLines.push(line)
      continue
    }

    // Indented children belong to the list's Markdown parse, including
    // tables and display math which would otherwise be split out below.
    if (isListContinuation) {
      blockLines.push(line)
      continue
    }

    if (line.trim() === '$$') {
      flushCurrent()
      inMathBlock = true
      blockLines.push(line)
      continue
    }

    // Keep a complete GFM table in its own Markdown block so prose arriving
    // right after the last row is never reparsed as part of the table.
    if (startsGfmTable(lines, i)) {
      flushCurrent()
      const tableLines = [line]
      i += 1
      while (i < lines.length && isPipeTableRow(lines[i] ?? '')) {
        tableLines.push(lines[i] ?? '')
        i += 1
      }
      blocks.push({ content: tableLines.join('\n') })
      i -= 1
      continue
    }

    if (isBlank) {
      // Preserve loose lists across blank lines so ordered numbering and nested
      // continuations do not reset during streaming.
      if (currentListKind !== null) {
        let nextIdx = i + 1
        while (nextIdx < lines.length && (lines[nextIdx] ?? '').trim() === '') {
          nextIdx += 1
        }
        const nextLine = nextIdx < lines.length ? (lines[nextIdx] ?? '') : ''
        const nextKind = listKindOfLine(nextLine)
        const continuesList = nextKind === currentListKind || INDENTED_CONTINUATION_RE.test(nextLine)
        if (continuesList) {
          blockLines.push(line)
          continue
        }
      }
      flushCurrent()
      continue
    }

    blockLines.push(line)
    currentListKind ??= listKindOfLine(line)
  }

  flushCurrent()

  return blocks
}

/**
 * Memoized block component
 *
 * Only re-renders if content or render mode changes. Rendered with `bare`
 * inside a single outer `.markdown-content` wrapper so streaming and finished
 * states share the exact same DOM structure and CSS child selectors.
 */
const MemoizedBlock = React.memo(
  function Block({
    content,
    mode,
    onUrlClick,
    onFileClick,
    renderMention,
    cdnDomain
  }: {
    content: string
    mode: RenderMode
    onUrlClick?: (url: string) => void
    onFileClick?: (path: string) => void
    renderMention?: (props: { type: string; id: string }) => React.ReactNode
    cdnDomain?: string
  }) {
    return (
      <Markdown
        bare
        mode={mode}
        onUrlClick={onUrlClick}
        onFileClick={onFileClick}
        renderMention={renderMention}
        cdnDomain={cdnDomain}
      >
        {content}
      </Markdown>
    )
  },
  (prev, next) => {
    return (
      prev.content === next.content &&
      prev.mode === next.mode &&
      prev.cdnDomain === next.cdnDomain
    )
  }
)
MemoizedBlock.displayName = 'MemoizedBlock'

/**
 * StreamingMarkdown - Unified, flicker-free Markdown renderer for streaming
 * and completed assistant replies.
 *
 * Keeps a single `.markdown-content` wrapper and stable block keys across the
 * entire lifecycle (`isStreaming: true → false`), so completed blocks never
 * unmount/remount or shift spacing when a reply finishes. While streaming, the
 * trailing active block runs through `completeStreamingMarkdown` so bold,
 * inline code, links, tables, and code fences format live as text arrives.
 */
export function StreamingMarkdown({
  content,
  isStreaming,
  mode = 'minimal',
  className,
  onUrlClick,
  onFileClick,
  renderMention,
  cdnDomain
}: StreamingMarkdownProps): React.JSX.Element {
  const normalizedContent = React.useMemo(
    () => normalizeGfmTableBoundaries(content),
    [content]
  )

  const blocks = React.useMemo(() => {
    if (!normalizedContent.trim()) return []
    // Documents with reference-style link or footnote definitions need a single
    // parse pass so usages resolve against their definitions across blocks.
    if (hasReferenceDefinitions(normalizedContent)) {
      return [{ content: normalizedContent }]
    }
    return splitIntoBlocks(normalizedContent)
  }, [normalizedContent])

  if (blocks.length === 0) {
    return <></>
  }

  return (
    <div className={cn('markdown-content break-words', className)}>
      {blocks.map((block, i) => {
        let blockContent = block.content
        if (isStreaming && i === blocks.length - 1) {
          if (block.closingFence) {
            const newline = blockContent.endsWith('\n') ? '' : '\n'
            blockContent += newline + block.closingFence
          } else {
            // Inline markers in a closed fence are code. Repair only the
            // text that followed it within this block.
            const start = block.completionStart ?? 0
            blockContent = blockContent.slice(0, start) + completeStreamingMarkdown(blockContent.slice(start))
          }
        }

        return (
          <MemoizedBlock
            key={i}
            content={blockContent}
            mode={mode}
            onUrlClick={onUrlClick}
            onFileClick={onFileClick}
            renderMention={renderMention}
            cdnDomain={cdnDomain}
          />
        )
      })}
    </div>
  )
}
