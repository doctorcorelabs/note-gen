'use client'
import { platform, BaseDirectory } from "@/lib/platform";
import { useEffect, useRef } from 'react';
import type { UnlistenFn } from "@/lib/platform";
import { v4 as uuid } from "uuid";
import useChatStore from "@/stores/chat";
import useTagStore from "@/stores/tag";

export function ClipboardListener() {
  const { insert, chats, loading } = useChatStore()
  const chatsRef = useRef(chats)
  const { currentTagId } = useTagStore()

  async function readHandler() {
    const store = await platform.store.load('store.json')
    const isEnabled = await store.get<boolean>('clipboardMonitor')
    if (!isEnabled) return
    if (loading) return
    const hasImageRes = await platform.clipboard.hasImage()
    const hasTextRes = await platform.clipboard.hasText()

    if (hasImageRes) {
      await handleImage()
    } else if (hasTextRes) {
      await handleText()
    }
  }

  async function handleImage() {
    const isClipboardFolderExists = await platform.fs.exists('clipboard', { baseDir: BaseDirectory.AppData})
    if (!isClipboardFolderExists) {
      await platform.fs.mkdir('clipboard', { baseDir: BaseDirectory.AppData })
    }
    const image = await platform.clipboard.readImageBase64()
    const uint8Array = Uint8Array.from(atob(image), c => c.charCodeAt(0)) || new Uint8Array()
    const path = `clipboard/${uuid()}.png`
    await platform.fs.writeFile(path, uint8Array, { baseDir: BaseDirectory.AppData })
    await platform.clipboard.clear()
    await insert({
      role: 'system',
      content: '',
      type: 'clipboard',
      image: `/${path}`,
      tagId: currentTagId,
      inserted: false
    })
  }

  async function handleText() {
    const text = await platform.clipboard.readText()
    const chatsContent = chatsRef.current.map(item => item.content)
    if (!chatsContent.includes(text)) {
      await insert({
        role: 'system',
        content: text,
        type: 'clipboard',
        tagId: currentTagId,
        inserted: false
      })
    }
  }

  useEffect(() => {
    chatsRef.current = chats;
  }, [chats]); 

  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    
    async function initListen() {
      unlisten = await platform.event.listen('tauri://focus', readHandler)
    }
    initListen()

    return () => {
      if (unlisten) {
        unlisten()
      }
    }
  }, [])

  return <></>
}
