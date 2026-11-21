'use client'

import { useTranslations } from 'next-intl'
import React from "react"
import { TagManage } from './tag-manage'
import { MarkList } from './mark-list'
import useMarkStore from "@/stores/mark"
import { Button } from "@/components/ui/button"
import { clearTrash } from "@/db/marks"
import { platform } from '@/lib/platform';
import emitter from '@/lib/emitter'
import { EmitterRecordEvents } from '@/config/emitters'
import { toast } from 'sonner'
import { filterMarks, getTrashRecordFilters } from "./mark-filters";

export function NoteSidebar() {
  const t = useTranslations();
  const { trashState, marks, setMarks, fetchMarks, fetchAllTrashMarks } = useMarkStore()
  const visibleTrashMarks = React.useMemo(() => filterMarks(marks, getTrashRecordFilters()), [marks])

  // BUG-04: this sidebar reads the mark store, which the
  // upstream completion path refreshes itself, but WebInbox
  // mutations never touched the store. Refetch on the shared
  // refreshMarks event (same mechanism tag-manage uses).
  React.useEffect(() => {
    const refresh = () => {
      void (trashState ? fetchAllTrashMarks() : fetchMarks())
    }
    emitter.on(EmitterRecordEvents.refreshMarks, refresh)
    return () => { emitter.off(EmitterRecordEvents.refreshMarks, refresh) }
  }, [trashState, fetchMarks, fetchAllTrashMarks])

  async function handleClearTrash() {
    const res = await platform.dialog.confirm(`${t('record.trash.confirm')}\n${t('record.trash.syncWarning')}`, {
      title: t('record.trash.title'),
      kind: 'warning',
    })
    if (res) {
      try {
        await clearTrash()
      } catch {
        toast.error(t('record.trash.emptyFailed'))
        return
      }
      setMarks([])
      emitter.emit(EmitterRecordEvents.refreshMarks)
    }
  }

  return (
    <div id="record-sidebar" className="flex h-full min-h-0 w-full flex-col">
      {trashState ? (
        <>
          <div className="flex p-2 border-b items-center justify-between">
            <p className="text-xs text-zinc-500">{t('record.trash.records', { count: visibleTrashMarks.length })}</p>
            {marks.length > 0 && (
              <Button variant="ghost" size="sm" onClick={handleClearTrash}>
                {t('record.trash.empty')}
              </Button>
            )}
          </div>
          <MarkList />
        </>
      ) : (
        <div className="min-h-0 flex-1 overflow-hidden">
          <TagManage />
        </div>
      )}
    </div>
  )
}
