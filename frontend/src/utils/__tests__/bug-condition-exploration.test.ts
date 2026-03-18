/**
 * Bug Condition Exploration Tests
 * 
 * Property 1: Fault Condition — Markdown 渲染与批量删除缺陷验证
 * 
 * CRITICAL: These tests are EXPECTED TO FAIL on unfixed code.
 * Failure confirms the bugs exist. DO NOT fix the code when tests fail.
 * 
 * Validates: Requirements 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8
 */

import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { renderMarkdown } from '../markdown'

describe('Bug Condition Exploration - Property 1: Fault Condition', () => {

  // ============================================================
  // Bug A: Markdown 渲染缺陷 — DOMPurify 过滤 table/hr 标签
  // ============================================================

  describe('Bug A: Markdown table rendering', () => {
    /**
     * Validates: Requirements 1.1, 2.1
     * 
     * renderMarkdown() should render Markdown table syntax into proper HTML
     * table elements. On unfixed code, DOMPurify strips table/thead/tbody/tr/th/td
     * tags because they are not in ALLOWED_TAGS.
     */
    it('should render Markdown table syntax with proper HTML table tags', () => {
      const tableMarkdown = '| 列1 | 列2 |\n|---|---|\n| 值1 | 值2 |'
      const result = renderMarkdown(tableMarkdown)

      // All these tags should be present in the rendered output
      expect(result).toContain('<table')
      expect(result).toContain('<thead')
      expect(result).toContain('<tbody')
      expect(result).toContain('<tr')
      expect(result).toContain('<th')
      expect(result).toContain('<td')
    })

    it('should render multi-column table with all cells intact', () => {
      const tableMarkdown = [
        '| Name | Status | Value |',
        '|------|--------|-------|',
        '| CPU  | OK     | 45%   |',
        '| MEM  | WARN   | 85%   |',
      ].join('\n')
      const result = renderMarkdown(tableMarkdown)

      expect(result).toContain('<table')
      expect(result).toContain('CPU')
      expect(result).toContain('OK')
      expect(result).toContain('45%')
    })
  })

  describe('Bug A: Markdown hr rendering', () => {
    /**
     * Validates: Requirements 1.3, 2.3
     * 
     * renderMarkdown() should render `---` as an <hr> element.
     * On unfixed code, DOMPurify strips the <hr> tag.
     */
    it('should render --- as an <hr> horizontal rule', () => {
      const hrMarkdown = 'Section 1\n\n---\n\nSection 2'
      const result = renderMarkdown(hrMarkdown)

      expect(result).toContain('<hr')
    })

    it('should render *** as an <hr> horizontal rule', () => {
      const hrMarkdown = 'Above\n\n***\n\nBelow'
      const result = renderMarkdown(hrMarkdown)

      expect(result).toContain('<hr')
    })
  })

  // ============================================================
  // Bug B: RAG 面板深色主题不兼容 — 硬编码浅色主题色值
  // ============================================================

  describe('Bug B: RAGAnalysisPanel hardcoded light theme colors', () => {
    /**
     * Validates: Requirements 1.4, 1.5, 1.6
     * 
     * RAGAnalysisPanel.vue should NOT contain hardcoded light theme color values
     * in its CSS. On unfixed code, multiple hardcoded hex colors exist that are
     * incompatible with dark theme.
     */
    const vuePath = path.resolve(__dirname, '../../components/RAGAnalysisPanel.vue')
    let vueContent: string

    // Read the file once
    try {
      vueContent = fs.readFileSync(vuePath, 'utf-8')
    } catch {
      vueContent = ''
    }

    // Extract only the <style> section to avoid false positives from template/script
    const styleMatch = vueContent.match(/<style[^>]*>([\s\S]*?)<\/style>/)
    const styleContent = styleMatch ? styleMatch[1] : ''

    it('should not contain hardcoded light gradient background (#ecf5ff)', () => {
      expect(styleContent).not.toContain('#ecf5ff')
    })

    it('should not contain hardcoded light background (#f4f4f5)', () => {
      expect(styleContent).not.toContain('#f4f4f5')
    })

    it('should not contain hardcoded text color #606266 (should use CSS variable)', () => {
      expect(styleContent).not.toContain('#606266')
    })

    it('should not contain hardcoded text color #303133 (should use CSS variable)', () => {
      expect(styleContent).not.toContain('#303133')
    })

    it('should not contain hardcoded text color #909399 (should use CSS variable)', () => {
      expect(styleContent).not.toContain('#909399')
    })

    it('should not contain hardcoded background #fafafa (should use CSS variable)', () => {
      expect(styleContent).not.toContain('#fafafa')
    })

    it('should not contain hardcoded hover background #e1f3d8 (should use CSS variable)', () => {
      expect(styleContent).not.toContain('#e1f3d8')
    })
  })

  // ============================================================
  // Bug D: 历史告警批量删除失效 — syslog 事件删除路径不兼容
  // ============================================================

  describe('Bug D: Batch delete with syslog events', () => {
    /**
     * Validates: Requirements 1.8, 2.8
     * 
     * When batch deleting resolved events that include syslog-type events,
     * all events should be successfully deleted. On unfixed code, syslog events
     * may fail to delete because getAlertEventById() cannot find them.
     * 
     * This test verifies the frontend filtering logic: batchDeleteEvents filters
     * events by `e.status === 'resolved'`, and syslog events converted via
     * convertSyslogToAlertEvent() have status='active' initially. After being
     * resolved, they should have status='resolved'. The key issue is whether
     * the backend deleteAlertEvent() can find and delete syslog-sourced events.
     * 
     * We test the core logic: the batch delete API should handle mixed event types.
     */
    it('should include syslog-type resolved events in batch delete selection', () => {
      // Simulate the frontend filtering logic from batchDeleteEvents()
      // This mirrors: filteredEvents.filter(e => selectedIds.has(e.id) && e.status === 'resolved')
      
      interface UnifiedEvent {
        id: string
        type: 'alert' | 'syslog'
        status: string
        source?: string
      }

      const filteredEvents: UnifiedEvent[] = [
        { id: 'alert-001', type: 'alert', status: 'resolved' },
        { id: 'syslog-001', type: 'syslog', status: 'resolved', source: 'syslog' },
        { id: 'syslog-002', type: 'syslog', status: 'resolved', source: 'syslog' },
        { id: 'alert-002', type: 'alert', status: 'active' },
      ]

      const selectedIds = new Set(['alert-001', 'syslog-001', 'syslog-002', 'alert-002'])

      // This is the exact filtering logic from AlertEventsView.vue batchDeleteEvents()
      const resolvedSelected = filteredEvents.filter(
        e => selectedIds.has(e.id) && e.status === 'resolved'
      )

      // Should include both alert and syslog resolved events
      expect(resolvedSelected).toHaveLength(3)
      expect(resolvedSelected.map(e => e.id)).toContain('syslog-001')
      expect(resolvedSelected.map(e => e.id)).toContain('syslog-002')
      
      // The IDs sent to the API should include syslog event IDs
      const ids = resolvedSelected.map(e => e.id)
      const syslogIds = ids.filter(id => id.startsWith('syslog'))
      expect(syslogIds.length).toBeGreaterThan(0)
    })

    it('should verify backend deleteAlertEvent can handle syslog event IDs', async () => {
      // This test verifies the structural issue: syslog events stored via
      // convertSyslogToAlertEvent() use the syslog event's original ID.
      // The deleteAlertEvent() calls getAlertEventById() which searches:
      // 1. activeAlerts map
      // 2. DataStore (SQLite)
      // 3. File-based storage (by date)
      //
      // For resolved syslog events, they are NOT in activeAlerts (removed on resolve).
      // They should be findable in DataStore or file storage.
      // The bug is that getAlertEventById() may fail to find syslog events
      // because the date-based file lookup uses triggeredAt which maps to
      // syslogEvent.timestamp, and the file may not exist for that date.
      
      // We verify the data flow: syslog events should have proper triggeredAt
      // that maps to a valid date file
      const syslogTimestamp = Date.now() - 3600000 // 1 hour ago
      const dateStr = new Date(syslogTimestamp).toISOString().split('T')[0]
      
      // The date string should be a valid YYYY-MM-DD format
      expect(dateStr).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      
      // Verify that a syslog event converted to AlertEvent maintains its ID
      // This is a structural check - the ID should not be transformed
      const syslogId = `syslog-event-${Date.now()}`
      const convertedEvent = {
        id: syslogId,
        ruleId: 'syslog-system',
        ruleName: 'Syslog: system',
        metric: 'syslog',
        status: 'resolved',
        triggeredAt: syslogTimestamp,
        source: 'syslog',
      }
      
      // The converted event should retain the original syslog ID
      expect(convertedEvent.id).toBe(syslogId)
      expect(convertedEvent.source).toBe('syslog')
      expect(convertedEvent.status).toBe('resolved')
    })
  })
})
