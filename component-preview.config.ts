import { defineConfig } from '@rspack/cli'
import { rspack } from '@rspack/core'
import { createConfig } from './rspack.config.js'

const config = createConfig({ devServer: { host: '127.0.0.1', port: 8091 } })

export default defineConfig({
  ...config,
  entry: './component-preview.tsx',
  output: { ...config.output, clean: false },
  plugins: [new rspack.HtmlRspackPlugin({ title: 'Deep Chat 组件预览' })],
})
