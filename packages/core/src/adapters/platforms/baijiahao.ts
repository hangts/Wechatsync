/**
 * 百家号适配器
 */
import { CodeAdapter, type ImageUploadResult } from '../code-adapter'
import type { Article, AuthResult, SyncResult, PlatformMeta } from '../../types'
import type { PublishOptions } from '../types'
import { createLogger } from '../../lib/logger'

const logger = createLogger('Baijiahao')

interface BaijiahaoUserInfo {
  userid: string
  name: string
  avatar: string
}

export class BaijiahaoAdapter extends CodeAdapter {
  readonly meta: PlatformMeta = {
    id: 'baijiahao',
    name: '百家号',
    icon: 'https://www.baidu.com/favicon.ico',
    homepage: 'https://baijiahao.baidu.com/',
    capabilities: ['article', 'draft', 'image_upload'],
    needsReview: false,
  }

  /** 预处理配置: 百家号使用 HTML 格式 */
  readonly preprocessConfig = {
    outputFormat: 'html' as const,
  }

  private userInfo: BaijiahaoUserInfo | null = null
  private authToken: string = ''

  /** 百家号 API 需要的 Header 规则 */
  private readonly HEADER_RULES = [
    {
      urlFilter: '*://baijiahao.baidu.com/*',
      headers: {
        'Origin': 'https://baijiahao.baidu.com',
        'Referer': 'https://baijiahao.baidu.com/',
      },
      resourceTypes: ['xmlhttprequest'],
    },
  ]

  async checkAuth(): Promise<AuthResult> {
    try {
      const res = await this.get<{
        errno: number
        errmsg: string
        data?: { user: BaijiahaoUserInfo }
      }>(`https://baijiahao.baidu.com/builder/app/appinfo?_=${Date.now()}`)

      logger.debug('checkAuth response:', res)

      if (res.errmsg === 'success' && res.data?.user) {
        this.userInfo = res.data.user
        return {
          isAuthenticated: true,
          userId: res.data.user.userid,
          username: res.data.user.name,
          avatar: res.data.user.avatar,
        }
      }

      return { isAuthenticated: false }
    } catch (error) {
      logger.debug('checkAuth: not logged in -', error)
      return { isAuthenticated: false, error: (error as Error).message }
    }
  }

  private async fetchAuthToken(): Promise<string> {
    const response = await this.runtime.fetch('https://baijiahao.baidu.com/builder/rc/edit', {
      credentials: 'include',
    })
    const html = await response.text()

    const match = html.match(/window\.__BJH__INIT__AUTH__\s*=\s*['"]([^'"]+)['"]/)
    if (!match) {
      throw new Error('登录失效，请重新登录百家号')
    }

    const token = match[1]
    logger.debug('Auth token obtained')
    return token
  }

  async publish(article: Article, options?: PublishOptions): Promise<SyncResult> {
    return this.withHeaderRules(this.HEADER_RULES, async () => {
      logger.info('Starting publish...')

      if (!this.userInfo) {
        const auth = await this.checkAuth()
        if (!auth.isAuthenticated) {
          throw new Error('请先登录百家号')
        }
      }

      this.authToken = await this.fetchAuthToken()

      // Use pre-processed HTML content directly
      let content = article.html || ''

      // ====== 注释说明：正文图片处理暂不启用 ======
      // 当前仅支持封面图上传，正文中的图片处理（processImages）暂不启用。
      // 原因是百家号平台的图片以附件形式提供，不混排于正文中。
      // 保留代码但 return 跳过，后续如需启用直接取消注释即可。
      // TODO: 启用正文图片处理时取消注释
      // content = await this.processImages(content, (src) => this.uploadImageByUrl(src), {
      //   skipPatterns: ['baijiahao.baidu.com', 'bdstatic.com', 'bcebos.com'],
      //   onProgress: options?.onImageProgress,
      // })

      // ====== 新增：封面图处理 ======
      let uploadedCoverUrls: string[] = []
      if (article.coverImages && article.coverImages.length > 0) {
        const images = article.coverImages.slice(0, 3) // 最多 3 张
        for (let i = 0; i < images.length; i++) {
          try {
            const url = await this.uploadCoverImage(images[i])
            uploadedCoverUrls.push(url)
          } catch (e) {
            logger.error(`封面图 ${i + 1} 上传失败:`, e)
          }
        }
        // 仅支持 1 或 3 张封面图
        if (uploadedCoverUrls.length >= 3) {
          uploadedCoverUrls = uploadedCoverUrls.slice(0, 3)
        } else if (uploadedCoverUrls.length >= 1) {
          uploadedCoverUrls = uploadedCoverUrls.slice(0, 1)
        }
      }

      // 构造封面参数
      const hasCover = uploadedCoverUrls.length > 0
      const coverLayout = uploadedCoverUrls.length === 1 ? 'one' : 'three'
      const coverImagesParam = hasCover ? JSON.stringify(
        uploadedCoverUrls.map((url) => ({
          src: url,
          cropData: {},
          machine_chooseimg: 0,
          isLegal: 0,
          cover_source_tag: 'local',
        }))
      ) : ''
      const coverImagesMapParam = hasCover ? JSON.stringify(
        uploadedCoverUrls.map((url) => ({
          src: url,
          origin_src: url,
        }))
      ) : ''

      const saveBody = new URLSearchParams()
      saveBody.set('title', article.title)
      saveBody.set('content', content)
      saveBody.set('feed_cat', '1')
      saveBody.set('len', String(content.length))
      saveBody.set('activity_list', JSON.stringify([{ id: 408, is_checked: 0 }]))
      saveBody.set('source_reprinted_allow', '0')
      saveBody.set('original_status', '0')
      saveBody.set('original_handler_status', '1')
      saveBody.set('isBeautify', 'false')
      saveBody.set('subtitle', '')
      saveBody.set('bjhtopic_id', '')
      saveBody.set('bjhtopic_info', '')
      saveBody.set('type', 'news')
      if (hasCover) {
        saveBody.set('cover_layout', coverLayout)
        saveBody.set('cover_images', coverImagesParam)
        saveBody.set('_cover_images_map', coverImagesMapParam)
        saveBody.set('cover_image_source[wide_cover_image_source]', 'local')
        saveBody.set('source', 'upload')
        saveBody.set('cover_source', 'upload')
      }

      const response = await this.runtime.fetch(
        'https://baijiahao.baidu.com/pcui/article/save?callback=bjhdraft',
        {
          method: 'POST',
          credentials: 'include',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'token': this.authToken,
          },
          body: saveBody.toString(),
        }
      )

      const text = await response.text()
      const jsonStr = text.replace(/^bjhdraft\(/, '').replace(/\)$/, '')
      const res = JSON.parse(jsonStr) as {
        errno: number
        errmsg: string
        ret?: { article_id: string; nid: string; url: string }
      }

      logger.debug('Save response:', res)

      if (res.errno !== 0 || !res.ret?.article_id) {
        throw new Error(res.errmsg || '保存草稿失败')
      }

      const postId = res.ret.article_id
      const draftUrl = res.ret.url

      // 正式发布（草稿模式跳过）
      if (options?.draftOnly === false) {
        logger.debug('正在发布')
        
        try {
          const publishResponse = await this.runtime.fetch(
            'https://baijiahao.baidu.com/pcui/article/publish?type=news&callback=bjhpublish',
            {
              method: 'POST',
              credentials: 'include',
              headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'token': this.authToken,
              },
              body: new URLSearchParams({
                article_id: postId,
                type: 'news',
                title: article.title,
                content: content,
                len: String(content.length),
                feed_cat: '1',
                activity_list: JSON.stringify([{ id: 408, is_checked: 0 }]),
                source_reprinted_allow: '0',
                original_status: '0',
                original_handler_status: '1',
                isBeautify: 'false',
                subtitle: '',
                bjhtopic_id: '',
                bjhtopic_info: '',
                ...(hasCover ? {
                  cover_layout: coverLayout,
                  cover_images: coverImagesParam,
                  '_cover_images_map': coverImagesMapParam,
                  'cover_image_source[wide_cover_image_source]': 'local',
                  source: 'upload',
                  cover_source: 'upload',
                } : {}),
              }),
            }
          )

          const publishText = await publishResponse.text()
          logger.debug('Publish response:', {
            ok: publishResponse.ok,
            status: publishResponse.status,
            statusText: publishResponse.statusText,
            headers: Object.fromEntries(publishResponse.headers.entries()),
            body: publishText,
          })

          // 清洗 JSONP 包装 bjhpublish(...)
          const publishJsonStr = publishText.replace(/^bjhpublish\(/, '').replace(/\)$/, '')
          let publishErrno: number | null = null
          let publishErrmsg: string | null = null
          let publishRet: { article_id?: string; nid?: string; url?: string } | null = null
          try {
            const publishJson = JSON.parse(publishJsonStr) as {
              errno: number
              errmsg: string
              ret?: { article_id: string; nid: string; url: string }
            }
            publishErrno = publishJson.errno
            publishErrmsg = publishJson.errmsg
            publishRet = publishJson.ret ?? null
          } catch {
            // 非 JSON 响应，忽略
          }

          if (publishResponse.ok && publishErrno === 0) {
            const publishId = publishRet?.article_id || postId
            const articleUrl = `https://baijiahao.baidu.com/s?id=${publishId}`
            logger.debug('Publish success')
            return this.createResult(true, {
              postId: publishId,
              postUrl: articleUrl,
              previewUrl: articleUrl,   // 默认等于正式发布 URL（实际预览规则需调研）
              draftOnly: false,
            })
          }
          // 发布失败（HTTP 错误或业务错误），返回草稿
          const errorMsg = publishErrmsg || `HTTP ${publishResponse.status}`
          logger.warn('Publish failed, falling back to draft:', errorMsg)
          return this.createResult(true, {
            postId: postId,
            postUrl: draftUrl,
            previewUrl: draftUrl,       // 草稿场景预览 URL = 草稿 URL
            draftOnly: true,
            error: `发布失败: ${errorMsg}`,
          })
        } catch (e) {
          // 发布异常，返回草稿 + 错误信息
          logger.warn('Publish error, falling back to draft:', e)
          return this.createResult(true, {
            postId: postId,
            postUrl: draftUrl,
            previewUrl: draftUrl,       // 草稿场景预览 URL = 草稿 URL
            draftOnly: true,
            error: `发布失败: ${(e as Error).message}`,
          })
        }
      }

      // 草稿模式
      return this.createResult(true, {
        postId: postId,
        postUrl: draftUrl,
        previewUrl: draftUrl,   // 草稿场景预览 URL = 草稿 URL
        draftOnly: options?.draftOnly ?? true,
      })
    }).catch((error) => this.createResult(false, {
      error: (error as Error).message,
    }))
  }

  protected async uploadImageByUrl(src: string): Promise<ImageUploadResult> {
    const imageResponse = await fetch(src)
    if (!imageResponse.ok) {
      throw new Error('图片下载失败: ' + src)
    }
    const imageBlob = await imageResponse.blob()

    const formData = new FormData()
    formData.append('media', imageBlob, 'image.jpg')
    formData.append('type', 'image')
    formData.append('app_id', '1589639493090963')
    formData.append('is_waterlog', '1')
    formData.append('save_material', '1')
    formData.append('no_compress', '0')
    formData.append('is_events', '')
    formData.append('article_type', 'news')

    const uploadUrl = 'https://baijiahao.baidu.com/pcui/picture/uploadproxy'
    const uploadResponse = await this.runtime.fetch(uploadUrl, {
      method: 'POST',
      credentials: 'include',
      body: formData,
    })

    const res = await uploadResponse.json() as {
      errno: number
      errmsg: string
      ret?: { https_url: string }
    }

    logger.debug('Image upload response:', res)

    if (res.errmsg !== 'success' || !res.ret?.https_url) {
      throw new Error(res.errmsg || '图片上传失败')
    }

    return {
      url: res.ret.https_url,
    }
  }

  /**
   * 上传封面图到百家号图床。
   * 使用真实 API（基于抓包日志）：
   * - POST /pcui/picture/processproxy
   * - Content-Type: application/x-www-form-urlencoded
   * - Body: action[0]=save&base64=<comma+base64_body>
   * - Header: token (JWT)
   */
  protected async uploadCoverImage(dataUri: string): Promise<string> {
    // 1. 提取纯 base64（去除 data:image/png;base64, 前缀）
    const base64Body = dataUri.replace(/^data:image\/\w+;base64,/, '')

    // 2. 构造请求体（注意：base64 前需要逗号）
    const body = new URLSearchParams({
      'action[0]': 'save',
      base64: ',' + base64Body,  // ← 关键：逗号前缀
    })

    // 3. 上传
    const uploadUrl = 'https://baijiahao.baidu.com/pcui/picture/processproxy'
    const response = await this.runtime.fetch(uploadUrl, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'token': this.authToken,
        'Referer': 'https://baijiahao.baidu.com/builder/rc/edit?type=news&is_from_cms=1',
      },
      body: body.toString(),
    })

    const res = await response.json() as {
      errno: number
      errmsg: string
      ret?: { url: string; original_url: string }
    }

    if (res.errno !== 0 || !res.ret?.url) {
      throw new Error(res.errmsg || '封面上传失败')
    }

    return res.ret.url  // picproxy URL
  }
}
