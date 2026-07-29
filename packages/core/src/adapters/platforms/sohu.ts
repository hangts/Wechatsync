/**
 * 搜狐号适配器
 */
import { CodeAdapter, type ImageUploadResult } from '../code-adapter'
import type { Article, AuthResult, SyncResult, PlatformMeta } from '../../types'
import type { PublishOptions } from '../types'
import { createLogger } from '../../lib/logger'

const logger = createLogger('Sohu')

interface SohuAccountInfo {
  id: string
  nickName: string
  avatar: string
}

/**
 * 生成设备 ID (dv-id)
 */
function generateDeviceId(): string {
  const chars = '0123456789abcdef'
  let result = ''
  for (let i = 0; i < 32; i++) {
    result += chars[Math.floor(Math.random() * chars.length)]
  }
  return result
}

export class SohuAdapter extends CodeAdapter {
  readonly meta: PlatformMeta = {
    id: 'sohu',
    name: '搜狐号',
    icon: 'https://mp.sohu.com/favicon.ico',
    homepage: 'https://mp.sohu.com/mpfe/v3/main/first/page?newsType=1',
    capabilities: ['article', 'draft', 'image_upload'],
    needsReview: true,
  }

  /** 预处理配置: 搜狐号使用 HTML 格式 */
  readonly preprocessConfig = {
    outputFormat: 'html' as const,
  }

  private accountInfo: SohuAccountInfo | null = null
  private deviceId: string = generateDeviceId()
  private spCm: string = ''

  /** 搜狐号 API 需要的 Header 规则 */
  private readonly HEADER_RULES = [
    {
      urlFilter: '*://mp.sohu.com/*',
      headers: {
        'Origin': 'https://mp.sohu.com',
        'Referer': 'https://mp.sohu.com/',
      },
      resourceTypes: ['xmlhttprequest'],
    },
  ]

  async checkAuth(): Promise<AuthResult> {
    try {
      // 使用 /account/list 获取所有子账号（搜狐号支持多个子账号）
      const response = await this.runtime.fetch(
        `https://mp.sohu.com/mpbp/bp/account/list?_=${Date.now()}`,
        {
          method: 'GET',
          credentials: 'include',
        }
      )

      const res = await response.json() as {
        code: number
        data?: {
          data?: Array<{
            accounts: SohuAccountInfo[]
          }>
        }
      }

      // logger.debug('checkAuth response:', res)

      if (res.code !== 2000000 || !res.data?.data?.[0]?.accounts?.length) {
        return { isAuthenticated: false }
      }

      // 收集所有子账号
      const allAccounts: SohuAccountInfo[] = []
      for (const group of res.data.data) {
        if (group.accounts) {
          allAccounts.push(...group.accounts)
        }
      }

      if (allAccounts.length === 0) {
        return { isAuthenticated: false }
      }

      // 默认使用第一个子账号
      this.accountInfo = allAccounts[0]
      logger.info(`Using account: ${this.accountInfo.nickName} (id: ${this.accountInfo.id})` +
        (allAccounts.length > 1 ? `, ${allAccounts.length} sub-accounts available` : ''))

      // 获取 mp-cv cookie 用于 sp-cm header
      await this.fetchSpCm()

      // 如果有多个子账号，在用户名中标注
      const displayName = allAccounts.length > 1
        ? `${this.accountInfo.nickName} (共${allAccounts.length}个子账号)`
        : this.accountInfo.nickName

      return {
        isAuthenticated: true,
        userId: String(this.accountInfo.id),
        username: displayName,
        avatar: this.accountInfo.avatar,
      }
    } catch (error) {
      logger.debug('checkAuth: not logged in -', error)
      return { isAuthenticated: false, error: (error as Error).message }
    }
  }

  /**
   * 获取 sp-cm 值 (从 cookie 或生成)
   */
  private async fetchSpCm(): Promise<void> {
    try {
      // 尝试通过 runtime 获取 cookie（如果支持）
      if (this.runtime.getCookie) {
        const cookieValue = await this.runtime.getCookie('.sohu.com', 'mp-cv')
        if (cookieValue) {
          this.spCm = cookieValue
          // logger.debug('Got sp-cm from cookie:', this.spCm)
          return
        }
      }
      // fallback: 生成一个
      this.spCm = `100-${Date.now()}-${generateDeviceId()}`
      // logger.debug('Generated sp-cm:', this.spCm)
    } catch (error) {
      // fallback: 生成一个
      this.spCm = `100-${Date.now()}-${generateDeviceId()}`
      // logger.debug('Fallback sp-cm:', this.spCm)
    }
  }

  async publish(article: Article, options?: PublishOptions): Promise<SyncResult> {
    return this.withHeaderRules(this.HEADER_RULES, async () => {
      logger.info('Starting publish...')

      // 1. 确保已登录
      if (!this.accountInfo) {
        const auth = await this.checkAuth()
        if (!auth.isAuthenticated) {
          throw new Error('请先登录搜狐号')
        }
      }

      // Use pre-processed HTML content directly
      let content = article.html || ''

      // Process images
      content = await this.processImages(
        content,
        (src) => this.uploadImageByUrl(src),
        {
          skipPatterns: ['sohu.com'],
          onProgress: options?.onImageProgress,
        }
      )

      // ====== 封面图处理 ======
      let coverUrl = ''
      if (article.coverImages && article.coverImages.length > 0) {
        // logger.debug(`Cover images count: ${article.coverImages.length}, first image type: ${article.coverImages[0].substring(0, 30)}...`)
        try {
          coverUrl = await this.uploadCoverImage(article.coverImages[0])
          // logger.debug('Cover upload success, coverUrl:', coverUrl)
        } catch (e) {
          logger.error('封面上传失败:', e)
        }
      } else {
        // logger.debug('No cover images provided, skipping cover upload')
      }

      // 4. 保存草稿 (v2 API - JSON 格式)
      const postData = {
        title: article.title,
        brief: '',
        content: content,
        channelId: 24,
        categoryId: -1,
        id: 0,
        userColumnId: 0,
        columnNewsIds: [],
        businessCode: 0,
        declareOriginal: false,
        cover: coverUrl,
        topicIds: [],
        isAd: 0,
        userLabels: '[]',
        reprint: false,
        customTags: '',
        infoResource: 0,
        sourceUrl: '',
        visibleToLoginedUsers: 0,
        attrIds: [],
        auto: true,
        accountId: Number(this.accountInfo!.id),
      }

      const response = await this.runtime.fetch(
        `https://mp.sohu.com/mpbp/bp/news/v4/news/draft/v2?accountId=${this.accountInfo!.id}`,
        {
          method: 'POST',
          credentials: 'include',
          headers: {
            'Content-Type': 'application/json',
            'X-Requested-With': 'XMLHttpRequest',
            'dv-id': this.deviceId,
            'sp-cm': this.spCm,
          },
          body: JSON.stringify(postData),
        }
      )

      const res = await response.json() as {
        success: boolean
        data?: string | number
        msg?: string
      }

      // logger.debug(' Save response:', res)

      if (!res.success) {
        throw new Error(res.msg || '保存失败')
      }

      const postId = res.data
      const draftUrl = `https://mp.sohu.com/mpfe/v4/contentManagement/news/addarticle?spm=smmp.articlelist.0.0&contentStatus=2&id=${postId}`

      // 正式发布
      if (options?.draftOnly === false) {
        try {
          const publishResponse = await this.runtime.fetch(
            `https://mp.sohu.com/mpbp/bp/news/v4/news/publish/v2?accountId=${this.accountInfo!.id}`,
            {
              method: 'POST',
              credentials: 'include',
              headers: {
                'Content-Type': 'application/json',
                'X-Requested-With': 'XMLHttpRequest',
                'dv-id': this.deviceId,
                'sp-cm': this.spCm,
              },
              body: JSON.stringify({
                title: article.title,
                brief: '',
                content: content,
                channelId: 24,
                categoryId: -1,
                id: Number(postId),
                userColumnId: null,
                columnNewsIds: [],
                businessCode: 0,
                declareOriginal: false,
                cover: coverUrl || null,
                topicIds: [],
                isAd: 0,
                userLabels: '[]',
                reprint: false,
                customTags: '',
                infoResource: 0,
                sourceUrl: null,
                visibleToLoginedUsers: 0,
                attrIds: [],
                accountId: Number(this.accountInfo!.id),
              }),
            }
          )
          if (publishResponse.ok) {
            const publishRes = await publishResponse.json() as { data?: number; success?: boolean; msg?: string }
            if (publishRes.success) {
              const accountId = Number(this.accountInfo!.id)
              const articleUrl = `https://www.sohu.com/a/${postId}_${accountId}`
              const previewUrl = `https://mp.sohu.com/mpfe/v4/contentManagement/news/articlepreview?id=${postId}&accountId=${accountId}`
              logger.debug('Publish success:', articleUrl)
              return this.createResult(true, {
                postId: String(postId),
                postUrl: articleUrl,
                previewUrl: previewUrl,
                draftOnly: false,
              })
            }
            // 发布失败，返回草稿
            const errMsg = publishRes.msg || '发布失败'
            logger.warn('Publish failed, falling back to draft:', errMsg)
            return this.createResult(true, {
              postId: String(postId),
              postUrl: draftUrl,
              previewUrl: draftUrl,     // 草稿场景预览 URL = 草稿 URL
              draftOnly: true,
              error: `发布失败: ${errMsg}`,
            })
          }
          // 发布失败，返回草稿
          const errText = await publishResponse.text()
          logger.warn('Publish failed, falling back to draft:', publishResponse.status, errText)
          return this.createResult(true, {
            postId: String(postId),
            postUrl: draftUrl,
            previewUrl: draftUrl,     // 草稿场景预览 URL = 草稿 URL
            draftOnly: true,
            error: `发布失败: ${publishResponse.status} - ${errText}`,
          })
        } catch (e) {
          // 发布异常，返回草稿 + 错误信息
          logger.warn('Publish error, falling back to draft:', e)
          return this.createResult(true, {
            postId: String(postId),
            postUrl: draftUrl,
            previewUrl: draftUrl,     // 草稿场景预览 URL = 草稿 URL
            draftOnly: true,
            error: `发布失败: ${(e as Error).message}`,
          })
        }
      }

      // 草稿模式
      return this.createResult(true, {
        postId: String(postId),
        postUrl: draftUrl,
        previewUrl: draftUrl,   // 草稿场景预览 URL = 草稿 URL
        draftOnly: options?.draftOnly ?? true,
      })
    }).catch((error) => this.createResult(false, {
      error: (error as Error).message,
    }))
  }

  /**
   * 通过 URL 上传图片
   */
  protected async uploadImageByUrl(src: string): Promise<ImageUploadResult> {
    if (!this.accountInfo) {
      throw new Error('未登录')
    }

    // 1. 下载图片
    const imageResponse = await fetch(src)
    if (!imageResponse.ok) {
      throw new Error('图片下载失败: ' + src)
    }
    const imageBlob = await imageResponse.blob()

    // 2. 上传到搜狐
    const formData = new FormData()
    formData.append('file', imageBlob, 'image.jpg')
    formData.append('accountId', this.accountInfo.id)

    const uploadResponse = await this.runtime.fetch(
      'https://mp.sohu.com/commons/front/outerUpload/image/file?accountId='+  this.accountInfo.id,
      {
        method: 'POST',
        credentials: 'include',
        body: formData,
      }
    )

    const res = await uploadResponse.json() as {
      url?: string
      msg?: string
    }

    // logger.debug(' Image upload response:', res)
    if (!res.url) {
      throw new Error('图片上传失败:'+ (res.msg))
    }

    return {
      url: res.url,
    }
  }

  /**
   * 将 base64 data URI 转换为 Blob
   */
  protected async dataUriToBlob(dataUri: string): Promise<Blob> {
    const matches = dataUri.match(/^data:([^;]+);base64,(.+)$/)
    if (!matches) {
      throw new Error('无效的封面图数据')
    }
    const mimeType = matches[1]
    const base64Data = matches[2]
    const byteCharacters = atob(base64Data)
    const byteArrays: Uint8Array[] = []
    for (let offset = 0; offset < byteCharacters.length; offset += 512) {
      const slice = byteCharacters.slice(offset, offset + 512)
      const byteNumbers = new Array(slice.length)
      for (let i = 0; i < slice.length; i++) {
        byteNumbers[i] = slice.charCodeAt(i)
      }
      byteArrays.push(new Uint8Array(byteNumbers))
    }
    return new Blob(byteArrays as BlobPart[], { type: mimeType })
  }

  /**
   * 上传封面图到搜狐号
   * 流程 (基于抓包日志):
   * 1. POST /commons/front/outerUpload/image/file -> 上传图片, 返回原始 URL
   * 2. POST /mpbp/bp/user/resource/add -> 注册资源到媒体库
   * 3. POST /commons/front/outerUpload/image/thumbnail/url -> 生成缩略图 URL
   */
  protected async uploadCoverImage(dataUri: string): Promise<string> {
    // logger.debug('[Step 1/3] Starting cover image upload, dataUri prefix:', dataUri.substring(0, 50) + '...')

    // 1. 转换 base64 为 Blob 并上传
    const blob = await this.dataUriToBlob(dataUri)
    // logger.debug(`[Step 1/3] Blob created: ${blob.size} bytes, type: ${blob.type}`)

    const uploadUrl = `https://mp.sohu.com/commons/front/outerUpload/image/file?accountId=${this.accountInfo!.id}`
    const formData = new FormData()
    formData.append('file', blob, 'cover.jpg')
    formData.append('accountId', this.accountInfo!.id)

    // logger.debug('[Step 1/3] Uploading to:', uploadUrl)
    const uploadResponse = await this.runtime.fetch(uploadUrl, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'X-Requested-With': 'XMLHttpRequest',
        'dv-id': this.deviceId,
        'sp-cm': this.spCm,
      },
      body: formData,
    })

    if (!uploadResponse.ok) {
      const errText = await uploadResponse.text()
      throw new Error(`图片上传失败 HTTP ${uploadResponse.status}: ${errText}`)
    }

    const uploadResult = await uploadResponse.json() as {
      url?: string
      width?: number
      height?: number
      size?: number
      type?: string
      msg?: string
    }

    // logger.debug('[Step 1/3] Upload response:', uploadResult)

    if (!uploadResult.url) {
      throw new Error('封面上传失败:' + (uploadResult.msg || '未知错误'))
    }

    const originalUrl = uploadResult.url
    const width = uploadResult.width || 560
    const height = uploadResult.height || 560
    const imageType = uploadResult.type || 'jpeg'
    const imageSize = uploadResult.size || 0

    // 2. 注册资源到媒体库
    // logger.debug('[Step 2/3] Adding resource to media library, accountId:', this.accountInfo!.id)
    const filename = `cover-${Date.now()}.${imageType}`
    const showUrl = originalUrl.replace(
      '//res.mp.sohu.com/',
      '//res.mp.sohu.com/a_auto,c_zoom,w_0.4/'
    )
    const contentItem = {
      url: originalUrl,
      showUrl: showUrl,
      urlOriginal: originalUrl,
      status: 'resolved',
      type: imageType,
      filename: filename,
      size: imageSize,
      errorType: '',
      error: '',
      description: '',
      file: {} as Record<string, never>,
      width: width,
      height: height,
      ratio: width / height,
    }

    const addResourceBody = new URLSearchParams()
    addResourceBody.set('names', JSON.stringify([filename]))
    addResourceBody.set('contents', JSON.stringify([contentItem]))
    addResourceBody.set('accountId', this.accountInfo!.id)

    // logger.debug('[Step 2/3] Add resource body (url-encoded):', addResourceBody.toString())

    const addResponse = await this.runtime.fetch(
      `https://mp.sohu.com/mpbp/bp/user/resource/add?accountId=${this.accountInfo!.id}`,
      {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'X-Requested-With': 'XMLHttpRequest',
          'dv-id': this.deviceId,
          'sp-cm': this.spCm,
        },
        body: addResourceBody.toString(),
      }
    )

    if (!addResponse.ok) {
      const errText = await addResponse.text()
      throw new Error(`添加资源失败 HTTP ${addResponse.status}: ${errText}`)
    }

    const addResult = await addResponse.json() as {
      code?: number
      success?: boolean
      msg?: string
    }
    // logger.debug('[Step 2/3] Add resource response:', addResult)

    // 3. 获取缩略图 URL（图片已在客户端 3:2 剪裁，直接使用原图）
    // logger.debug('[Step 3/3] Getting thumbnail URL')

    const thumbnailBody = new URLSearchParams()
    thumbnailBody.set('url', originalUrl)
    thumbnailBody.set('accountId', this.accountInfo!.id)

    // logger.debug('[Step 3/3] Thumbnail request body:', thumbnailBody.toString())

    const thumbResponse = await this.runtime.fetch(
      `https://mp.sohu.com/commons/front/outerUpload/image/thumbnail/url?accountId=${this.accountInfo!.id}`,
      {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'X-Requested-With': 'XMLHttpRequest',
          'dv-id': this.deviceId,
          'sp-cm': this.spCm,
        },
        body: thumbnailBody.toString(),
      }
    )

    if (!thumbResponse.ok) {
      const errText = await thumbResponse.text()
      throw new Error(`缩略图生成失败 HTTP ${thumbResponse.status}: ${errText}`)
    }

    const thumbResult = await thumbResponse.json() as {
      url?: string
      msg?: string
    }
    // logger.debug('[Step 3/3] Thumbnail response:', thumbResult)

    if (!thumbResult.url) {
      throw new Error('封面缩略图生成失败:' + (thumbResult.msg || '未知错误'))
    }

    // logger.debug('Cover image upload complete, final coverUrl:', thumbResult.url)
    return thumbResult.url
  }
}
