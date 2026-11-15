import { parseSyncJson } from '@/lib/sync/remote-file'
import { platform } from '@/lib/platform'
import { secureGet } from './profile'

export interface EncryptedPayload {
  nonce: string
  ciphertext: string
  ciphertextHash: string
  packedCiphertext: string
  packedCiphertextHash: string
}

export function objectAssociatedData(workspaceId: string, objectId: string, kind: string) {
  return `notegen:sync:v1:${workspaceId}:${objectId}:${kind}`
}

export function structuredObjectId(workspaceId: string, domain: string, localKey: string) {
  return platform.invoke.invoke<string>('self_hosted_structured_object_id', { workspaceId, domain, localKey })
}

export async function encryptJson(key: string, value: unknown, associatedData: string) {
  return platform.invoke.invoke<EncryptedPayload>('self_hosted_encrypt', {
    key,
    plaintext: JSON.stringify(value),
    associatedData,
  })
}

export async function decryptJson<T>(
  key: string,
  nonce: string,
  ciphertext: string,
  associatedData: string,
): Promise<T> {
  const plaintext = await platform.invoke.invoke<string>('self_hosted_decrypt', {
    key, nonce, ciphertext, associatedData,
  })
  return parseSyncJson<T>(plaintext, `selfHosted / ${associatedData}`)
}

export function decryptText(
  key: string,
  nonce: string,
  ciphertext: string,
  associatedData: string,
) {
  return platform.invoke.invoke<string>('self_hosted_decrypt', {
    key, nonce, ciphertext, associatedData,
  })
}

export async function decryptPackedJson<T>(
  key: string,
  packedCiphertext: string,
  associatedData: string,
): Promise<T> {
  const plaintext = await platform.invoke.invoke<string>('self_hosted_decrypt_packed', {
    key, packedCiphertext, associatedData,
  })
  return parseSyncJson<T>(plaintext, `selfHosted / ${associatedData}`)
}

export async function loadWorkspaceKey(workspaceId: string, keyVersion: number) {
  const key = await secureGet(`workspace.${workspaceId}.key.${keyVersion}`)
  if (!key) throw new Error(`工作区密钥不可用：${workspaceId} v${keyVersion}`)
  return key
}

export function encodeUtf8Base64Url(value: string) {
  const bytes = new TextEncoder().encode(value)
  let binary = ''
  bytes.forEach(byte => { binary += String.fromCharCode(byte) })
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}
