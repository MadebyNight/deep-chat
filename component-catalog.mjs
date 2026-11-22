import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from '@babel/parser'

const root = fileURLToPath(new URL('.', import.meta.url))
const catalogFile = resolve(root, 'component-catalog.json')
const nativeControls = new Set(['button', 'input', 'select', 'textarea', 'dialog'])
const controlRoles = new Set(['button', 'switch', 'tab', 'menuitem', 'option', 'listbox', 'dialog'])
const groups = { base: 'shared', chatInput: 'chat', files: 'chat', markdown: 'messages', messages: 'messages', search: 'search', settings: 'settings', session: 'sessions', sider: 'sessions' }
const options = { sourceType: 'module', plugins: ['typescript', 'jsx'] }

function visit(node, callback) {
  if (!node?.type) return
  callback(node)
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach((child) => visit(child, callback))
    else if (value?.type) visit(value, callback)
  }
}

const componentFactory = (node) => node?.type === 'CallExpression' && ['memo', 'forwardRef', 'lazy'].includes(node.callee.name ?? node.callee.property?.name)
const pascal = (name) => /^[A-Z][\w]*$/.test(name ?? '')
function componentNames(program) {
  const names = new Set()
  visit(program, (node) => {
    if (node.type === 'VariableDeclarator' && pascal(node.id.name) && componentFactory(node.init)) names.add(node.id.name)
    if (node.type === 'ClassDeclaration' && pascal(node.id?.name) && node.body.body.some((member) => member.key?.name === 'render')) names.add(node.id.name)
    const fn = ['ArrowFunctionExpression', 'FunctionExpression', 'FunctionDeclaration'].includes(node.init?.type) ? node.init
      : node.type === 'FunctionDeclaration' ? node : null
    const name = node.id?.name
    if (!fn || !pascal(name)) return
    visit(fn.body, (child) => {
      if (['JSXElement', 'JSXFragment'].includes(child.type) || (child.type === 'CallExpression' && ['createElement', 'createPortal'].includes(child.callee.name ?? child.callee.property?.name))) names.add(name)
    })
  })
  return [...names].sort()
}

function inspect(file, source, violations) {
  const { program } = parse(source, options)
  visit(program, (node) => {
    const report = (message) => violations.push(`${file}:${node.loc.start.line} ${message}`)
    if (node.type === 'ImportDeclaration' || node.type === 'ExportNamedDeclaration' || node.type === 'ExportAllDeclaration') {
      const target = node.source?.value
      if (target?.startsWith('.')) {
        const resolved = resolve(root, file, '..', target).replaceAll('\\', '/')
        const features = resolve(root, 'src/components').replaceAll('\\', '/')
        if (file.startsWith('src/components/base/')) {
          if (resolved.startsWith(`${features}/`) && !resolved.startsWith(`${features}/base/`)) {
            report(`shared component depends on feature ${target}`)
          }
        } else if (/\/base\/(Button|Control|IconButton|Menu|Modal|Select|Switch|Toast|Tooltip|icons)\.js$/.test(resolved)) {
          report(`import shared controls through base/index.js instead of ${target}`)
        }
      }
    }
    if (node.type !== 'JSXOpeningElement') return
    const tag = node.name.name
    const role = node.attributes.find((attribute) => attribute.name?.name === 'role')?.value?.value
    if (nativeControls.has(tag) && file !== 'src/components/base/Control.tsx') report(`use a shared control instead of <${tag}>`)
    // Some structural ARIA roles belong to their owning composite or the system update overlay.
    const structural = (file.startsWith('src/components/base/') && ['dialog', 'listbox', 'menuitem', 'option'].includes(role)) ||
      (file === 'src/components/settings/UpdateDialog.tsx' && role === 'dialog')
    if (tag && /^[a-z]/.test(tag) && controlRoles.has(role) && !structural) report(`use a shared control for role=${role}`)
  })
  return componentNames(program)
}

function inventory(violations) {
  return readdirSync(resolve(root, 'src'), { recursive: true }).filter((file) => /\.(tsx|jsx)$/.test(file)).map((file) => `src/${file.replaceAll('\\', '/')}`).sort().map((file) => {
    const group = groups[file.split('/')[2]] ?? 'app'
    return { file, group, components: inspect(file, readFileSync(resolve(root, file), 'utf8'), violations) }
  })
}

if (process.argv.includes('--self-test')) {
  const violations = []
  const names = inspect('src/components/fixture/Fixture.tsx', `
    export const Fixture = () => <button />
    const Nested = () => <span role="button" />
  `, violations)
  if (names.join(',') !== 'Fixture,Nested' || violations.length !== 2) {
    throw new Error('Component catalog did not detect fixture components and bypasses')
  }
}

const violations = []
const actual = inventory(violations)
const serialized = JSON.stringify(actual, null, 2) + '\n'
if (process.argv.includes('--update')) {
  if (violations.length === 0) writeFileSync(catalogFile, serialized)
} else {
  const registered = JSON.parse(readFileSync(catalogFile, 'utf8'))
  const byFile = new Map(registered.map((entry) => [entry.file, entry]))
  for (const entry of actual) {
    if (JSON.stringify(byFile.get(entry.file)) !== JSON.stringify(entry)) violations.push(`${entry.file}: component catalog differs (${entry.components.join(', ')})`)
    byFile.delete(entry.file)
  }
  for (const file of byFile.keys()) violations.push(`${file}: no longer exists`)
}
if (process.argv.includes('--list')) {
  for (const { file, group, components } of actual) console.log(`${group.padEnd(9)} ${file}  ${components.join(', ')}`)
}
if (violations.length) {
  console.error(violations.join('\n'))
  process.exitCode = 1
} else {
  console.log(`Component catalog: ${actual.length} modules, ${actual.reduce((count, entry) => count + entry.components.length, 0)} named components`)
}
