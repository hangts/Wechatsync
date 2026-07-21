/**
 * GenAura 投放独立进程 MCP Server 入口（GPL 聚合）。
 *
 * 重写 Wechatsync 现有 MCP server 的执行体：从"桥接 Chrome 扩展"改为"直接运行适配器"。
 * 主进程通过 StdioClientTransport 以子进程方式启动本文件编译产物（dist/genaura-entry.js），
 * 经 MCP 协议调用 list_platforms / check_auth / sync_article 三个工具。
 *
 * 架构要点（见设计文档 app/docs/design/19-knowledge-article-one-click-publish.md §4.4）：
 * - cookie 与文件内容由主进程读取后通过 MCP 工具入参注入，独立进程不回调主进程。
 * - NodePublishRuntime 实现 RuntimeInterface，用 Node fetch + linkedom 替代 Electron API。
 *
 * 文件分层：
 * - 纯逻辑层（toGenAura* / handleCallTool）：无运行时外部依赖，顶层均为 `import type`，
 *   vitest 加载本文件时不会触发 @wechatsync/core / @modelcontextprotocol/sdk 的真实加载。
 * - main()：通过动态 import() 按需加载运行时依赖，仅在子进程入口执行（由
 *   `process.argv[1] === fileURLToPath(import.meta.url)` 守卫，测试中永不触发）。
 */

// ============================================================================
// 类型导入（运行时擦除，vitest 加载本文件时不触发真实模块加载）
// ============================================================================

import { fileURLToPath } from "node:url";
import type {
  PlatformMeta,
  AuthResult,
  SyncResult,
  Article,
  PublishOptions,
  PlatformAdapter,
} from "@wechatsync/core";

// ============================================================================
// GenAura 侧类型（镜像 app/src/types/platform-publish.ts，保持 GPL 模块自包含）
// ============================================================================

/** GenAura 平台元信息（主进程 ↔ 独立进程契约） */
interface GenAuraPlatformMeta {
  code: string;
  name: string;
  loginUrl: string;
  icon?: string;
  supported: boolean;
  /** 用于 Cookie 域名匹配的根域名（如 juejin.cn、zhihu.com、qq.com） */
  host: string;
}

/** GenAura 登录态检测结果 */
interface GenAuraAuthResult {
  platformCode: string;
  loggedIn: boolean;
  username?: string;
}

/** GenAura 单平台投放结果 */
interface GenAuraSyncResult {
  platformCode: string;
  success: boolean;
  publishUrl?: string;
  /** 产出类型：draft=草稿, published=已发布 */
  type?: "draft" | "published";
  error?: { code: string; message: string };
}

/** 序列化 cookie（跨进程传递，Electron.Cookie 子集） */
interface SerializedCookie {
  name: string;
  value: string;
  domain?: string;
  path?: string;
}

// ============================================================================
// MCP 工具结果类型
// ============================================================================

/** MCP callTool 返回结果形状（镜像 SDK CallToolResult，含 Result 索引签名） */
export interface McpToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  [key: string]: unknown;
}

// ============================================================================
// handleCallTool 依赖注入接口
// ============================================================================

/**
 * handleCallTool 的依赖接口。通过注入而非直接引用 adapterRegistry，使纯逻辑层
 * 可在无 @wechatsync/core 运行时存在的测试环境中验证。
 */
export interface CallToolDeps {
  /** 列出所有已注册适配器的元信息 */
  getAllMeta: () => PlatformMeta[];
  /** 按平台 ID 获取已初始化的适配器实例，未注册返回 null */
  getAdapter: (platformId: string) => Promise<PlatformAdapter | null>;
  /** 注入 cookie 上下文到运行时（url 为适配器 meta.homepage） */
  setCookieContext: (url: string, cookies: SerializedCookie[]) => void;
  /** 将 Markdown 转换为 HTML（部分平台 API 如 CSDN 要求 content 字段为 HTML） */
  markdownToHtml: (markdown: string) => string;
}

// ============================================================================
// 类型映射纯函数（Wechatsync → GenAura）
// ============================================================================

/**
 * 从 loginUrl 中提取根域名用于 Cookie 匹配。
 * 取 hostname 最后两段（如 juejin.cn、zhihu.com、qq.com），
 * 适用于所有发布平台（.cn / .com / .net），无需 psl 库。
 */
function extractDomain(loginUrl: string): string {
  try {
    const hostname = new URL(loginUrl).hostname;
    const parts = hostname.split(".");
    return parts.slice(-2).join(".");
  } catch {
    return "";
  }
}

/**
 * Wechatsync PlatformMeta → GenAura PlatformMeta。
 * - id → code
 * - homepage → loginUrl
 * - capabilities 含 'article' → supported=true
 * - 从 homepage 提取 host（用于 Cookie 域名匹配）
 */
export function toGenAuraPlatformMeta(meta: PlatformMeta): GenAuraPlatformMeta {
  return {
    code: meta.id,
    name: meta.name,
    loginUrl: meta.homepage,
    icon: meta.icon,
    supported: meta.capabilities.includes("article"),
    host: extractDomain(meta.homepage),
  };
}

/**
 * Wechatsync AuthResult → GenAura AuthResult。
 * - isAuthenticated → loggedIn
 * - 仅已登录时携带 username
 */
export function toGenAuraAuthResult(
  platformCode: string,
  auth: AuthResult,
): GenAuraAuthResult {
  const result: GenAuraAuthResult = {
    platformCode,
    loggedIn: auth.isAuthenticated,
  };
  if (auth.isAuthenticated && auth.username) {
    result.username = auth.username;
  }
  return result;
}

/**
 * 登录态失效错误匹配模式。
 *
 * Wechatsync 适配器在 cookie 过期或失效时返回的 error 字符串各不相同，
 * 这里集中识别常见的中英文登录态失效表述，以便前端展示"去登录"引导。
 */
const AUTH_EXPIRED_PATTERNS: RegExp[] = [
  /登录.*(超时|过期|失效|重新)/,
  /session.*(invalid|expired|timeout)/i,
  /unauthorized/i,
  /auth.*(expired|invalid|failed)/i,
  /token.*(expired|invalid)/i,
  /\b401\b/,
];

/** 判断错误字符串是否表示登录态失效（cookie 过期/未授权）。 */
export function isAuthExpiredError(error: string): boolean {
  return AUTH_EXPIRED_PATTERNS.some((p) => p.test(error));
}

/**
 * Wechatsync SyncResult → GenAura SyncResult。
 * - platform → platformCode
 * - postUrl → draftUrl（仅存在时）
 * - error 字符串 → { code, message }：
 *   - 登录态失效 → code: 'auth_expired'（前端显示"去登录"引导）
 *   - 其他错误 → code: 'external_api_error'
 */
export function toGenAuraSyncResult(sr: SyncResult): GenAuraSyncResult {
  const result: GenAuraSyncResult = {
    platformCode: sr.platform,
    success: sr.success,
  };
  if (sr.success && sr.postUrl) {
    result.publishUrl = sr.postUrl;
  }
  // 根据 draftOnly 推断 type：draftOnly=true → "draft", false → "published", 未设置则不传
  if (sr.draftOnly !== undefined) {
    result.type = sr.draftOnly ? "draft" : "published";
  }
  if (sr.error) {
    result.error = {
      code: isAuthExpiredError(sr.error) ? "auth_expired" : "external_api_error",
      message: sr.error,
    };
  }
  return result;
}

// ============================================================================
// MCP 工具分发（纯逻辑层，依赖通过 CallToolDeps 注入）
// ============================================================================

/** sync_article 入参形状 */
interface SyncArticleArgs {
  content: string;
  title: string;
  tags?: string[];
  platforms: Array<{ code: string; cookies: SerializedCookie[] }>;
  options?: PublishOptions;
}

/** check_auth 入参形状 */
interface CheckAuthArgs {
  platformCode: string;
  cookies: SerializedCookie[];
}

/** 构造成功结果（JSON 序列化 payload） */
function ok(data: unknown): McpToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data) }] };
}

/** 构造错误结果（JSON 序列化 payload，isError=true） */
function err(data: unknown): McpToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data) }], isError: true };
}

/**
 * MCP 工具分发器。根据工具名路由到对应处理逻辑，返回 MCP 标准结果。
 *
 * - list_platforms：返回所有适配器元信息（GenAura 映射后）
 * - check_auth：注入 cookie → 调用 adapter.checkAuth → 映射结果
 * - sync_article：并发投放多平台，单平台失败不中断其他（并发 3 参考 extension）
 */
export async function handleCallTool(
  name: string,
  args: unknown,
  deps: CallToolDeps,
): Promise<McpToolResult> {
  switch (name) {
    case "list_platforms": {
      const metas = deps.getAllMeta();
      return ok(metas.map(toGenAuraPlatformMeta));
    }

    case "check_auth": {
      const { platformCode, cookies } = args as CheckAuthArgs;
      const adapter = await deps.getAdapter(platformCode);
      if (!adapter) {
        return err({ error: `平台 ${platformCode} 未注册` });
      }
      deps.setCookieContext(adapter.meta.homepage, cookies);
      const auth = await adapter.checkAuth();
      return ok(toGenAuraAuthResult(platformCode, auth));
    }

    case "sync_article": {
      const { content, title, tags, platforms } = args as SyncArticleArgs;
      const rawOptions = (args as Record<string, unknown>).options as Record<string, unknown> | undefined;
      // publishDirectly=true → draftOnly=false（正式发布）；否则 draftOnly=true（保存为草稿）
      const publishDirectly = rawOptions?.publishDirectly === true;
      const draftOnly = !publishDirectly;

      const results = await Promise.all(
        platforms.map(async ({ code, cookies }) => {
          const adapter = await deps.getAdapter(code);
          if (!adapter) {
            return {
              platformCode: code,
              success: false,
              error: {
                code: "platform_not_registered",
                message: `平台 ${code} 未注册`,
              },
            } satisfies GenAuraSyncResult;
          }
          deps.setCookieContext(adapter.meta.homepage, cookies);
          try {
            const article: Article = { title, markdown: content, html: deps.markdownToHtml(content), tags };
            const sr = await adapter.publish(article, { draftOnly });
            if (!sr.success) {
              process.stderr.write(`[genaura-entry] sync_article 平台 ${code} 适配器返回失败: ${sr.error ?? "(无错误信息)"}\n`);
            }
            return toGenAuraSyncResult(sr);
          } catch (e) {
            // 输出详细错误到 stderr（不污染 stdout MCP 通道），便于排查适配器失败原因
            const errDetail = e instanceof Error
              ? `${e.message}\n${e.stack ?? ""}`
              : String(e);
            process.stderr.write(`[genaura-entry] sync_article 平台 ${code} 失败: ${errDetail}\n`);
            const errMsg = e instanceof Error ? e.message : String(e);
            return {
              platformCode: code,
              success: false,
              error: {
                code: isAuthExpiredError(errMsg) ? "auth_expired" : "external_api_error",
                message: errMsg,
              },
            } satisfies GenAuraSyncResult;
          }
        }),
      );
      return ok(results);
    }

    default:
      return {
        content: [{ type: "text", text: `Unknown tool: ${name}` }],
        isError: true,
      };
  }
}

// ============================================================================
// 运行时入口（仅子进程执行，测试中由 ESM 入口守卫跳过）
// ============================================================================

/**
 * 构建 CallToolDeps：将 adapterRegistry 适配为 handleCallTool 所需的依赖接口。
 * 运行时实例化 NodePublishRuntime 并注册 Wechatsync 全部 18 个文章适配器。
 */
async function buildDeps(): Promise<CallToolDeps> {
  const { adapterRegistry, markdownToHtml } = await import("@wechatsync/core");
  const { NodePublishRuntime } = await import("./node-publish-runtime.js");

  const runtime = new NodePublishRuntime();
  adapterRegistry.setRuntime(runtime);

  // 导入 Wechatsync 全部公开文章适配器（跳过 ZipDownloadAdapter，非发布用途）
  const {
    JuejinAdapter, ZhihuAdapter, CSDNAdapter,
    WeiboAdapter, BilibiliAdapter, BaijiahaoAdapter,
    YuqueAdapter, WeixinAdapter, Cto51Adapter,
    ImoocAdapter, OschinaAdapter, SegmentfaultAdapter,
    CnblogsAdapter, DoubanAdapter, XueqiuAdapter,
    SohuAdapter, WoshipmAdapter, EastmoneyAdapter,
  } = await import("@wechatsync/core");

  // 适配器构造函数无参，meta 为类实例属性；registry 在 get() 中调用 init(runtime) 注入运行时
  const AdapterClasses = [
    BaijiahaoAdapter,
    JuejinAdapter, ZhihuAdapter, CSDNAdapter,
    WeiboAdapter, BilibiliAdapter, 
    YuqueAdapter, WeixinAdapter, Cto51Adapter,
    ImoocAdapter, OschinaAdapter, SegmentfaultAdapter,
    CnblogsAdapter, DoubanAdapter, XueqiuAdapter,
    SohuAdapter, WoshipmAdapter, EastmoneyAdapter,
  ];

  // const AdapterClasses = [
  //   BaijiahaoAdapter,
  // ];

  for (const AdapterClass of AdapterClasses) {
    const instance = new AdapterClass();
    adapterRegistry.register({
      meta: instance.meta,
      factory: () => new AdapterClass(),
    });
  }

  return {
    getAllMeta: () => adapterRegistry.getAllMeta(),
    getAdapter: (id: string) => adapterRegistry.get(id),
    setCookieContext: (url: string, cookies: SerializedCookie[]) =>
      runtime.setCookieContext(url, cookies),
    markdownToHtml,
  };
}

/**
 * MCP Server 主入口：注册工具 schema 并启动 StdioServerTransport。
 * 所有运行时依赖通过动态 import() 加载，确保纯逻辑层在测试中不触发真实模块。
 */
async function main(): Promise<void> {
  // MCP 协议通过 stdout 传输 JSON-RPC 消息，适配器的 console.log 会污染通道。
  // 将 console.log/info/debug 重定向到 stderr，console.warn/error 默认已到 stderr。
  // 对象用 JSON.stringify 序列化（String(obj) 会输出 [object Object] 丢失信息）。
  const fmt = (args: unknown[]) => args.map(a => typeof a === "string" ? a : JSON.stringify(a)).join(" ");
  const origLog = console.log;
  console.log = (...args: unknown[]) => process.stderr.write(fmt(args) + "\n");
  console.info = (...args: unknown[]) => process.stderr.write(fmt(args) + "\n");
  console.debug = (...args: unknown[]) => process.stderr.write(fmt(args) + "\n");
  void origLog;

  // 注入 Node 环境 polyfill（FileReader 等），CodeAdapter 基类的 blobToDataUri 依赖
  const { ensureNodePolyfills } = await import("./node-publish-runtime.js");
  ensureNodePolyfills();

  const { Server } = await import("@modelcontextprotocol/sdk/server/index.js");
  const { StdioServerTransport } = await import(
    "@modelcontextprotocol/sdk/server/stdio.js"
  );
  const { CallToolRequestSchema, ListToolsRequestSchema } = await import(
    "@modelcontextprotocol/sdk/types.js"
  );

  const deps = await buildDeps();

  const server = new Server(
    { name: "genaura-publish-server", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "list_platforms",
        description: "列出已注册的内容平台",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "check_auth",
        description: "检测指定平台登录态",
        inputSchema: {
          type: "object",
          properties: {
            platformCode: { type: "string" },
            cookies: { type: "array" },
          },
          required: ["platformCode", "cookies"],
        },
      },
      {
        name: "sync_article",
        description: "将文章投放到一个或多个平台（正式发布或保存为草稿，由 options.publishDirectly 控制）",
        inputSchema: {
          type: "object",
          properties: {
            content: { type: "string" },
            title: { type: "string" },
            platforms: { type: "array" },
            options: { type: "object" },
          },
          required: ["content", "title", "platforms"],
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const result = await handleCallTool(
      req.params.name,
      req.params.arguments ?? {},
      deps,
    );
    return result;
  });

  await server.connect(new StdioServerTransport());
}

// ESM 入口守卫：仅当本文件作为子进程入口执行时启动 server，测试中 import 不触发。
// 注意：import.meta.url 是 file:// URL，必须用 fileURLToPath 转换为路径才能与 process.argv[1] 比较。
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error("[genaura-entry] fatal:", err);
    process.exit(1);
  });
}
