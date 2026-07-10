import { defineConfig } from 'tsup'

// genaura-entry 的 ESM bundle 需要注入 createRequire，因为 @wechatsync/core 的
// CJS 依赖（如 js-md5）使用 require() 加载 Node 内置模块（crypto 等）。
// 在 ESM 环境中 require 未定义，需通过 createRequire 创建。
const GENAURA_BANNER = 'import {createRequire} from "node:module";const require=createRequire(import.meta.url);'

export default defineConfig([
  // Main entry (CLI with shebang)
  {
    entry: ['src/index.ts'],
    format: ['esm'],
    target: 'node18',
    outDir: 'dist',
    clean: true,
    sourcemap: true,
    dts: true,
    banner: {
      js: '#!/usr/bin/env node',
    },
  },
  // Library exports (no shebang)
  {
    entry: ['src/exports.ts'],
    format: ['esm'],
    target: 'node18',
    outDir: 'dist',
    sourcemap: true,
    dts: true,
  },
  // GenAura 投放独立进程入口（全量 bundle，自包含运行）
  // noExternal: true 将所有依赖（@wechatsync/core、linkedom 等）打包进单文件，
  // 避免子进程运行时的 ESM 模块解析问题（core/src 下 import 无 .js 扩展名）
  {
    entry: ['src/genaura-entry.ts'],
    format: ['esm'],
    target: 'node18',
    outDir: 'dist',
    sourcemap: true,
    dts: false,
    noExternal: [/.*/],
    banner: {
      js: GENAURA_BANNER,
    },
  },
])
