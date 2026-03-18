/**
 * Auth API - 认证相关 API 调用
 * Requirements: 7.1, 7.2, 7.7
 */

import api from './index'

export interface LoginRequest {
  username: string
  password: string
}

export interface RegisterRequest {
  username: string
  email: string
  password: string
  invitationCode: string
}

export interface AuthUser {
  id: string
  username: string
  email: string
  tenantId: string
}

export interface AuthResponse {
  success: boolean
  data?: {
    token: string
    refreshToken: string
    user: AuthUser
  }
  error?: string
}

export interface RefreshResponse {
  success: boolean
  data?: {
    token: string
    refreshToken: string
  }
  error?: string
}

export const authApi = {
  /**
   * 用户登录
   */
  login: (data: LoginRequest) =>
    api.post<AuthResponse>('/auth/login', data),

  /**
   * 用户注册
   */
  register: (data: RegisterRequest) =>
    api.post<AuthResponse>('/auth/register', data),

  /**
   * 刷新令牌
   */
  refresh: (refreshToken: string) =>
    api.post<RefreshResponse>('/auth/refresh', { refreshToken }),
}
