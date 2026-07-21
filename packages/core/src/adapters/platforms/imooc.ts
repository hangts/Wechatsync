/**
 * 慕课网手记适配器
 * https://www.imooc.com
 */
import { CodeAdapter, ImageUploadResult } from '../code-adapter'
import type { Article, AuthResult, SyncResult, PlatformMeta } from '../../types'
import type { PublishOptions } from '../types'
import { createLogger } from '../../lib/logger'

const logger = createLogger('Imooc')
export class ImoocAdapter extends CodeAdapter {
  meta: PlatformMeta = {
    id: 'imooc',
    name: '慕课手记',
    icon: 'https://www.imooc.com/favicon.ico',
    homepage: 'https://www.imooc.com/article',
    capabilities: ['article', 'draft', 'image_upload'],
  }

  /** 预处理配置: 慕课网使用 Markdown 格式 */
  readonly preprocessConfig = {
    outputFormat: 'markdown' as const,
  }

  /** 慕课网 API 需要的 Header 规则 */
  private readonly HEADER_RULES = [
    {
      urlFilter: '*://www.imooc.com/article/*',
      headers: {
        Origin: 'https://www.imooc.com',
        Referer: 'https://www.imooc.com/',
      },
      resourceTypes: ['xmlhttprequest'],
    },
  ]

  /**
   * 检查登录状态
   */
  async checkAuth(): Promise<AuthResult> {
    return this.withHeaderRules(this.HEADER_RULES, async () => {
      const response = await this.runtime.fetch('https://www.imooc.com/u/card', {
        credentials: 'include',
      })
      let text = await response.text()

      // 解析 JSONP 响应
      text = text.replace('jsonpcallback(', '').replace('})', '}')
      const result = JSON.parse(text)

      if (result.result !== 0) {
        return { isAuthenticated: false, error: result.msg || '未登录' }
      }

      return {
        isAuthenticated: true,
        userId: result.data.uid,
        username: result.data.nickname,
        avatar: result.data.img,
      }
    }).catch((error) => ({ isAuthenticated: false, error: (error as Error).message }))
  }

  /**
   * 上传图片
   */
  async uploadImageByUrl(url: string): Promise<ImageUploadResult> {
    // 下载图片
    const imageResponse = await this.runtime.fetch(url)
    const blob = await imageResponse.blob()

    // 构建 FormData
    const formData = new FormData()
    const filename = `${Date.now()}.jpg`
    const file = new File([blob], filename, { type: blob.type || 'image/jpeg' })

    formData.append('photo', file, filename)
    formData.append('type', file.type)
    formData.append('id', 'WU_FILE_0')
    formData.append('name', filename)
    formData.append('lastModifiedDate', new Date().toString())
    formData.append('size', String(file.size))

    const response = await this.runtime.fetch(
      'https://www.imooc.com/article/ajaxuploadimg',
      {
        method: 'POST',
        credentials: 'include',
        body: formData,
      }
    )

    const res = await response.json()

    if (res.result !== 0) {
      throw new Error(res.msg || '图片上传失败')
    }

    // 处理协议相对 URL
    let imgUrl = res.data.imgpath
    if (imgUrl.startsWith('//')) {
      imgUrl = 'https:' + imgUrl
    }

    return { url: imgUrl }
  }

  /**
   * 发布文章
   */
  async publish(article: Article, options?: PublishOptions): Promise<SyncResult> {
    const now = Date.now()
    return this.withHeaderRules(this.HEADER_RULES, async () => {
      // 优先使用 markdown，处理图片
      let content = article.markdown || article.html || ''
      content = await this.processImages(content, (src) => this.uploadImageByUrl(src))

      const response = await this.runtime.fetch('https://www.imooc.com/article/savedraft', {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          editor: '0',
          draft_id: '0',
          title: article.title,
          content: content,
        }),
      })

      const res = await response.json()

      if (!res.data) {
        throw new Error('发布失败')
      }

      const postId = res.data
      const draftUrl = `https://www.imooc.com/article/draft/id/${postId}`

      // 正式发布（草稿模式跳过）
      // TODO: 发布API需要实际测试验证
      if (options?.draftOnly === false) {
        try {
          const publishResponse = await this.runtime.fetch('https://www.imooc.com/article/savepublish', {
            method: 'POST',
            credentials: 'include',
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: new URLSearchParams({
              editor: '0',
              draft_id: String(postId),
              title: article.title,
              content: content,
            }),
          })
          if (publishResponse.ok) {
            const articleUrl = `https://www.imooc.com/article/${postId}`
            logger.debug('Publish success:', articleUrl)
            return {
              platform: this.meta.id,
              success: true,
              postId: postId,
              postUrl: articleUrl,
              previewUrl: articleUrl,
              draftOnly: false,
              timestamp: now,
            }
          }
          // 发布失败，返回草稿
          const errText = await publishResponse.text()
          logger.warn('Publish failed, falling back to draft:', publishResponse.status, errText)
          return {
            platform: this.meta.id,
            success: true,
            postId: postId,
            postUrl: draftUrl,
            previewUrl: draftUrl,
            draftOnly: true,
            error: `发布失败: ${publishResponse.status} - ${errText}`,
            timestamp: now,
          }
        } catch (e) {
          // 发布异常，返回草稿 + 错误信息
          logger.warn('Publish error, falling back to draft:', e)
          return {
            platform: this.meta.id,
            success: true,
            postId: postId,
            postUrl: draftUrl,
            previewUrl: draftUrl,
            draftOnly: true,
            error: `发布失败: ${(e as Error).message}`,
            timestamp: now,
          }
        }
      }

      // 草稿模式
      return {
        platform: this.meta.id,
        success: true,
        postId: postId,
        postUrl: draftUrl,
        previewUrl: draftUrl,
        draftOnly: options?.draftOnly ?? true,
        timestamp: now,
      }
    }).catch((error) => ({
      platform: this.meta.id,
      success: false,
      error: (error as Error).message,
      timestamp: now,
    }))
  }
}
