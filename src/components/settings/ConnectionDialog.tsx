import { useEffect, useState } from 'react'
import { useSettings } from '../../services/settings.js'
import { useTranslate } from '../../i18n/index.js'
import {
  closeConnection, connect, openConnection, pasteAndConnect, refreshBalance,
  removeConnection, useConnection, visitOfficial,
} from '../../services/connection.js'
import { Modal } from '../base/Modal.js'
import { Button } from '../base/Button.js'

export const ConnectionSetting = () => {
  const t = useTranslate()
  const connected = useSettings(state => !!state.apiKey)
  return <div className="connection-setting">
    <div><strong>{t('connectionTitle')}</strong><p>{connected ? t('connectionSettingSaved') : t('connectionSettingHint')}</p></div>
    <Button variant="outlined" onClick={() => { openConnection(); if (connected) { void refreshBalance() } }}>
      {connected ? t('connectionManage') : t('connectionConnect')}
    </Button>
  </div>
}

export const ConnectionDialog = () => {
  const { open } = useConnection()
  return open ? <ConnectionContent /> : null
}
const ConnectionContent = () => {
  const t = useTranslate()
  const { step, balance, busy, error } = useConnection()
  const connected = useSettings(state => !!state.apiKey)
  const [value, setValue] = useState('')
  const [removing, setRemoving] = useState(false)
  useEffect(() => {
    if (step === 'balance' && connected) {
      void refreshBalance()
    }
  }, [step, connected])
  return <Modal title={t('connectionTitle')} closable onClose={closeConnection} className="connection-dialog">
    <div className="connection-body" aria-busy={busy}>
      <div className="connection-identity">{t('connectionIdentity')}</div>
      {step === 'start' ? <>
        <h2>{t('connectionStartTitle')}</h2>
        <p>{t('connectionStartDesc1')}</p>
        <p>{t('connectionStartDesc2')}</p>
        <Button size="l" onClick={() => void visitOfficial('keys')}>{t('connectionUseAccount')}</Button>
        <Button variant="outlined" size="l" onClick={() => useConnection.setState({ step: 'paste', error: '' })}>{t('connectionHaveKey')}</Button>
      </> : step === 'paste' ? <>
        <h2>{t('connectionPasteTitle')}</h2>
        <p>{t('connectionPasteDesc')}</p>
        <Button size="l" disabled={busy} onClick={() => void pasteAndConnect()}>{busy ? t('connectionPasteBusy') : t('connectionPasteButton')}</Button>
        <label htmlFor="connection-secret">{t('connectionManualLabel')}</label>
        <input id="connection-secret" type="password" autoComplete="off" autoCapitalize="none" spellCheck={false}
          value={value} disabled={busy} placeholder={t('connectionManualPlaceholder')} onChange={event => setValue(event.target.value)} />
        <Button disabled={busy || !value.trim()} variant="outlined" onClick={async () => { const text = value; setValue(''); await connect(text) }}>{t('connectionConnect')}</Button>
        <Button variant="outlined" disabled={busy} onClick={() => void visitOfficial('keys')}>{t('connectionOpenKeysPage')}</Button>
        <p className="connection-note">{t('connectionPrivacyNote')}</p>
      </> : <>
        <h2>{!connected ? t('connectionStatusNotConnected') : balance ? balance.is_available ? t('connectionStatusConnected') : t('connectionStatusInsufficient') : t('connectionStatusQuerying')}</h2>
        {balance ? <div className="connection-balance">
          {balance.balance_infos.map((item, index) => <div key={`${item.currency}-${index}`}>
            <span>{t('connectionBalanceLabel', { currency: item.currency })}</span><strong>{item.total_balance}</strong>
          </div>)}
        </div> : <p>{t('connectionBalanceUnknown')}</p>}
        {balance && !balance.is_available ? <>
          <p>{t('connectionTopupDesc')}</p>
          <Button disabled={busy} onClick={() => void visitOfficial('topup')}>{t('connectionTopupButton')}</Button>
        </> : null}
        <Button disabled={busy || !connected} variant="outlined" onClick={() => void refreshBalance(true)}>{busy ? t('connectionRefreshBusy') : t('connectionRefresh')}</Button>
        <Button disabled={busy} variant="outlined" onClick={closeConnection}>{t('connectionBackToChat')}</Button>
        <Button disabled={busy} variant="outlined" onClick={() => useConnection.setState({ step: 'paste', error: '' })}>{t('connectionChangeKey')}</Button>
        {removing ? <div role="alert"><p>{t('connectionRemoveConfirmTitle')}</p><p>{t('connectionRemoveConfirmDesc')}</p>
          <Button disabled={busy} variant="dangerOutlined" onClick={async () => {
            try { await removeConnection(); setRemoving(false) }
            catch { useConnection.setState({ error: t('connectionErrorRemoveFailed') }) }
          }}>{t('connectionRemoveConfirm')}</Button></div> : <Button disabled={busy || !connected} variant="outlined" onClick={() => setRemoving(true)}>{t('connectionRemove')}</Button>}
      </>}
      {error ? <p role="alert" className="connection-error">{error}</p> : null}
      <p className="connection-note">{t('connectionFooterNote')}</p>
    </div>
  </Modal>
}
