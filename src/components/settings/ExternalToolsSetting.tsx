import { useEffect, useRef, useState } from 'react'
import { useTranslate, type TranslationKey } from '../../i18n/index.js'
import {
  Button,
  IconButton,
  IconEllipsisOutline16,
  IconRefreshOutline16,
  Input,
  Menu,
  Modal,
  Select,
  Switch,
} from '../base/index.js'
import { showToast } from '../base/toastState.js'
import {
  emptyExternalSearch,
  ExternalToolsConfigError,
  normalizeExternalSearch,
  normalizeExternalSearchUrl,
  normalizeMcpServer,
  normalizeMcpUrl,
  saveExternalSearch,
  saveMcpServers,
  useExternalTools,
  type ExternalSearchProvider,
  type McpServerConfig,
} from '../../services/tools/config.js'
import { fetchMcpTools, toStoredTools } from '../../services/tools/runtime.js'
import { McpError } from '../../services/mcp/remoteClient.js'
import { createId } from '../../utils/id.js'
import styles from './Settings.module.css'

const configErrorKey = (error: unknown): TranslationKey => {
  if (error instanceof ExternalToolsConfigError) {
    switch (error.code) {
      case 'searchUrl':
        return 'externalSearchInvalidUrl'
      case 'searchKey':
        return 'externalSearchInvalidKey'
      case 'mcpName':
        return 'mcpInvalidName'
      case 'mcpUrl':
        return 'mcpInvalidUrl'
      case 'mcpToken':
        return 'mcpInvalidToken'
      case 'mcpTools':
        return 'mcpInvalidTools'
    }
  }
  return 'externalToolsSaveFailed'
}

export const ExternalToolsSetting = () => (
  <div className={styles.toolSettings}>
    <ExternalSearchSetting />
    <McpServersSetting />
  </div>
)

const ExternalSearchSetting = () => {
  const t = useTranslate()
  const saved = useExternalTools((state) => state.search)
  const [draft, setDraft] = useState(saved)
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<TranslationKey>()
  useEffect(() => {
    setDraft(saved)
    setKey('')
  }, [saved])
  const baseUrl = draft.provider === 'searxng' ? draft.baseUrl : ''
  const keepsKey =
    !!saved.apiKey &&
    saved.provider === draft.provider &&
    (draft.provider !== 'searxng' || normalizeExternalSearchUrl(draft.baseUrl) === saved.baseUrl)

  const save = async () => {
    if (busy) {
      return
    }
    setBusy(true)
    setError(undefined)
    try {
      const apiKey = key.trim() || (keepsKey ? saved.apiKey : '')
      if (!draft.enabled && !baseUrl.trim() && !apiKey) {
        await saveExternalSearch(emptyExternalSearch())
      } else {
        const config = normalizeExternalSearch({ ...draft, baseUrl, apiKey })
        await saveExternalSearch(config)
      }
      showToast({ key: 'externalSearchSaved' })
    } catch (failure) {
      setError(configErrorKey(failure))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className={styles.toolSection} aria-busy={busy}>
      <div className={styles.toolSectionHeader}>
        <strong>{t('externalSearchTitle')}</strong>
        <Switch
          checked={draft.enabled}
          disabled={busy}
          aria-label={t('externalSearchEnabled')}
          onClick={() => setDraft((value) => ({ ...value, enabled: !value.enabled }))}
        />
      </div>
      <form
        className={styles.providerForm}
        onSubmit={(event) => {
          event.preventDefault()
          void save()
        }}
      >
        <label>
          {t('externalSearchProvider')}
          <Select
            ariaLabel={t('externalSearchProvider')}
            value={draft.provider}
            disabled={busy}
            options={[
              { value: 'searxng', label: 'SearXNG' },
              { value: 'tavily', label: 'Tavily' },
              { value: 'exa', label: 'Exa' },
              { value: 'brave', label: 'Brave' },
            ]}
            onChange={(provider: ExternalSearchProvider) => {
              setError(undefined)
              setKey('')
              setDraft((value) => ({
                ...value,
                provider,
                baseUrl:
                  provider === 'searxng' && value.provider !== 'searxng' ? '' : value.baseUrl,
              }))
            }}
          />
        </label>
        {draft.provider === 'searxng' ? (
          <label>
            {t('externalSearchUrl')}
            <Input
              type="text"
              inputMode="url"
              autoCapitalize="none"
              spellCheck={false}
              value={draft.baseUrl}
              disabled={busy}
              onChange={(event) => {
                setError(undefined)
                setDraft((value) => ({ ...value, baseUrl: event.target.value }))
              }}
            />
          </label>
        ) : null}
        <label>
          {t('externalSearchKey')}
          <Input
            type="password"
            autoComplete="new-password"
            autoCapitalize="none"
            spellCheck={false}
            placeholder={keepsKey ? t('externalSearchKeySaved') : undefined}
            value={key}
            disabled={busy}
            onChange={(event) => {
              setError(undefined)
              setKey(event.target.value)
            }}
          />
        </label>
        {error ? (
          <p role="alert" className={styles.error}>
            {t(error)}
          </p>
        ) : null}
        <div className={styles.toolActions}>
          <Button size="m" type="submit" disabled={busy}>
            {t('save')}
          </Button>
        </div>
      </form>
    </section>
  )
}

const McpServersSetting = () => {
  const t = useTranslate()
  const servers = useExternalTools((state) => state.mcp)
  const [editor, setEditor] = useState<McpServerConfig | 'new' | null>(null)
  const [removing, setRemoving] = useState<McpServerConfig | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<TranslationKey>()

  const apply = async (next: McpServerConfig[]) => {
    if (busy) {
      return false
    }
    setBusy(true)
    setError(undefined)
    try {
      await saveMcpServers(next)
      return true
    } catch (failure) {
      setError(configErrorKey(failure))
      return false
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className={styles.toolSection} aria-busy={busy}>
      <div className={styles.toolSectionHeader}>
        <strong>{t('mcpServersTitle')}</strong>
      </div>
      {servers.length > 0 ? (
        <ul className={styles.mcpList}>
          {servers.map((server) => (
            <li key={server.id}>
              <div className={styles.mcpIdentity}>
                <strong>{server.name}</strong>
              </div>
              <Switch
                checked={server.enabled}
                disabled={busy}
                aria-label={server.name}
                onClick={() =>
                  void apply(
                    servers.map((item) =>
                      item.id === server.id ? { ...item, enabled: !item.enabled } : item
                    )
                  )
                }
              />
              <Menu
                className={styles.settingsMenu}
                key={String(busy)}
                options={[
                  {
                    key: 'edit',
                    label: t('mcpEdit'),
                    onSelect: () => setEditor(server),
                  },
                  {
                    key: 'delete',
                    label: t('delete'),
                    danger: true,
                    onSelect: () => {
                      setError(undefined)
                      setRemoving(server)
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
          ))}
        </ul>
      ) : null}
      {error && !removing && !editor ? (
        <p role="alert" className={styles.error}>
          {t(error)}
        </p>
      ) : null}
      <div className={styles.toolActions}>
        <Button variant="outlined" size="m" disabled={busy} onClick={() => setEditor('new')}>
          {t('mcpAdd')}
        </Button>
      </div>
      {editor ? (
        <McpServerEditor
          server={editor === 'new' ? undefined : editor}
          onClose={() => setEditor(null)}
          onSave={async (server) => {
            const next =
              editor === 'new'
                ? [...servers, server]
                : servers.map((item) => (item.id === server.id ? server : item))
            await saveMcpServers(next)
            setEditor(null)
            showToast({ key: 'mcpSaved' })
          }}
        />
      ) : null}
      {removing ? (
        <Modal
          title={t('mcpDeleteTitle')}
          layout="confirm"
          onClose={() => {
            if (!busy) {
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
                  if (await apply(servers.filter((item) => item.id !== removing.id))) {
                    setRemoving(null)
                  }
                }}
              >
                {t('delete')}
              </Button>
            </>
          }
        />
      ) : null}
    </section>
  )
}

const McpServerEditor = ({
  server,
  onClose,
  onSave,
}: {
  server?: McpServerConfig
  onClose: () => void
  onSave: (server: McpServerConfig) => Promise<void>
}) => {
  const t = useTranslate()
  const [id] = useState(() => server?.id ?? createId())
  const [name, setName] = useState(server?.name ?? '')
  const [url, setUrl] = useState(server?.url ?? '')
  const [token, setToken] = useState('')
  const [tools, setTools] = useState(server?.tools ?? [])
  const [status, setStatus] = useState<string>()
  const [error, setError] = useState<TranslationKey>()
  const [fetching, setFetching] = useState(false)
  const [saving, setSaving] = useState(false)
  const request = useRef<AbortController | null>(null)
  useEffect(() => () => request.current?.abort(), [])
  const keepsToken = !!server?.token && normalizeMcpUrl(url) === server.url
  const effectiveToken = token.trim() || (keepsToken ? server.token : '')
  const close = () => {
    if (saving) {
      return
    }
    const active = request.current
    request.current = null
    active?.abort()
    onClose()
  }

  const fetchTools = async () => {
    if (fetching || saving) {
      return
    }
    const target = normalizeMcpUrl(url)
    if (!target) {
      setError('mcpInvalidUrl')
      return
    }
    setError(undefined)
    setStatus(undefined)
    setFetching(true)
    const controller = new AbortController()
    request.current = controller
    try {
      const found = await fetchMcpTools({ url: target, token: effectiveToken }, controller.signal)
      if (controller.signal.aborted) {
        return
      }
      setTools((current) => toStoredTools(found, current))
      if (found.length === 0) {
        setStatus(t('mcpToolsEmpty'))
      }
    } catch (failure) {
      if (!controller.signal.aborted) {
        setStatus(failure instanceof McpError ? `MCP ${failure.code}` : t('mcpToolsFetchFailed'))
      }
    } finally {
      if (request.current === controller) {
        request.current = null
        setFetching(false)
      }
    }
  }

  const save = async () => {
    if (saving) {
      return
    }
    const target = normalizeMcpUrl(url)
    if (!name.trim()) {
      setError('mcpInvalidName')
      return
    }
    if (!target) {
      setError('mcpInvalidUrl')
      return
    }
    setError(undefined)
    setSaving(true)
    try {
      const candidate = normalizeMcpServer({
        id,
        name,
        url: target,
        token: effectiveToken,
        enabled: server?.enabled ?? true,
        tools,
      })
      await onSave(candidate)
    } catch (failure) {
      setError(configErrorKey(failure))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal title={t(server ? 'mcpEdit' : 'mcpAdd')} closable fitViewport onClose={close}>
      <form
        className={styles.providerForm}
        onSubmit={(event) => {
          event.preventDefault()
          void save()
        }}
        aria-busy={saving}
        autoComplete="off"
      >
        <label>
          {t('mcpName')}
          <Input
            value={name}
            disabled={saving || fetching}
            onChange={(event) => {
              setError(undefined)
              setName(event.target.value)
            }}
          />
        </label>
        <label>
          {t('mcpUrl')}
          <Input
            type="text"
            inputMode="url"
            autoCapitalize="none"
            spellCheck={false}
            value={url}
            disabled={saving || fetching}
            onChange={(event) => {
              setError(undefined)
              setUrl(event.target.value)
              if (normalizeMcpUrl(event.target.value) !== server?.url) {
                setTools([])
              }
            }}
          />
        </label>
        <label>
          {t('mcpToken')}
          <Input
            type="password"
            autoComplete="new-password"
            autoCapitalize="none"
            spellCheck={false}
            placeholder={keepsToken ? t('mcpTokenSaved') : undefined}
            value={token}
            disabled={saving || fetching}
            onChange={(event) => {
              setError(undefined)
              setStatus(undefined)
              setToken(event.target.value)
              setTools([])
            }}
          />
        </label>
        <div className={styles.toolActions}>
          <Button
            variant="outlined"
            size="m"
            type="button"
            disabled={fetching || saving}
            onClick={() => void fetchTools()}
          >
            <IconRefreshOutline16 />
            {t(fetching ? 'mcpFetchingTools' : 'mcpFetchTools')}
          </Button>
        </div>
        {status ? (
          <p role="status" className={styles.error}>
            {status}
          </p>
        ) : null}
        {tools.length > 0 ? (
          <div className={styles.mcpTools} role="group" aria-label={t('mcpTools')}>
            {tools.map((tool) => (
              <div key={tool.name} className={styles.mcpToolRow}>
                <span>{tool.name}</span>
                <Switch
                  checked={tool.enabled}
                  disabled={saving || fetching}
                  aria-label={tool.name}
                  onClick={() =>
                    setTools((current) =>
                      current.map((item) =>
                        item.name === tool.name ? { ...item, enabled: !item.enabled } : item
                      )
                    )
                  }
                />
              </div>
            ))}
          </div>
        ) : null}
        {error ? (
          <p role="alert" className={styles.error}>
            {t(error)}
          </p>
        ) : null}
        <div className={styles.providerActions}>
          <Button variant="outlined" disabled={saving} onClick={close}>
            {t('cancel')}
          </Button>
          <Button type="submit" disabled={saving || fetching}>
            {t('save')}
          </Button>
        </div>
      </form>
    </Modal>
  )
}
