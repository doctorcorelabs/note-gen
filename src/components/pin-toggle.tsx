"use client"

import * as React from "react"
import { Pin, PinOff } from "lucide-react"
import { useTranslations } from 'next-intl'

import { Button } from "@/components/ui/button"
import { platform } from '@/lib/platform';
import { useState, useEffect } from "react";
import emitter from "@/lib/emitter";

export function PinToggle() {
  const t = useTranslations();
  const [isPin, setIsPin] = useState(false)

  useEffect(() => {
    async function loadPinState() {
      const store = await platform.store.load('store.json')
      const pin = await store.get<boolean>('pin')
      setIsPin(!!pin)
    }

    function handlePinChanged(pin: boolean) {
      setIsPin(pin)
    }

    loadPinState()
    emitter.on('window-pin-changed', handlePinChanged)

    return () => {
      emitter.off('window-pin-changed', handlePinChanged)
    }
  }, [])

  async function togglePin() {
    const store = await platform.store.load('store.json')
    const newPinState = !isPin
    setIsPin(newPinState)
    const window = platform.window.getCurrentWindow()
    await window.setAlwaysOnTop(newPinState)
    await store.set('pin', newPinState)
    await store.save()
    emitter.emit('window-pin-changed', newPinState)
  }

  return (
    <Button
      variant="ghost"
      size="icon"
      className="h-8 w-8"
      onClick={togglePin}
      title={isPin ? t('common.unpin') : t('common.pin')}
    >
      {isPin ? <Pin className="h-4 w-4" /> : <PinOff className="h-4 w-4" />}
    </Button>
  )
}
