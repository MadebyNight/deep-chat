import { useEffect, useState } from 'react'
import { useTranslate, type TranslationKey } from '../../i18n/index.js'
import { checkForUpdates, dismissUpdate, downloadUpdate, useUpdates } from '../../services/updates.js'
import { Button } from '../base/Button.js'
import { IconChevronRightOutline14 } from '../base/icons.js'
import { Modal } from '../base/Modal.js'
import styles from './Settings.module.css'

const checkMessages: Record<string, TranslationKey> = {
  latest: 'updateLatest',
  unpublished: 'updateUnpublished',
  limited: 'updateLimited',
  network: 'updateNetwork',
  invalid: 'updateInvalid',
  'version-error': 'updateVersionError',
}

export const VersionSetting = ({ showAction = false }: { showAction?: boolean }) => {
  const t = useTranslate()
  const { version, busy } = useUpdates()
  const [message, setMessage] = useState<TranslationKey | null>(null)
  return (
    <>
      <button
        type="button"
        className={styles.settingsLink}
        disabled={busy}
        aria-label={showAction ? t('checkUpdates') : `${t('currentVersion')} ${version ?? ''} · ${t('checkUpdates')}`}
        onClick={async () => {
          setMessage(null)
          await checkForUpdates(true)
          setMessage(checkMessages[useUpdates.getState().status] ?? null)
        }}
      >
        {t(showAction ? 'checkUpdates' : 'currentVersion')}
        {busy || !showAction ? <span>{busy ? t('updateChecking') : version ?? '—'}</span> : null}
        <IconChevronRightOutline14 />
      </button>
      {message ? <p role="status" className={styles.description}>{t(message)}</p> : null}
    </>
  )
}

export const UpdateDialog = ({ allowAutomatic }: { allowAutomatic: boolean }) => {
  const t = useTranslate()
  const { version, release, prompt, status, downloading } = useUpdates()
  const [visible, setVisible] = useState(false)
  useEffect(() => {
    if (prompt !== 'auto' || !allowAutomatic || visible) {
      return
    }
    const check = () => {
      if (
        document.visibilityState === 'visible' &&
        !document.querySelector('[role="dialog"], [role="menu"], [role="listbox"], .keyboard-open') &&
        !document.activeElement?.matches('textarea, input, [contenteditable="true"]')
      ) {
        setVisible(true)
      }
    }
    const observer = new MutationObserver(check)
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'role'] })
    document.addEventListener('visibilitychange', check)
    document.addEventListener('focusout', check)
    check()
    return () => {
      observer.disconnect()
      document.removeEventListener('visibilitychange', check)
      document.removeEventListener('focusout', check)
    }
  }, [allowAutomatic, prompt, visible])

  if (!release || !version || !prompt || (prompt === 'auto' && !visible)) {
    return null
  }
  const close = () => {
    if (!downloading) {
      dismissUpdate()
    }
  }
  return (
    <Modal
      title={t('updateAvailable')}
      className="connection-dialog"
      onClose={close}
      footer={
        <>
          <Button size="m" variant="outlined" disabled={downloading} onClick={close}>{t('updateLater')}</Button>
          <Button size="m" disabled={downloading} onClick={() => void downloadUpdate()}>{t('updateDownload')}</Button>
        </>
      }
    >
      <div className="connection-body">
        <p>{t('updateVersionChange', { current: version, latest: release.version })}</p>
        <p>{t('updateDownloadHint')}</p>
        {status === 'download-error' ? <p role="alert" className="connection-error">{t('updateDownloadError')}</p> : null}
      </div>
    </Modal>
  )
}
