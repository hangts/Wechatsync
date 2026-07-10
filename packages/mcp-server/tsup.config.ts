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
  // GenAura 投放独立进程入口（全量 bundle，单文件自包含运行）
  // noExternal: 全量打包所有依赖（@wechatsync/core、linkedom 等），避免子进程
  // 运行时的 ESM 模块解析问题（core/src 下 import 无 .js 扩展名）。
  // splitting: false 禁止代码分割，产出单文件，无需随包分发 chunk 文件。
  {
    entry: ['src/genaura-entry.ts'],
    format: ['esm'],
    target: 'node18',
    outDir: 'dist',
    sourcemap: true,
    dts: false,
    noExternal: [/.*/],
    splitting: false,
    banner: {
      js: GENAURA_BANNER,
    },
  },
])
