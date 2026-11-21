'use client'

import { useCallback, useEffect, useState } from 'react'

import { loadActivityCalendarData } from '@/lib/activity'
import type { ActivityCalendarData, ActivityDaySummary } from '@/lib/activity/types'

export function useActivityData(active = true) {
  const [data, setData] = useState<ActivityCalendarData | null>(null)
  const [selectedDay, setSelectedDay] = useState<ActivityDaySummary | undefined>(undefined)
  // DA-2 (ACT-06): start in the loading state when active so the
  // first render never flashes the "empty" text before the effect
  // runs.
  const [loading, setLoading] = useState(active)
  // DA-2 (BUG-08): a failed load is an explicit error state, not
  // an empty calendar.
  const [error, setError] = useState<unknown>(null)
  const [reloadCount, setReloadCount] = useState(0)
  const reload = useCallback(() => setReloadCount(count => count + 1), [])

  useEffect(() => {
    if (!active) return
    let disposed = false
    setLoading(true)
    setError(null)
    void loadActivityCalendarData().then(nextData => {
      if (disposed) return
      setData(nextData)
      const today = nextData.days.find(day => day.day === nextData.endDate)
      const fallback = [...nextData.days].reverse().find(day => day.totalCount > 0)
      setSelectedDay(today || fallback)
    }).catch(loadError => {
      if (disposed) return
      console.error('Failed to load activity data:', loadError)
      setError(loadError)
    }).finally(() => {
      if (!disposed) setLoading(false)
    })
    return () => { disposed = true }
  }, [active, reloadCount])

  return { data, selectedDay, setSelectedDay, loading, error, reload }
}
