// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

// Revised profile 9.5 (W4-FLOWS, AD-120 Q3): ONE authenticated run
// measuring the shell in BOTH modes (en + zh) through the working
// backend harness. The literal 9.5 criteria were revised to use
// the backend harness; the literal form must NEVER again be read
// as an i18n verdict. This spec provides the run plus evidence;
// the literal-vs-enkey adjudication (Q3b) belongs to the closing
// gate after FLOWS, not to this spec.
//
// What this spec asserts: boot mechanics ONLY (redirect to
// /core/main, file tree visible, seed note opens, Settings dialog
// opens through the test-id opener). What it MEASURES without
// gating: the 12 + 12 locale markers from the Fase 0 inventory,
// CJK character counts, and per-surface captures (shell, editor,
// Settings), written as JSON plus body text plus screenshots into
// testInfo.outputDir. A marker miss is data for the closing gate,
// never a failure here.
//
// What it does NOT attempt: the sync dialog surface (finding T-6:
// no harness trigger exists in web mode, and the surface is
// proposed for removal from the revised 9.5; see the W4-FLOWS
// report). The guard screen is intentionally English (finding T-7
// proposal); this spec measures the authenticated shell, not the
// guard.
//
// T-8 fix embodied here: navigation uses AppPage.gotoHome with the
// REQUIRED fixture gateway origin (backend.pageUrl). The W4-I18N
// scratch spec called gotoHome() with no origin, which resolved
// against the static-only config baseURL and always landed on the
// guard screen; that wrong-origin navigation was the entire T-8
// failure, reproduced verbatim by W4-FLOWS before the signature
// change. The tree starts collapsed, so the editor surface expands
// the notes folder before opening the seed note.
//
// Tag: @i18n-profile. Run with:
//   pnpm exec playwright test tests/e2e/i18n-profile.spec.ts --grep @i18n-profile

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { backendTest, expect } from './harness/backend-fixture'
import { AppPage } from './harness/app-page'
import { settingsDialog, settingsOpenerButton } from './harness/selectors'
import { SEARCH_TERMS } from './harness/seed-data'
import type { Page, TestInfo } from '@playwright/test'

const EN_MARKERS = [
  'Capture first, organize later',
  'Getting started',
  'Create Note',
  'Create Record',
  'Global Search',
  'Quick actions',
  'Open Workspace',
  'Start chatting with AI',
  'Quick start',
  'Help me write a note',
  'New Tab',
  'Create your first record',
]

const ZH_MARKERS = [
  '先记录，再整理',
  '新手引导',
  '创建笔记',
  '创建记录',
  '全局搜索',
  '快捷入口',
  '打开工作区',
  '开始与 AI 对话',
  '快速开始',
  '帮我写一篇笔记',
  '新标签页',
  '创建第一条记录',
]

interface SurfaceCapture {
  bodyTextLength: number
  enFound: string[]
  enMissing: string[]
  zhFound: string[]
  cjkCharCount: number
  cjkLines: string[]
}

function captureSurface(bodyText: string): SurfaceCapture {
  const cjkRe = /[一-鿿]/g
  return {
    bodyTextLength: bodyText.length,
    enFound: EN_MARKERS.filter((marker) => bodyText.includes(marker)),
    enMissing: EN_MARKERS.filter((marker) => !bodyText.includes(marker)),
    zhFound: ZH_MARKERS.filter((marker) => bodyText.includes(marker)),
    cjkCharCount: (bodyText.match(cjkRe) ?? []).length,
    cjkLines: [
      ...new Set(
        bodyText
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => /[一-鿿]/.test(line)),
      ),
    ],
  }
}

async function runProfile(
  page: Page,
  pageUrl: string,
  mode: 'en' | 'zh',
  testInfo: TestInfo,
): Promise<void> {
  testInfo.setTimeout(300_000)
  const consoleLines: string[] = []
  page.on('console', (message) => {
    consoleLines.push(`[${message.type()}] ${message.text()}`)
  })
  page.on('pageerror', (error) => {
    consoleLines.push(`[pageerror] ${String(error)}`)
  })
  if (mode === 'zh') {
    await page.context().addInitScript(() => {
      window.localStorage.setItem('app-language', 'zh')
    })
  }
  const app = new AppPage(page)
  const startedAt = new Date().toISOString()
  await app.gotoHome(pageUrl)
  await app.expectBooted()
  const shellText = await page.locator('body').innerText()
  const shell = captureSurface(shellText)
  const probe = await page.evaluate(() => ({
    appLanguage: window.localStorage.getItem('app-language'),
    htmlLang: document.documentElement.getAttribute('lang'),
    url: window.location.href,
  }))
  await page.screenshot({ path: join(testInfo.outputDir, `${mode}-auth-shell.png`) })
  writeFileSync(join(testInfo.outputDir, `${mode}-auth-shell-body.txt`), shellText)

  await app.expandFolderByName('notes')
  await app.openFileByName(SEARCH_TERMS.uniqueTermFileName)
  await expect(page.locator('body')).toContainText(SEARCH_TERMS.uniqueTerm, { timeout: 30_000 })
  const editorText = await page.locator('body').innerText()
  const editor = captureSurface(editorText)
  await page.screenshot({ path: join(testInfo.outputDir, `${mode}-auth-editor.png`) })
  writeFileSync(join(testInfo.outputDir, `${mode}-auth-editor-body.txt`), editorText)

  await settingsOpenerButton(page).click()
  const dialog = page.getByRole('dialog').first()
  await expect(dialog).toBeVisible({ timeout: 10_000 })
  const settingsText = await dialog.innerText()
  const settingsCapture = captureSurface(settingsText)
  const namedDialogCount = await settingsDialog(page).count()
  await page.screenshot({ path: join(testInfo.outputDir, `${mode}-auth-settings.png`) })
  writeFileSync(join(testInfo.outputDir, `${mode}-auth-settings-body.txt`), settingsText)

  const summary = {
    tag: `w4flows-${mode}-auth`,
    mode: mode === 'en' ? 'fresh-en-auth' : 'seeded-zh-auth',
    startedAt,
    url: probe.url,
    appLanguage: probe.appLanguage,
    htmlLang: probe.htmlLang,
    shell,
    editor,
    settings: {
      openedViaTestId: true,
      namedDialogCount,
      capture: settingsCapture,
    },
    consoleLines: consoleLines.slice(0, 40),
    consoleTotal: consoleLines.length,
  }
  writeFileSync(
    join(testInfo.outputDir, `${mode}-auth-summary.json`),
    JSON.stringify(summary, null, 2),
  )
}

backendTest(
  'I18N-9.5-EN @i18n-profile authenticated en: shell + editor + settings measurement',
  async ({ backend, page }, testInfo) => {
    await runProfile(page, backend.pageUrl, 'en', testInfo)
  },
)

backendTest(
  'I18N-9.5-ZH @i18n-profile authenticated zh: shell + editor + settings measurement',
  async ({ backend, page }, testInfo) => {
    await runProfile(page, backend.pageUrl, 'zh', testInfo)
  },
)
