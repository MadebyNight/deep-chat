import { App } from '@capacitor/app'
import { Browser } from '@capacitor/browser'
import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core'
import { create } from 'zustand'
import { isNative } from './native.js'

export const RELEASES_API = 'https://api.github.com/repos/MadebyNight/deep-chat/releases/latest'
const DOWNLOAD_PATH = '/MadebyNight/deep-chat/releases/download/'
export type AppRelease = { version: string; downloadUrl?: string }
export const usesNativeUpdater = Capacitor.getPlatform() === 'android'
type UpdateProgress = { source: 'GitHub' | 'Gitee'; bytes: number; total: number }
const installer = registerPlugin<{
  check(): Promise<{ version?: string; ready?: boolean }>
  download(options: { version: string }): Promise<void>
  cancel(): Promise<void>
  install(options: { version: string }): Promise<{ needsPermission: boolean }>
  addListener(event: 'progress', callback: (progress: UpdateProgress) => void): Promise<PluginListenerHandle>
}>('UpdateInstaller')

type UpdateStatus = 'idle' | 'checking' | 'latest' | 'available' | 'unpublished' | 'limited' | 'network' | 'invalid' | 'version-error'
class UpdateError extends Error {
  constructor(readonly status: UpdateStatus) {
    super(status)
    this.name = 'UpdateError'
  }
}

const versionParts = (value: string): number[] | null => {
  if (!/^v?(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\.(0|[1-9]\d*))?$/.test(value)) {
    return null
  }
  const parts = value.replace(/^v/, '').split('.').map(Number)
  if (!parts.every(Number.isSafeInteger)) {
    return null
  }
  return [parts[0], parts[1], parts[2] ?? 0]
}
export const compareVersions = (left: string, right: string): number | null => {
  const a = versionParts(left)
  const b = versionParts(right)
  if (!a || !b) {
    return null
  }
  for (let index = 0; index < 3; index++) {
    if (a[index] !== b[index]) {
      return a[index] > b[index] ? 1 : -1
    }
  }
  return 0
}
export const isReleaseDownload = (value: unknown, tag?: string): value is string => {
  if (typeof value !== 'string') {
    return false
  }
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.port || url.username || url.password || url.search || url.hash) {
      return false
    }
    const parts = url.pathname.slice(DOWNLOAD_PATH.length).split('/')
    if (!url.pathname.startsWith(DOWNLOAD_PATH) || parts.length !== 2) {
      return false
    }
    const releaseTag = decodeURIComponent(parts[0])
    const file = decodeURIComponent(parts[1])
    return (tag === undefined || releaseTag === tag) && versionParts(releaseTag) !== null && /^[\w. -]+\.apk$/i.test(file)
  } catch {
    return false
  }
}
export const parseRelease = (value: unknown): AppRelease | null => {
  if (!value || typeof value !== 'object') {
    throw new UpdateError('invalid')
  }
  const release = value as Record<string, unknown>
  if (release.draft === true || release.prerelease === true) {
    return null
  }
  if (release.draft !== false || release.prerelease !== false || typeof release.tag_name !== 'string' || !versionParts(release.tag_name) || !Array.isArray(release.assets)) {
    throw new UpdateError('invalid')
  }
  const tag = release.tag_name
  const assets = release.assets.filter((entry): entry is Record<string, unknown> => {
    if (!entry || typeof entry !== 'object') {
      return false
    }
    const asset = entry as Record<string, unknown>
    return typeof asset.name === 'string' && /\.apk$/i.test(asset.name) && !/(isolated|androidtest|instrumentation|(?:^|[-_.])test(?:[-_.]|$))/i.test(asset.name) && asset.state === 'uploaded' && typeof asset.size === 'number' && asset.size > 0 && isReleaseDownload(asset.browser_download_url, tag)
  })
  const asset = assets.find((entry) => /^deep[-_ ]?chat/i.test(String(entry.name))) ?? (assets.length === 1 ? assets[0] : undefined)
  if (!asset) {
    throw new UpdateError('invalid')
  }
  return {
    version: tag.replace(/^v/, ''),
    downloadUrl: String(asset.browser_download_url),
  }
}

export const useUpdates = create(() => ({
  version: null as string | null,
  status: 'idle' as UpdateStatus,
  busy: false,
  downloading: false,
  installing: false,
  ready: false,
  progress: null as UpdateProgress | null,
  installPermissionNeeded: false,
  actionError: null as 'download' | 'integrity' | 'storage' | 'install' | null,
  release: null as AppRelease | null,
  prompt: null as 'auto' | 'manual' | null,
}))
let versionTask: Promise<string | null> | undefined
export const initializeVersion = () => versionTask ??= (async () => {
  try {
    const version = isNative ? (await App.getInfo()).version : document.querySelector<HTMLMetaElement>('meta[name="application-version"]')?.content
    if (!version || !versionParts(version)) {
      throw new Error('Invalid installed version')
    }
    useUpdates.setState({ version })
    return version
  } catch {
    return null
  }
})()
let checking: Promise<void> | undefined
let manualRequested = false
export const checkForUpdates = (manual = false): Promise<void> => {
  const state = useUpdates.getState()
  if (state.downloading || state.installing) {
    if (manual) { useUpdates.setState({ prompt: 'manual' }) }
    return Promise.resolve()
  }
  manualRequested ||= manual
  if (checking) {
    return checking
  }
  useUpdates.setState({ busy: true, status: 'checking' })
  checking = (async () => {
    try {
      const current = await initializeVersion()
      if (!current) {
        throw new UpdateError('version-error')
      }
      if (usesNativeUpdater) {
        let update: Awaited<ReturnType<typeof installer.check>>
        try {
          update = await installer.check()
        } catch (error) {
          const code = (error as { code?: string } | null)?.code
          throw new UpdateError(code === 'INVALID' ? 'invalid' : code === 'LIMITED' ? 'limited' : 'network')
        }
        const latest = update.version
        const newer = latest !== undefined && compareVersions(latest, current) === 1
        useUpdates.setState({
          status: newer ? 'available' : 'latest',
          release: newer ? { version: latest } : null,
          ready: Boolean(newer && update.ready),
          actionError: null,
          installPermissionNeeded: false,
          prompt: newer ? (manualRequested ? 'manual' : 'auto') : null,
        })
        return
      }
      const response = await fetch(RELEASES_API, {
        headers: { Accept: 'application/vnd.github+json' },
        signal: AbortSignal.timeout(10000),
        cache: 'no-store',
        redirect: 'error',
        credentials: 'omit',
      })
      if (response.status === 404) {
        throw new UpdateError('unpublished')
      }
      if (response.status === 403 || response.status === 429) {
        throw new UpdateError('limited')
      }
      if (!response.ok) {
        throw new UpdateError('network')
      }
      let data: unknown
      try { data = await response.json() } catch { throw new UpdateError('invalid') }
      const release = parseRelease(data)
      const newer = release && compareVersions(release.version, current) === 1
      useUpdates.setState({
        status: newer ? 'available' : 'latest',
        release: newer ? release : null,
        prompt: newer ? (manualRequested ? 'manual' : 'auto') : null,
      })
    } catch (error) {
      useUpdates.setState({ status: error instanceof UpdateError ? error.status : 'network', release: null, prompt: null })
    } finally {
      manualRequested = false
      checking = undefined
      useUpdates.setState({ busy: false })
    }
  })()
  return checking
}
let startupChecked = false
export const initializeUpdates = () => {
  void initializeVersion()
  if (isNative && !startupChecked) {
    startupChecked = true
    void checkForUpdates()
  }
}
export const dismissUpdate = () => useUpdates.setState({ prompt: null })
let cancelRequested = false
export const downloadUpdate = async () => {
  const { release, downloading, ready } = useUpdates.getState()
  if (!release || downloading || ready) {
    return
  }
  cancelRequested = false
  useUpdates.setState({ downloading: true, progress: null, actionError: null })
  let listener: PluginListenerHandle | undefined
  try {
    if (usesNativeUpdater) {
      listener = await installer.addListener('progress', (progress) => useUpdates.setState({ progress }))
      if (cancelRequested) {
        return
      }
      await installer.download({ version: release.version })
      useUpdates.setState({ ready: true })
      return
    }
    if (!isReleaseDownload(release.downloadUrl)) {
      throw new UpdateError('invalid')
    }
    if (isNative) {
      await Browser.open({ url: release.downloadUrl })
    } else {
      const opened = window.open(release.downloadUrl, '_blank', 'noopener,noreferrer')
      if (opened) { opened.opener = null }
    }
    dismissUpdate()
  } catch (error) {
    const code = (error as { code?: string } | null)?.code
    if (code !== 'CANCELLED') {
      useUpdates.setState({ actionError: code === 'INTEGRITY' || code === 'PACKAGE' ? 'integrity' : code === 'STORAGE' ? 'storage' : 'download' })
    }
  } finally {
    await listener?.remove().catch(() => undefined)
    useUpdates.setState({ downloading: false, progress: null })
  }
}

export const cancelUpdateDownload = async () => {
  if (usesNativeUpdater && useUpdates.getState().downloading) {
    cancelRequested = true
    await installer.cancel().catch(() => undefined)
  }
}

export const installUpdate = async () => {
  const { release, ready, installing } = useUpdates.getState()
  if (!usesNativeUpdater || !release || !ready || installing) {
    return
  }
  useUpdates.setState({ installing: true, actionError: null })
  try {
    const { needsPermission } = await installer.install({ version: release.version })
    useUpdates.setState({ installPermissionNeeded: needsPermission })
  } catch (error) {
    const missing = (error as { code?: string } | null)?.code === 'MISSING'
    useUpdates.setState({ actionError: missing ? 'download' : 'install', ready: !missing })
  } finally {
    useUpdates.setState({ installing: false })
  }
}
