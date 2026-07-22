/**
 * 头条号适配器
 *
 * # API 说明（基于实际抓包日志）
 *
 * ## 登录检测
 * GET https://mp.toutiao.com/mp/agw/creator_center/user_info?app_id=1231
 * 响应: { code: 0, name: "...", user_id_str: "...", avatar_url: "...", media_id: number, ... }
 *
 * ## 图片上传（两步）
 * 1. POST https://mp.toutiao.com/spice/image?upload_source=20020003&aid=1231&device_platform=web
 *    FormData: { image: binary }
 *    响应: { code: 0, data: { image_uri, image_url, ... } }
 *
 * 2. POST https://mp.toutiao.com/spice/image?upload_source=20020003&aid=1231&device_platform=web&need_cover_url=1
 *    FormData: { imageUrl: "<step1.image_url>" }
 *    响应: { code: 0, data: { cover_url, image_uri, ... } }
 *
 * ## 文章发布（草稿/发布共用同一 API，save 参数区分）
 * POST https://mp.toutiao.com/mp/agw/article/publish?source=mp&type=article&aid=1231&mp_publish_ab_val=0
 * Content-Type: application/x-www-form-urlencoded;charset=UTF-8
 *
 * save=0 → 正式发布（entrance 不传）
 * save=1 → 保存草稿（entrance=main）
 *
 * 响应: { code: 0, data: { pgc_id }, message: "保存成功"|"提交成功" }
 *
 * 预览链接: https://mp.toutiao.com/profile_v4/graphic/preview?pgc_id={pgc_id}
 * 发布链接: https://www.toutiao.com/article/{pgc_id}
 */
import { CodeAdapter, type ImageUploadResult } from '../code-adapter'
import type { Article, AuthResult, SyncResult, PlatformMeta } from '../../types'
import type { PublishOptions } from '../types'
import { createLogger } from '../../lib/logger'

const logger = createLogger('Toutiao')

interface ToutiaoUserInfo {
  user_id_str: string
  name: string
  avatar_url: string
  media_id: number
}

/** 头条号图片上传中间结果（含封面信息） */
interface ToutiaoImageData {
  image_uri: string
  image_url: string
  cover_url: string
}

export class ToutiaoAdapter extends CodeAdapter {
  readonly meta: PlatformMeta = {
    id: 'toutiaohao',
    name: '头条号',
    icon: 'https://mp.toutiao.com/favicon.ico',
    homepage: 'https://mp.toutiao.com/',
    capabilities: ['article', 'draft', 'image_upload'],
    needsReview: true,
  }

  /** 预处理配置: 头条号使用 HTML 格式 */
  readonly preprocessConfig = {
    outputFormat: 'html' as const,
  }

  private userInfo: ToutiaoUserInfo | null = null
  private csrfToken: string = ''
  private antiToken: string = ''
  private msToken: string = ''

  /** 头条号 API 需要的 Header 规则 */
  private readonly HEADER_RULES = [
    {
      urlFilter: '*://mp.toutiao.com/*',
      headers: {
        'Origin': 'https://mp.toutiao.com',
        'Referer': 'https://mp.toutiao.com/',
      },
      resourceTypes: ['xmlhttprequest'],
    },
  ]

  async checkAuth(): Promise<AuthResult> {
    try {
      const res = await this.get<{
        code: number
        message: string
        name?: string
        user_id_str?: string
        avatar_url?: string
        media_id?: number
      }>(`https://mp.toutiao.com/mp/agw/creator_center/user_info?app_id=1231&_=${Date.now()}`)

      logger.debug('checkAuth response:', res)

      if (res.code === 0 && res.name) {
        this.userInfo = {
          user_id_str: res.user_id_str || '',
          name: res.name,
          avatar_url: res.avatar_url || '',
          media_id: res.media_id || 0,
        }
        return {
          isAuthenticated: true,
          userId: res.user_id_str,
          username: res.name,
          avatar: res.avatar_url,
        }
      }

      return { isAuthenticated: false }
    } catch (error) {
      logger.debug('checkAuth: not logged in -', error)
      return { isAuthenticated: false, error: (error as Error).message }
    }
  }

  /**
   * 从 cookie 中读取安全凭证（参考搜狐号 getCookie 模式）
   *
   * 头条号发布 API 需要以下安全 header：
   * - x-secsdk-csrf-token: 从 passport_csrf_token cookie 派生
   * - tt-anti-token: 可选的客户端 token
   *
   * URL 上还需要:
   * - msToken: 从 cookie 或页面提取
   * - a_bogus: 反爬签名（由 secsdk 动态计算，较复杂）
   */
  private async fetchSecurityTokens(): Promise<void> {
    // 先尝试从 cookie 中读取
    const domains = ['.toutiao.com', 'mp.toutiao.com', '.mp.toutiao.com']
    for (const domain of domains) {
      try {
        if (this.runtime.getCookie) {
          // 1) passport_csrf_token → x-secsdk-csrf-token
          const token = await this.runtime.getCookie(domain, 'passport_csrf_token')
          if (token) {
            this.csrfToken = `000100000001${token}${token}`
            logger.debug(`Got passport_csrf_token from ${domain}, len=${token.length}`)
            break
          }
          // 兜底
          const sessionToken = await this.runtime.getCookie(domain, 'csrf_session_id')
          if (sessionToken) {
            this.csrfToken = `000100000001${sessionToken}${sessionToken}`
            logger.debug(`Got csrf_session_id from ${domain}`)
            break
          }
        }
      } catch {
        // 忽略单次失败
      }
    }

    // 2) tt-anti-token：从 cookie 读取
    for (const domain of domains) {
      try {
        if (this.runtime.getCookie) {
          const anti = await this.runtime.getCookie(domain, 'tt_anti_token')
          if (anti) {
            this.antiToken = anti
            logger.debug('Got tt-anti-token from cookie')
            break
          }
        }
      } catch {
        // ignore
      }
    }

    // 3) msToken：尝试从 cookie 读取（如果存在）
    for (const domain of domains) {
      try {
        if (this.runtime.getCookie) {
          const ms = await this.runtime.getCookie(domain, 'msToken')
          if (ms) {
            this.msToken = ms
            logger.debug('Got msToken from cookie')
            break
          }
        }
      } catch {
        // ignore
      }
    }

    logger.debug(`fetchSecurityTokens result: csrfToken=${this.csrfToken ? 'set(len=' + this.csrfToken.length + ')' : 'NOT_SET'}, antiToken=${this.antiToken ? 'set' : 'NOT_SET'}, msToken=${this.msToken ? 'set' : 'NOT_SET'}`)

    // 如果 csrfToken 仍未获取到，尝试从发布页 HTML 提取
    if (!this.csrfToken) {
      await this.fetchTokensFromPage()
    }
  }

  /**
   * 从发布页 HTML 中提取安全凭证（备用方案）
   * 头条号在页面中可能嵌入 __INIT_STATE__ 或 __NEXT_DATA__ 等包含 token 的变量
   */
  private async fetchTokensFromPage(): Promise<void> {
    try {
      const response = await this.runtime.fetch('https://mp.toutiao.com/profile_v4/graphic/publish', {
        credentials: 'include',
      })
      const html = await response.text()

      logger.debug(`Publish page status=${response.status}, htmlLen=${html.length}, first1000=${html.slice(0, 1000)}`)

      // 尝试多种模式提取 CSRF token
      const patterns = [
        /csrf_token['"]\s*[:=]\s*['"]([^'"]+)/,
        /window\.__INIT_STATE__\s*=\s*({.+?});/,
        /['"]csrfToken['"]\s*[:=]\s*['"]([^'"]+)/,
        /msToken['"]?\s*[:=]\s*['"]([^'"]+)/,
      ]
      for (const pat of patterns) {
        const m = html.match(pat)
        if (m) {
          logger.debug(`Pattern matched: ${pat.source.slice(0, 50)}..., value=${m[1].slice(0, 50)}`)
        }
      }
    } catch (e) {
      logger.debug('fetchTokensFromPage failed:', e)
    }
  }

  /**
   * 头条号图片上传（两步）：
   * 1. 上传二进制 → 获取 image_url / image_uri
   * 2. 上传 imageUrl → 获取 cover_url（封面用）
   */
  private async uploadImageToToutiao(src: string): Promise<ToutiaoImageData> {
    // Step 1: 上传二进制图片
    const imageResponse = await fetch(src)
    if (!imageResponse.ok) {
      throw new Error('图片下载失败: ' + src)
    }
    const imageBlob = await imageResponse.blob()

    const formData = new FormData()
    formData.append('image', imageBlob, 'image.jpg')

    const uploadUrl = 'https://mp.toutiao.com/spice/image?upload_source=20020003&aid=1231&device_platform=web'
    const uploadResponse = await this.runtime.fetch(uploadUrl, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'accept': '*/*',
      },
      body: formData,
    })

    const uploadText = await uploadResponse.text()
    logger.debug('Image step1 raw response:', uploadText)

    const uploadRes = JSON.parse(uploadText) as {
      code: number
      message: string
      data?: {
        image_uri: string
        image_url: string
        image_format: string
      }
    }

    if (uploadRes.code !== 0 || !uploadRes.data?.image_url) {
      throw new Error(uploadRes.message || '图片上传失败')
    }

    // Step 2: 上传 imageUrl 获取封面 URL
    const coverFormData = new FormData()
    coverFormData.append('imageUrl', uploadRes.data.image_url)

    const coverUrl = `${uploadUrl}&need_cover_url=1`
    const coverResponse = await this.runtime.fetch(coverUrl, {
      method: 'POST',
      credentials: 'include',
      body: coverFormData,
    })

    const coverText = await coverResponse.text()
    const coverRes = JSON.parse(coverText) as {
      code: number
      message: string
      data?: {
        cover_url?: string
        image_uri: string
      }
    }

    logger.debug('Image step2 (cover) response:', coverRes)

    return {
      image_uri: uploadRes.data.image_uri,
      image_url: uploadRes.data.image_url,
      cover_url: coverRes.data?.cover_url || '',
    }
  }

  protected async uploadImageByUrl(src: string): Promise<ImageUploadResult> {
    const result = await this.uploadImageToToutiao(src)
    return {
      url: result.image_url,
    }
  }

  async publish(article: Article, options?: PublishOptions): Promise<SyncResult> {
    return this.withHeaderRules(this.HEADER_RULES, async () => {
      logger.info('Starting publish...')

      if (!this.userInfo) {
        const auth = await this.checkAuth()
        if (!auth.isAuthenticated) {
          throw new Error('请先登录头条号')
        }
      }

      // 从 cookie 中获取安全凭证
      await this.fetchSecurityTokens()

      // 处理文章中的图片，同时收集封面图信息
      let content = article.html || ''
      const coverImages: Array<{ url: string; uri: string }> = []

      content = await this.processImages(
        content,
        async (src) => {
          const result = await this.uploadImageToToutiao(src)
          if (result.cover_url && result.image_uri) {
            coverImages.push({ url: result.cover_url, uri: result.image_uri })
          }
          return { url: result.image_url }
        },
        {
          skipPatterns: ['mp.toutiao.com', 'pstatp.com', 'toutiaoimg.com'],
          onProgress: options?.onImageProgress,
        }
      )

      // title_id = timestamp_media_id
      const mediaId = this.userInfo!.media_id
      const titleId = `${Date.now()}_${mediaId}`

      // extra 字段
      const extra = JSON.stringify({
        content_source: 100000000402,
        content_word_cnt: content.length,
        is_multi_title: 0,
        sub_titles: [],
        gd_ext: {
          entrance: '',
          from_page: 'publisher_mp',
          enter_from: 'PC',
          device_platform: 'mp',
          is_message: 0,
        },
        tuwen_wtt_trans_flag: '0',
      })

      // search_creation_info 字段
      const searchCreationInfo = JSON.stringify({
        searchTopOne: 0,
        abstract: '',
        clue_id: '',
      })

      const save = options?.draftOnly === false ? '0' : '1'

      // 构建 URLSearchParams
      const params = new URLSearchParams()
      params.set('pgc_id', '')
      params.set('source', '29')
      params.set('extra', extra)
      params.set('content', content)
      params.set('title', article.title)
      params.set('search_creation_info', searchCreationInfo)
      params.set('title_id', titleId)
      params.set('mp_editor_stat', '{}')
      params.set('is_refute_rumor', '0')
      params.set('save', save)
      if (save === '1') {
        params.set('entrance', 'main')
      }
      params.set('is_app_preview', '1')
      params.set('timer_status', '0')
      params.set('timer_time', '')
      params.set('educluecard', '')
      params.set('draft_form_data', JSON.stringify({ coverType: coverImages.length > 0 ? 2 : 0 }))
      params.set('article_ad_type', '2')
      params.set('is_fans_article', '0')
      params.set('govern_forward', '0')
      params.set('praise', '0')
      params.set('disable_praise', '0')
      params.set('tree_plan_article', '0')
      params.set('activity_tag', '0')
      params.set('trends_writing_tag', '0')
      params.set('claim_exclusive', '0')

      // 设置封面图
      if (coverImages.length > 0) {
        const pgcFeedCovers = JSON.stringify(
          coverImages.map((img) => ({
            id: '',
            url: img.url,
            uri: img.uri,
            ic_uri: '',
            thumb_width: 0,
            thumb_height: 0,
            extra: { from_content_uri: '', from_content: '0' },
          }))
        )
        params.set('pgc_feed_covers', pgcFeedCovers)
      }

      const publishUrl = `https://mp.toutiao.com/mp/agw/article/publish?source=mp&type=article&aid=1231&mp_publish_ab_val=0${this.msToken ? '&msToken=' + encodeURIComponent(this.msToken) : ''}`

      logger.debug(`publishUrl: ${publishUrl.slice(0, 80)}...`)
      logger.debug(`csrfToken: ${this.csrfToken ? this.csrfToken.slice(0, 30) + '...' : 'NOT_SET'}`)

      // 构建请求 header（必需的安全凭证从 cookie 读取）
      const requestHeaders: Record<string, string> = {
        'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
      }
      if (this.csrfToken) {
        requestHeaders['x-secsdk-csrf-token'] = this.csrfToken
      }
      if (this.antiToken) {
        requestHeaders['tt-anti-token'] = this.antiToken
      }

      const response = await this.runtime.fetch(publishUrl, {
        method: 'POST',
        credentials: 'include',
        headers: requestHeaders,
        body: params.toString(),
      })

      const text = await response.text()
      logger.debug('Publish raw response:', text)

      const res = JSON.parse(text) as {
        code: number
        message: string
        reason: string
        data?: { pgc_id: string; content: string }
        err_no: number
      }

      logger.debug('Publish response:', res)

      if (res.code !== 0 || !res.data?.pgc_id) {
        throw new Error(res.message || res.reason || '发布失败')
      }

      const postId = res.data.pgc_id
      const previewUrl = `https://mp.toutiao.com/profile_v4/graphic/preview?pgc_id=${postId}`

      if (save === '0') {
        // 正式发布
        const articleUrl = `https://www.toutiao.com/article/${postId}`
        logger.debug('Publish success')
        return this.createResult(true, {
          postId,
          postUrl: articleUrl,
          previewUrl,
          draftOnly: false,
        })
      }

      // 草稿模式
      return this.createResult(true, {
        postId,
        postUrl: previewUrl,
        previewUrl,
        draftOnly: true,
      })
    }).catch((error) => this.createResult(false, {
      error: (error as Error).message,
    }))
  }
}
