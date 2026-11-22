'use client';
import { DisabledSettingSection } from '../components/setting-disabled-notice'
import { isTauri } from '@/lib/platform/detect'

import { LayoutTemplate } from "lucide-react"
import { SettingTemplate } from "./setting-template";

function TemplatePage() {
  return <SettingTemplate id="template" icon={<LayoutTemplate />} />
}

// Web fork (Fase 1, A30-01): same self-gate as sync/backup
// (S-P0-07, AD-20). The settings dialog already renders the
// disabled marker for this section, but the direct route mounted
// the full upstream page in web mode. The upstream page stays in
// the tree for later phases; desktop behavior is unchanged.
export default function GatedTemplatePage() {
  if (!isTauri()) {
    return <DisabledSettingSection section="template" />
  }
  return <TemplatePage />
}
