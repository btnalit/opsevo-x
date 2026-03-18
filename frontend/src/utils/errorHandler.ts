/**
 * 错误处理工具函数
 * 提供统一的错误处理模式，确保类型安全
 */

import { ElMessage } from 'element-plus'

/**
 * 从未知错误中提取错误消息
 * @param error 未知类型的错误
 * @param defaultMessage 默认错误消息
 * @returns 错误消息字符串
 */
export function getErrorMessage(error: unknown, defaultMessage = '操作失败'): string {
  if (error instanceof Error) {
    return error.message
  }
  if (typeof error === 'string') {
    return error
  }
  if (error && typeof error === 'object' && 'message' in error) {
    return String((error as { message: unknown }).message)
  }
  return defaultMessage
}

/**
 * 判断是否为用户取消操作
 * @param error 未知类型的错误
 * @returns 是否为用户取消
 */
export function isUserCancelled(error: unknown): boolean {
  return error === 'cancel' || 
         (error instanceof Error && error.message === 'cancel')
}

/**
 * 统一的错误处理函数
 * @param error 未知类型的错误
 * @param defaultMessage 默认错误消息
 * @param showMessage 是否显示错误消息
 * @returns 错误消息字符串
 */
export function handleError(
  error: unknown, 
  defaultMessage = '操作失败',
  showMessage = true
): string {
  // 用户取消操作不显示错误
  if (isUserCancelled(error)) {
    return ''
  }
  
  const message = getErrorMessage(error, defaultMessage)
  
  if (showMessage) {
    ElMessage.error(message)
  }
  
  return message
}
