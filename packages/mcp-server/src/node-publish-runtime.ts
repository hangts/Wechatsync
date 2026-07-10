/**
 * Node 环境投放运行时（GPL 聚合）。
 *
 * 实现 Wechatsync 的 RuntimeInterface，用 Node fetch + linkedom 替代 Electron API。
 * 独立进程无 Electron session 访问权，cookie 由主进程通过 setCookieContext 注入。
 *
 * 设计要点（见设计文档 app/docs/design/19-knowledge-article-one-click-publish.md §2.3）：
 * - cookie 按 hostname 存储，setCookieContext 覆盖同域旧值（每次投放前主进程注入最新 cookie）
 * - fetch 自动注入 Cookie / Origin / Referer header（替代进程内模型的 net.request 关联 session）
 * - 调用方显式传入的 header 优先，不被注入值覆盖（适配器 withHeaderRules 显式 headers 生效）
 * - linkedom 通过动态 import 在 dom.parseHTML 内按需加载，模块加载时不触发 linkedom
 */

import type { RuntimeInterface, Cookie } from "@wechatsync/core";

/** 序列化 cookie（跨进程传递，Electron.Cookie 子集） */
interface SerializedCookie {
  name: string;
  value: string;
  domain?: string;
  path?: string;
}

/** 内存存储实现（投放过程无需持久化） */
class MemoryStorage {
  private map = new Map<string, unknown>();

  async get<T>(key: string): Promise<T | null> {
    return (this.map.get(key) as T | undefined) ?? null;
  }

  async set<T>(key: string, value: T): Promise<void> {
    this.map.set(key, value);
  }

  async remove(key: string): Promise<void> {
    this.map.delete(key);
  }
}

/**
 * 判断 cookie domain 是否匹配 hostname。
 * - `.juejin.cn` 匹配 `juejin.cn` 和 `api.juejin.cn`
 * - `juejin.cn` 仅匹配 `juejin.cn`
 */
function domainMatches(cookieDomain: string, hostname: string): boolean {
  const d = cookieDomain.startsWith(".") ? cookieDomain.slice(1) : cookieDomain;
  return hostname === d || hostname.endsWith("." + d);
}

/** 将 HeadersInit 归一化为普通对象，便于合并 */
function normalizeHeaders(headers: HeadersInit | undefined): Record<string, string> {
  if (!headers) return {};
  if (headers instanceof Headers) {
    return Object.fromEntries(headers.entries());
  }
  if (Array.isArray(headers)) {
    return Object.fromEntries(headers);
  }
  return { ...headers };
}

/**
 * Node 投放运行时。cookie 由主进程注入，fetch 自动附加 cookie/Origin/Referer。
 */
export class NodePublishRuntime implements RuntimeInterface {
  readonly type = "node" as const;

  /** cookie 按 hostname 存储（setCookieContext 的 URL hostname） */
  private cookieStore = new Map<string, SerializedCookie[]>();

  readonly storage = new MemoryStorage();
  readonly session = new MemoryStorage();

  /**
   * 注入 cookie 上下文（由主进程在每次投放/检测前调用）。
   * 同 hostname 的旧 cookie 被覆盖，避免过期 cookie 残留。
   */
  setCookieContext(url: string, cookies: SerializedCookie[]): void {
    const { hostname } = new URL(url);
    this.cookieStore.set(hostname, cookies);
  }

  // ============ RuntimeInterface: fetch ============

  async fetch(url: string, options: RequestInit = {}): Promise<Response> {
    const { origin, hostname } = new URL(url);
    const cookies = this.getCookiesForHostname(hostname);
    const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join("; ");

    const callerHeaders = normalizeHeaders(options.headers);
    // 注入 Cookie/Origin/Referer，调用方显式 header 优先（在后展开覆盖）
    const mergedHeaders: Record<string, string> = {
      Cookie: cookieHeader,
      Origin: origin,
      Referer: origin,
      ...callerHeaders,
    };

    return globalThis.fetch(url, { ...options, headers: mergedHeaders });
  }

  // ============ RuntimeInterface: cookies ============

  readonly cookies = {
    /** 按域名查询 cookie（返回 domain 完全匹配的 cookie） */
    get: async (domain: string): Promise<Cookie[]> => {
      const result: Cookie[] = [];
      for (const cookies of this.cookieStore.values()) {
        for (const c of cookies) {
          if (c.domain === domain) {
            result.push({ ...c, domain: c.domain ?? domain } as Cookie);
          }
        }
      }
      return result;
    },

    /** 新增 cookie */
    set: async (cookie: Cookie): Promise<void> => {
      const hostname = cookie.domain.startsWith(".")
        ? cookie.domain.slice(1)
        : cookie.domain;
      const existing = this.cookieStore.get(hostname) ?? [];
      existing.push(cookie);
      this.cookieStore.set(hostname, existing);
    },

    /** 移除指定域名+名称的 cookie */
    remove: async (name: string, domain: string): Promise<void> => {
      for (const [hostname, cookies] of this.cookieStore) {
        const filtered = cookies.filter(
          (c) => !(c.name === name && c.domain === domain),
        );
        this.cookieStore.set(hostname, filtered);
      }
    },
  };

  /** 获取指定 hostname 匹配的 cookie 值（便捷方法） */
  getCookie = async (domain: string, name: string): Promise<string | null> => {
    for (const cookies of this.cookieStore.values()) {
      for (const c of cookies) {
        if (c.name === name && c.domain === domain) {
          return c.value;
        }
      }
    }
    return null;
  };

  /** 查询匹配 hostname 的所有 cookie（用于 fetch 注入） */
  private getCookiesForHostname(hostname: string): SerializedCookie[] {
    const result: SerializedCookie[] = [];
    for (const cookies of this.cookieStore.values()) {
      for (const c of cookies) {
        if (c.domain && domainMatches(c.domain, hostname)) {
          result.push(c);
        }
      }
    }
    return result;
  }

  // ============ RuntimeInterface: dom（linkedom 动态加载） ============

  readonly dom = {
    async parseHTML(html: string): Promise<Document> {
      const { parseHTML } = await import("linkedom");
      const { document } = parseHTML(html);
      return document as unknown as Document;
    },

    querySelector(doc: Document, selector: string): Element | null {
      return doc.querySelector(selector);
    },

    querySelectorAll(doc: Document, selector: string): Element[] {
      return Array.from(doc.querySelectorAll(selector));
    },

    getTextContent(element: Element): string {
      return element.textContent ?? "";
    },

    getInnerHTML(element: Element): string {
      return element.innerHTML;
    },
  };
}
