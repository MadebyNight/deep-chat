import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import {
  ActionButton, Button, IconButton, IconRefreshOutline16, Input, Menu, Modal, Select, Switch,
  Textarea, Toast, Tooltip,
} from './src/components/base/index.js'
import { showToast } from './src/components/base/toastState.js'
import './src/app/theme.css'
import './src/app/global.css'
import './src/app/mobile.css'

function ComponentPreview() {
  const [dark, setDark] = useState(false)
  const [checked, setChecked] = useState(false)
  const [language, setLanguage] = useState('zh')
  const [dialog, setDialog] = useState(false)
  return (
    <main style={{ padding: '24px', display: 'grid', gap: '20px', justifyItems: 'start', color: 'var(--dsw-alias-label-primary)' }}>
      <h1>Deep Chat 组件预览</h1>
      <h2>按钮和状态</h2>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        <Button>主要操作</Button>
        <Button variant="outlined">普通操作</Button>
        <Button variant="danger">危险操作</Button>
        <Button variant="dangerOutlined">危险操作（描边）</Button>
        <Button disabled>禁用</Button>
        <Button variant="outlined" aria-busy="true" aria-disabled="true">处理中</Button>
        <IconButton tooltip="刷新" icon={<IconRefreshOutline16 />} />
        <ActionButton>自定义样式按钮</ActionButton>
      </div>
      <h2>表单</h2>
      <label>浅色 / 深色 <Switch checked={dark} aria-label="深色" onClick={() => {
        document.body.toggleAttribute('data-ds-dark-theme', !dark)
        document.documentElement.style.colorScheme = dark ? 'light' : 'dark'
        setDark(!dark)
      }} /></label>
      <label>开关 <Switch checked={checked} aria-label="开关" onClick={() => setChecked(!checked)} /></label>
      <Select ariaLabel="语言" value={language} options={[{ value: 'zh', label: '中文' }, { value: 'en', label: 'English' }]} onChange={setLanguage} />
      <label>单行输入 <Input placeholder="输入文字" /></label>
      <label>多行输入 <Textarea placeholder="输入文字" /></label>
      <h2>提示和弹层</h2>
      <Tooltip content="悬停或键盘聚焦时显示提示"><Button variant="outlined">查看提示</Button></Tooltip>
      <Menu options={[{ key: 'notice', label: '显示提示', onSelect: () => showToast('菜单操作成功') }]}>
        {({ open, toggle }) => <Button variant="outlined" aria-haspopup="menu" aria-expanded={open} onClick={toggle}>打开菜单</Button>}
      </Menu>
      <Button variant="outlined" onClick={() => setDialog(true)}>打开弹窗</Button>
      <Button variant="outlined" onClick={() => showToast('操作成功')}>显示提示</Button>
      {dialog ? <Modal title="弹窗示例" closable onClose={() => setDialog(false)}><p>按 Esc 或点关闭按钮退出。</p></Modal> : null}
      <Toast />
    </main>
  )
}

const root = document.body.appendChild(document.createElement('div'))
createRoot(root).render(<ComponentPreview />)
