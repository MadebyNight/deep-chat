import { useEffect, useRef, useState, type FormEvent } from 'react'
import { useTranslate, type TranslationKey } from '../../i18n/index.js'
import { newChat } from '../../services/chat/store.js'
import {
  fetchProviderModels,
  isValidProviderKey,
  normalizeProviderUrl,
  removeCustomProvider,
  saveCustomProvider,
  selectCustomProvider,
  setFallbackProviders,
  setStickyProvider,
  useCustomProvider,
  type CustomProvider,
} from '../../services/customProvider.js'
import { createId } from '../../utils/id.js'
import {
  Button,
  IconButton,
  IconEllipsisOutline16,
  IconChevronDownOutline14,
  IconChevronDownOutline16,
  IconChevronUpOutline16,
  IconRefreshOutline16,
  IconTrashOutline16,
  Input,
  Menu,
  Modal,
  Select,
  Switch,
} from '../base/index.js'
import { showToast } from '../base/toastState.js'
import styles from './Settings.module.css'

export const CustomProviderSetting = () => {
  const t = useTranslate()
  const {
    providers,
    activeId,
    enabled,
    fallbackProviderIds,
    stickyProvider,
  } = useCustomProvider()
  const [editor, setEditor] = useState<CustomProvider | 'new' | null>(null)
  const [removing, setRemoving] = useState<CustomProvider | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  const saving = useRef(false)
  const active = providers.find((provider) => provider.id === activeId)
  const fallbackProviders = fallbackProviderIds.flatMap((id) => {
    const provider = providers.find((item) => item.id === id)
    return provider && id !== activeId ? [provider] : []
  })
  const inactiveProviders = providers.filter(
    (provider) => provider.id !== activeId && !fallbackProviderIds.includes(provider.id)
  )
  const moveFallback = (index: number, delta: -1 | 1) => {
    const next = [...fallbackProviderIds]
    const target = index + delta
    if (target < 0 || target >= next.length) {
      return
    }
    ;[next[index], next[target]] = [next[target], next[index]]
    void apply(() => setFallbackProviders(next), false)
  }
  const toggleFallback = (provider: CustomProvider, checked: boolean) =>
    apply(
      () =>
        setFallbackProviders(
          checked
            ? [...fallbackProviderIds, provider.id]
            : fallbackProviderIds.filter((id) => id !== provider.id)
        ),
      false
    )

  const apply = async (operation: () => Promise<boolean>, resetChat = true) => {
    if (saving.current) {
      return false
    }
    saving.current = true
    setBusy(true)
    setError(false)
    try {
      if ((await operation()) && resetChat) {
        newChat()
      }
      return true
    } catch {
      setError(true)
      return false
    } finally {
      saving.current = false
      setBusy(false)
    }
  }

  return (
    <div className={styles.providerList} aria-busy={busy}>
      <div className={styles.providerStatusRow}>
        <p className={activeId || !enabled ? styles.providerStatus : styles.error} role="status">
          {t(
            activeId
              ? 'customProviderActive'
              : enabled
                ? 'customProviderSaveFailed'
                : 'customProviderInactive'
          )}
        </p>
        {enabled ? (
          <Button
            size="s"
            variant="outlined"
            disabled={busy}
            onClick={() => void apply(() => selectCustomProvider(null))}
          >
            {t('customProviderUseDeepSeek')}
          </Button>
        ) : null}
      </div>
      {error && !removing && !editor ? (
        <p role="alert" className={styles.error}>
          {t('customProviderSaveFailed')}
        </p>
      ) : null}
      {providers.length ? (
        <ul>
          {providers.map((provider) => {
            const selected = provider.id === activeId
            return (
              <li key={provider.id}>
                <div>
                  <strong>{new URL(provider.baseUrl).host}</strong>
                  <div className={styles.description}>{provider.model}</div>
                </div>
                {selected ? (
                  <span className={styles.providerSelected}>{t('customProviderInUse')}</span>
                ) : (
                  <Button
                    variant="outlined"
                    size="s"
                    disabled={busy}
                    onClick={() => void apply(() => selectCustomProvider(provider.id))}
                  >
                    {t('customProviderUse')}
                  </Button>
                )}
                <Menu
                  className={styles.settingsMenu}
                  key={String(busy)}
                  options={[
                    {
                      key: 'edit',
                      label: t('customProviderEdit'),
                      onSelect: () => setEditor(provider),
                    },
                    {
                      key: 'delete',
                      label: t('delete'),
                      danger: true,
                      onSelect: () => {
                        setError(false)
                        setRemoving(provider)
                      },
                    },
                  ]}
                >
                  {({ open, toggle }) => (
                    <IconButton
                      icon={<IconEllipsisOutline16 />}
                      aria-label={t('more')}
                      aria-haspopup="menu"
                      aria-expanded={open}
                      disabled={busy}
                      onClick={toggle}
                    />
                  )}
                </Menu>
              </li>
            )
          })}
        </ul>
      ) : null}
      <div className={styles.providerAdd}>
        <Button variant="outlined" disabled={busy} onClick={() => setEditor('new')}>
          {t('customProviderAdd')}
        </Button>
      </div>
      {active ? (
        <section className={styles.providerRouting} aria-label={t('customProviderFallbackTitle')}>
          <strong>{t('customProviderFallbackTitle')}</strong>
          {fallbackProviders.length > 0 ? (
            <ol className={styles.providerFallbackList}>
              {fallbackProviders.map((provider, index) => (
                <li key={provider.id}>
                  <span>
                    <b>{index + 1}</b>
                    {new URL(provider.baseUrl).host} · {provider.model}
                  </span>
                  <div className={styles.providerFallbackActions}>
                    <IconButton
                      icon={<IconChevronUpOutline16 />}
                      disabled={busy || index === 0}
                      aria-label={t('moveUp')}
                      onClick={() => moveFallback(index, -1)}
                    />
                    <IconButton
                      icon={<IconChevronDownOutline16 />}
                      disabled={busy || index === fallbackProviders.length - 1}
                      aria-label={t('moveDown')}
                      onClick={() => moveFallback(index, 1)}
                    />
                    <IconButton
                      icon={<IconTrashOutline16 />}
                      disabled={busy}
                      aria-label={t('delete')}
                      onClick={() => void toggleFallback(provider, false)}
                    />
                  </div>
                </li>
              ))}
            </ol>
          ) : (
            <p className={styles.description}>{t('customProviderFallbackEmpty')}</p>
          )}
          {inactiveProviders.length > 0 ? (
            <div className={styles.providerFallbackChoices}>
              {inactiveProviders.map((provider) => (
                <div key={provider.id}>
                  <span>
                    {new URL(provider.baseUrl).host} · {provider.model}
                  </span>
                  <Button
                    size="s"
                    variant="outlined"
                    disabled={busy}
                    onClick={() => void toggleFallback(provider, true)}
                  >
                    {t('customProviderFallbackAdd')}
                  </Button>
                </div>
              ))}
            </div>
          ) : null}
          <div className={styles.providerSticky}>
            <strong>{t('customProviderSticky')}</strong>
            <Switch
              checked={stickyProvider}
              disabled={busy}
              aria-label={t('customProviderSticky')}
              onClick={() => void apply(() => setStickyProvider(!stickyProvider), false)}
            />
          </div>
        </section>
      ) : null}
      {editor ? (
        <ProviderEditor
          provider={editor === 'new' ? undefined : editor}
          busy={busy}
          onClose={() => {
            if (!saving.current) {
              setEditor(null)
            }
          }}
          onSave={async (provider) => {
            if (
              !(await apply(() =>
                saveCustomProvider(provider, editor === 'new' ? undefined : editor.id)
              ))
            ) {
              return false
            }
            setEditor(null)
            showToast({ key: 'customProviderSaved' })
            return true
          }}
        />
      ) : null}
      {removing ? (
        <Modal
          title={t('customProviderDeleteTitle')}
          onClose={() => {
            if (!saving.current) {
              setRemoving(null)
            }
          }}
          footer={
            <>
              <Button variant="outlined" disabled={busy} onClick={() => setRemoving(null)}>
                {t('cancel')}
              </Button>
              <Button
                variant="danger"
                disabled={busy}
                onClick={async () => {
                  if (await apply(() => removeCustomProvider(removing.id))) {
                    setRemoving(null)
                  }
                }}
              >
                {t('delete')}
              </Button>
            </>
          }
        >
          <p>
            {t(
              removing.id === activeId
                ? 'customProviderDeleteActive'
                : 'customProviderDeleteDescription'
            )}
          </p>
          {error ? (
            <p role="alert" className={styles.error}>
              {t('customProviderSaveFailed')}
            </p>
          ) : null}
        </Modal>
      ) : null}
    </div>
  )
}

const ProviderEditor = ({
  provider,
  busy,
  onClose,
  onSave,
}: {
  provider?: CustomProvider
  busy: boolean
  onClose: () => void
  onSave: (provider: CustomProvider) => Promise<boolean>
}) => {
  const t = useTranslate()
  const [url, setUrl] = useState(provider?.baseUrl ?? '')
  const [key, setKey] = useState('')
  const [model, setModel] = useState(provider?.model ?? '')
  const [models, setModels] = useState<string[]>([])
  const [modelsOpen, setModelsOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<TranslationKey>()
  const [modelError, setModelError] = useState<TranslationKey>()
  const [attempt, setAttempt] = useState(0)
  const baseUrl = normalizeProviderUrl(url)
  const keepsKey = !!provider && baseUrl === provider.baseUrl
  const apiKey = key.trim() || (keepsKey ? provider.apiKey : '')

  useEffect(() => {
    setModels([])
    setModelsOpen(false)
    setModelError(undefined)
    if (!baseUrl || !isValidProviderKey(apiKey)) {
      setLoading(false)
      return
    }

    setLoading(true)
    const controller = new AbortController()
    let timeout: ReturnType<typeof setTimeout> | undefined
    const finish = (found: string[], failure?: TranslationKey) => {
      if (!controller.signal.aborted) {
        clearTimeout(timeout)
        setModels(found)
        setModelError(failure)
        setLoading(false)
      }
    }
    const failed = 'customProviderModelsFailed'
    const debounce = setTimeout(() => {
      timeout = setTimeout(() => {
        finish([], failed)
        controller.abort()
      }, 10000)
      void fetchProviderModels({ baseUrl, apiKey }, controller.signal).then(
        (found) => finish(found, found.length ? undefined : 'customProviderModelsEmpty'),
        () => finish([], failed)
      )
    }, 450)
    return () => {
      clearTimeout(debounce)
      clearTimeout(timeout)
      controller.abort()
    }
  }, [baseUrl, apiKey, attempt])

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (busy) {
      return
    }
    const name = models.includes(model) ? model : model.trim()
    if (!baseUrl) {
      return setError('customProviderInvalidUrl')
    }
    if (!isValidProviderKey(apiKey)) {
      return setError('customProviderInvalidKey')
    }
    if (!name.trim()) {
      return setError('customProviderInvalidModel')
    }
    if (
      provider &&
      provider.baseUrl === baseUrl &&
      provider.apiKey === apiKey &&
      provider.model === name
    ) {
      onClose()
      return
    }
    setError(undefined)
    if (!(await onSave({ id: createId(), baseUrl, apiKey, model: name }))) {
      setError('customProviderSaveFailed')
    }
  }

  const close = () => {
    if (!busy) {
      onClose()
    }
  }

  const message = error ?? modelError
  return (
    <Modal
      title={t(provider ? 'customProviderEdit' : 'customProviderAdd')}
      closable
      fitViewport
      onClose={close}
    >
      <form
        className={styles.providerForm}
        onSubmit={save}
        aria-busy={busy}
        autoComplete="off"
      >
        <p className={styles.description}>{t('customProviderHelp')}</p>
        <label>
          {t('customProviderUrl')}
          <Input
            type="text"
            inputMode="url"
            autoCapitalize="none"
            spellCheck={false}
            placeholder="https://example.com/v1"
            value={url}
            disabled={busy}
            onChange={(event) => {
              setError(undefined)
              setUrl(event.target.value)
            }}
          />
        </label>
        <label>
          API Key
          <Input
            type="password"
            autoComplete="new-password"
            autoCapitalize="none"
            spellCheck={false}
            placeholder={keepsKey ? t('customProviderKeySaved') : undefined}
            value={key}
            disabled={busy}
            onChange={(event) => {
              setError(undefined)
              setKey(event.target.value)
            }}
          />
        </label>
        <div className={styles.providerModel} role="group" aria-label={t('customProviderModel')}>
          <span>{t('customProviderModel')}</span>
          <Select
            ariaLabel={t('customProviderModel')}
            value={model}
            disabled={busy || loading}
            options={models.map((value) => ({ value, label: value }))}
            onChange={setModel}
            inline={{
              open: modelsOpen,
              onClose: () => setModelsOpen(false),
              className: styles.providerModelField,
              field: (
                <>
                  <Input
                    aria-label={t('customProviderModel')}
                    value={model}
                    disabled={busy}
                    autoCapitalize="none"
                    spellCheck={false}
                    onFocus={() => setModelsOpen(false)}
                    onClick={() => setModelsOpen(false)}
                    onChange={(event) => setModel(event.target.value)}
                  />
                  {loading ? (
                    <span className={styles.providerModelToggle} data-loading role="status">
                      <IconRefreshOutline16 aria-label={t('customProviderModelsLoading')} />
                    </span>
                  ) : models.length || modelError ? (
                    <IconButton
                      className={styles.providerModelToggle}
                      icon={models.length ? <IconChevronDownOutline14 /> : <IconRefreshOutline16 />}
                      aria-label={t(
                        models.length ? 'customProviderChooseModel' : 'customProviderFetchModels'
                      )}
                      aria-haspopup={models.length ? 'listbox' : undefined}
                      aria-expanded={models.length ? modelsOpen : undefined}
                      disabled={busy}
                      onClick={() => {
                        if (models.length) {
                          setModelsOpen(!modelsOpen)
                        } else {
                          setAttempt((current) => current + 1)
                        }
                      }}
                    />
                  ) : null}
                </>
              ),
            }}
          />
        </div>
        {message ? (
          <p role={error ? 'alert' : 'status'} className={error ? styles.error : styles.description}>
            {t(message)}
          </p>
        ) : null}
        <div className={styles.providerActions}>
          <Button variant="outlined" disabled={busy} onClick={close}>
            {t('cancel')}
          </Button>
          <Button type="submit" disabled={busy}>
            {t('customProviderSave')}
          </Button>
        </div>
      </form>
    </Modal>
  )
}
