/**
 * CSDN 适配器
 */
import { CodeAdapter, type ImageUploadResult } from '../code-adapter'
import type { Article, AuthResult, SyncResult, PlatformMeta } from '../../types'
import type { PublishOptions } from '../types'
import { createLogger } from '../../lib/logger'

const logger = createLogger('CSDN')

interface CSDNUserInfo {
  csdnid: string
  username: string
  avatarurl: string
}

export class CSDNAdapter extends CodeAdapter {
  readonly meta: PlatformMeta = {
    id: 'csdn',
    name: 'CSDN',
    icon: 'https://g.csdnimg.cn/static/logo/favicon32.ico',
    homepage: 'https://www.csdn.net/',
    capabilities: ['article', 'draft', 'image_upload', 'tags'],
    needsReview: false,
  }

  /** 预处理配置: CSDN 使用 Markdown 格式 */
  readonly preprocessConfig = {
    outputFormat: 'markdown' as const,
  }

  private userInfo: CSDNUserInfo | null = null

  // CSDN API 签名密钥
  private readonly API_KEY = '203803574'
  private readonly API_SECRET = '9znpamsyl2c7cdrr9sas0le9vbc3r6ba'

  /** CSDN API 需要的 Header 规则 */
  private readonly HEADER_RULES = [
    {
      urlFilter: '*://bizapi.csdn.net/*',
      headers: {
        'Origin': 'https://editor.csdn.net',
        'Referer': 'https://editor.csdn.net/',
      },
      resourceTypes: ['xmlhttprequest'],
    },
    {
      urlFilter: '*://imgservice.csdn.net/*',
      headers: {
        'Origin': 'https://editor.csdn.net',
        'Referer': 'https://editor.csdn.net/',
      },
      resourceTypes: ['xmlhttprequest'],
    },
    {
      urlFilter: '*://csdn-img-blog.obs.cn-north-4.myhuaweicloud.com/*',
      headers: {
        'Origin': 'https://editor.csdn.net',
        'Referer': 'https://editor.csdn.net/',
      },
      resourceTypes: ['xmlhttprequest'],
    },
  ]

  async checkAuth(): Promise<AuthResult> {
    try {
      // 使用带签名的 API
      const apiPath = '/blog-console-api/v3/editor/getBaseInfo'
      const headers = await this.signRequest(apiPath, 'GET')

      const response = await this.runtime.fetch(
        `https://bizapi.csdn.net${apiPath}`,
        {
          method: 'GET',
          credentials: 'include',
          headers,
        }
      )

      const res = await response.json() as {
        code: number
        data?: {
          name: string
          nickname: string
          avatar: string
          blog_url: string
        }
      }

      logger.debug('checkAuth response:', res)

      if (res.code === 200 && res.data?.name) {
        this.userInfo = {
          csdnid: res.data.name,
          username: res.data.nickname || res.data.name,
          avatarurl: res.data.avatar,
        }
        return {
          isAuthenticated: true,
          userId: res.data.name,
          username: res.data.nickname || res.data.name,
          avatar: res.data.avatar,
        }
      }

      return { isAuthenticated: false }
    } catch (error) {
      logger.debug('checkAuth: not logged in -', error)
      return { isAuthenticated: false, error: (error as Error).message }
    }
  }

  /**
   * 生成 UUID
   */
  private createUuid(): string {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = Math.random() * 16 | 0
      const v = c === 'x' ? r : (r & 0x3 | 0x8)
      return v.toString(16)
    })
  }

  /**
   * HMAC-SHA256 签名 (使用 Web Crypto API)
   */
  private async hmacSha256(message: string, secret: string): Promise<string> {
    const encoder = new TextEncoder()
    const keyData = encoder.encode(secret)
    const messageData = encoder.encode(message)

    const cryptoKey = await crypto.subtle.importKey(
      'raw',
      keyData,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    )

    const signature = await crypto.subtle.sign('HMAC', cryptoKey, messageData)

    // 转换为 Base64
    const bytes = new Uint8Array(signature)
    let binary = ''
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i])
    }
    return btoa(binary)
  }

  /**
   * 生成 CSDN API 签名
   * 签名格式: METHOD + Accept + Content-MD5 + Content-Type + Headers + Path
   */
  private async signRequest(apiPath: string, method: 'GET' | 'POST' = 'POST'): Promise<Record<string, string>> {
    const nonce = this.createUuid()

    // GET: 没有 Content-Type，所以那一行为空
    // POST: Content-Type 为 application/json
    const signStr = method === 'GET'
      ? `GET\n*/*\n\n\n\nx-ca-key:${this.API_KEY}\nx-ca-nonce:${nonce}\n${apiPath}`
      : `POST\n*/*\n\napplication/json\n\nx-ca-key:${this.API_KEY}\nx-ca-nonce:${nonce}\n${apiPath}`

    // logger.debug('Sign string:', JSON.stringify(signStr))

    const signature = await this.hmacSha256(signStr, this.API_SECRET)

    const headers: Record<string, string> = {
      'accept': '*/*',
      'x-ca-key': this.API_KEY,
      'x-ca-nonce': nonce,
      'x-ca-signature': signature,
      'x-ca-signature-headers': 'x-ca-key,x-ca-nonce',
    }

    if (method === 'POST') {
      headers['content-type'] = 'application/json'
    }

    return headers
  }

  async publish(article: Article, options?: PublishOptions): Promise<SyncResult> {
    return this.withHeaderRules(this.HEADER_RULES, async () => {
      logger.info('Starting publish...')
      logger.debug('[Step 1/4] Publish info: title="%s", tags=%s, coverImages=%d, draftOnly=%s',
        article.title, article.tags?.join(','), article.coverImages?.length || 0, options?.draftOnly)

      // 1. 确保已登录
      if (!this.userInfo) {
        const auth = await this.checkAuth()
        if (!auth.isAuthenticated) {
          throw new Error('请先登录 CSDN')
        }
      }

      // 2. 处理图片
      let markdown = article.markdown || ''
      // logger.debug('[Step 1/4] Processing inline images, markdown length=%d', markdown.length)
      markdown = await this.processImages(
        markdown,
        (src) => this.uploadImageByUrl(src),
        {
          skipPatterns: ['csdnimg.cn', 'csdn.net'],
          onProgress: options?.onImageProgress,
        }
      )

      // ====== 封面图处理 ======
      let uploadedCoverUrls: string[] = []
      if (article.coverImages && article.coverImages.length > 0) {
        // logger.debug('[Step 1/4] Uploading cover image, dataUri prefix: %s...', article.coverImages[0].substring(0, 50))
        try {
          const url = await this.uploadCoverImage(article.coverImages[0])
          uploadedCoverUrls.push(url)
          logger.debug('[Step 1/4] Cover image upload success: %s', url)
        } catch (e) {
          logger.error('[Step 1/4] 封面上传失败:', e)
        }
      } else {
        logger.debug('[Step 1/4] No cover images provided, skipping')
      }

      const htmlContent = article.html || ''
      const isPublish = options?.draftOnly === false

      // Step 2: 保存草稿 → 获取 article_id
      const draftApiPath = '/blog-console-api/v3/mdeditor/saveArticle'
      const draftHeaders = await this.signRequest(draftApiPath)

      logger.debug('[Step 2/4] Saving draft, cover_images=%s',
        JSON.stringify(uploadedCoverUrls))
      const draftResponse = await this.runtime.fetch(
        `https://bizapi.csdn.net${draftApiPath}`,
        {
          method: 'POST',
          credentials: 'include',
          headers: draftHeaders,
          body: JSON.stringify({
            title: article.title,
            markdowncontent: markdown,
            content: htmlContent,
            readType: 'public',
            level: 0,
            tags: article.tags && article.tags.length > 0 ? article.tags.join(',') : '其他',
            status: 2, // 始终先保存为草稿
            categories: '',
            type: 'original',
            original_link: '',
            authorized_status: false,
            not_auto_saved: '1',
            source: 'pc_mdeditor',
            cover_images: uploadedCoverUrls,
            cover_type: 1,
            is_new: 1,
            vote_id: 0,
            resource_id: '',
            pubStatus: 'draft',
            creator_activity_id: '',
          }),
        }
      )

      const draftRes = await draftResponse.json() as {
        code: number
        message?: string
        msg?: string
        data?: { id: string }
      }

      logger.debug('[Step 2/4] Save draft response: code=%d, article_id=%s',
        draftRes.code, draftRes.data?.id)

      if (draftRes.code !== 200 || !draftRes.data?.id) {
        throw new Error(draftRes.msg || draftRes.message || '保存草稿失败')
      }

      const postId = draftRes.data.id

      // 如果只保存草稿，直接返回
      if (!isPublish) {
        const draftUrl = `https://editor.csdn.net/md?articleId=${postId}`
        logger.debug('[Step 2/4] Draft only mode, draftUrl=%s', draftUrl)
        return this.createResult(true, {
          postId,
          postUrl: draftUrl,
          previewUrl: draftUrl,
          draftOnly: true,
        })
      }

      // Step 3: 通过 postedit API 发布
      const publishApiPath = '/blog-console-api/v1/postedit/saveArticle'
      const publishHeaders = await this.signRequest(publishApiPath)
      const description = this.extractDescription(markdown || htmlContent)

      logger.debug('[Step 3/4] Publishing article, article_id=%s, cover_images=%s',
        postId, JSON.stringify(uploadedCoverUrls))
      const publishResponse = await this.runtime.fetch(
        `https://bizapi.csdn.net${publishApiPath}`,
        {
          method: 'POST',
          credentials: 'include',
          headers: publishHeaders,
          body: JSON.stringify({
            article_id: postId,
            title: article.title,
            description,
            content: htmlContent,
            tags: article.tags && article.tags.length > 0 ? article.tags.join(',') : '其他',
            categories: '',
            type: 'original',
            status: 0,
            read_type: 'public',
            creation_statement: 0,
            reason: '',
            original_link: '',
            authorized_status: false,
            check_original: false,
            source: 'pc_postedit',
            not_auto_saved: 1,
            creator_activity_id: '',
            cover_images: uploadedCoverUrls,
            cover_type: 1,
            vote_id: 0,
            resource_id: '',
            scheduled_time: 0,
            markdowncontent: markdown,
            resource_url: '',
            editor_type: 0,
            plan: [],
            level: '0',
            strategy: null,
            is_new: 0,
            sync_git_code: 0,
          }),
        }
      )

      const publishRes = await publishResponse.json() as {
        code: number
        message?: string
        msg?: string
        data?: {
          url: string
          article_id: number
          title: string
          description: string
        }
      }

      logger.debug('[Step 3/4] Publish response: code=%d, msg=%s, url=%s',
        publishRes.code, publishRes.msg || publishRes.message, publishRes.data?.url)

      if (publishRes.code !== 200 || !publishRes.data?.url) {
        throw new Error(publishRes.msg || publishRes.message || '发布失败')
      }

      logger.debug('[Step 4/4] Publish success, postUrl=%s', publishRes.data.url)
      return this.createResult(true, {
        postId,
        postUrl: publishRes.data.url,
        previewUrl: publishRes.data.url,
        draftOnly: false,
      })
    }).catch((error) => this.createResult(false, {
      error: (error as Error).message,
    }))
  }

  /**
   * 从内容中提取摘要（去掉 Markdown 格式，取前 ~100 字符）
   */
  private extractDescription(content: string): string {
    const cleaned = content
      .replace(/!\[.*?\]\(.*?\)/g, '') // 移除图片
      .replace(/\[([^\]]*)\]\(.*?\)/g, '$1') // 移除链接，保留文字
      .replace(/#{1,6}\s/g, '') // 移除标题标记
      .replace(/[*_~`]/g, '') // 移除格式符号
      .replace(/\n+/g, ' ') // 换行转空格
      .trim()

    return cleaned.length > 100 ? cleaned.substring(0, 100) + '...' : cleaned
  }

  /**
   * 通过 Blob 上传图片（覆盖基类方法）
   * 需要设置动态请求头规则以支持 MCP 调用
   */
  async uploadImage(file: Blob, _filename?: string): Promise<string> {
    return this.withHeaderRules(this.HEADER_RULES, async () => {
      // logger.debug('uploadImage: file type=%s, size=%d bytes', file.type, file.size)
      // 转为 data URI 然后调用 uploadImageByUrl
      const dataUri = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(reader.result as string)
        reader.onerror = reject
        reader.readAsDataURL(file)
      })
      const result = await this.uploadImageByUrl(dataUri)
      // logger.debug('uploadImage: success, url=%s', result.url)
      return result.url
    })
  }

  /**
   * 上传封面图到 CSDN 图床（OBS）
   * 复用 uploadImageByUrl 将 base64 data URI 上传到 OBS，返回可公开访问的图片 URL
   */
  protected async uploadCoverImage(dataUri: string): Promise<string> {
    // logger.debug('uploadCoverImage: dataUri prefix=%s...', dataUri.substring(0, 50))
    const result = await this.uploadImageByUrl(dataUri)
    // logger.debug('uploadCoverImage: success, url=%s', result.url)
    return result.url
  }

  /**
   * 通过 URL 上传图片
   * 三步流程：
   *   [Step 1/3] 下载图片 → 获取 Blob
   *   [Step 2/3] 获取 OBS 上传签名
   *   [Step 3/3] 上传到华为云 OBS → 返回公开 URL
   */
  protected async uploadImageByUrl(src: string): Promise<ImageUploadResult> {
    // 1. 下载图片
    // logger.debug('[uploadImage 1/3] Downloading image from src: %s...', src.substring(0, 80))
    const imageResponse = await fetch(src)
    if (!imageResponse.ok) {
      throw new Error('图片下载失败: ' + src)
    }
    const imageBlob = await imageResponse.blob()
    // logger.debug('[uploadImage 1/3] Downloaded: blob type=%s, size=%d bytes', imageBlob.type, imageBlob.size)

    // 2. 获取文件扩展名
    const ext = src.split('.').pop()?.toLowerCase()?.split('?')[0] || 'jpg'
    const validExt = ['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(ext) ? ext : 'jpg'

    // 3. 获取上传签名 (新 API: bizapi.csdn.net)
    const apiPath = '/resource-api/v1/image/direct/upload/signature'
    const headers = await this.signRequest(apiPath, 'POST')

    // logger.debug('[uploadImage 2/3] Getting upload signature, appName=direct_blog_markdown, suffix=%s', validExt)
    const signatureRes = await this.runtime.fetch(
      `https://bizapi.csdn.net${apiPath}`,
      {
        method: 'POST',
        credentials: 'include',
        headers,
        body: JSON.stringify({
          imageTemplate: '',
          appName: 'direct_blog_markdown',
          imageSuffix: validExt,
        }),
      }
    )

    const signatureData = await signatureRes.json() as {
      code: number
      data?: {
        filePath: string
        host: string
        accessId: string
        policy: string
        signature: string
        callbackUrl: string
        callbackBody: string
        callbackBodyType: string
        customParam: {
          rtype: string
          filePath: string
          isAudit: number
          'x-image-app': string
          type: string
          'x-image-suffix': string
          username: string
        }
      }
    }

    // logger.debug('[uploadImage 2/3] Signature response: code=%d, filePath=%s, host=%s',
    //   signatureData.code, signatureData.data?.filePath, signatureData.data?.host)

    if (signatureData.code !== 200 || !signatureData.data) {
      logger.warn('[uploadImage 2/3] Failed to get upload signature, using original URL')
      return { url: src }
    }

    const uploadData = signatureData.data
    const customParam = uploadData.customParam

    // 4. 上传到华为云 OBS
    // logger.debug('[uploadImage 3/3] Uploading to OBS, host=%s, filePath=%s', uploadData.host, uploadData.filePath)
    const formData = new FormData()
    formData.append('key', uploadData.filePath)
    formData.append('policy', uploadData.policy)
    formData.append('signature', uploadData.signature)
    formData.append('callbackBody', uploadData.callbackBody)
    formData.append('callbackBodyType', uploadData.callbackBodyType)
    formData.append('callbackUrl', uploadData.callbackUrl)
    formData.append('AccessKeyId', uploadData.accessId)
    formData.append('x:rtype', customParam.rtype)
    formData.append('x:filePath', customParam.filePath)
    formData.append('x:isAudit', String(customParam.isAudit))
    formData.append('x:x-image-app', customParam['x-image-app'])
    formData.append('x:type', customParam.type)
    formData.append('x:x-image-suffix', customParam['x-image-suffix'])
    formData.append('x:username', customParam.username)
    formData.append('file', imageBlob, `image.${validExt}`)

    const obsResponse = await this.runtime.fetch(uploadData.host, {
      method: 'POST',
      body: formData,
    })

    const obsRes = await obsResponse.json() as {
      code: number
      data?: { imageUrl: string }
    }

    // logger.debug('[uploadImage 3/3] OBS upload response: code=%d, imageUrl=%s',
    //   obsRes.code, obsRes.data?.imageUrl)

    if (obsRes.code !== 200 || !obsRes.data?.imageUrl) {
      logger.warn('[uploadImage 3/3] OBS upload failed, using original URL')
      return { url: src }
    }

    return {
      url: obsRes.data.imageUrl,
    }
  }
}
