import type { Announcement } from '@/types/announcements';

// Production URL is the default; development falls back to localhost
const API_URL = import.meta.env.MODE === 'development'
  ? (import.meta.env.VITE_API_URL || 'http://localhost:3001/api')
  : (import.meta.env.VITE_API_URL || 'https://api.wiredogvpn.com/api');

interface ApiError {
  message: string;
  status: number;
}

// Response from /api/auth/me
interface MeResponse {
  id: number;
  accountNumber: string;
  accountType: 'standard' | 'anonymous';
  displayName: string;
  isActive: boolean;
  planTier?: string;
  billingPeriod?: string;
  subscriptionExpiresAt?: string;
  subscriptionStartedAt?: string;
}

async function handleResponse<T>(response: Response): Promise<T> {
  // Sliding session renewal: the backend reissues a fresh token with a renewed expiry on
  // every authenticated request, so an actively-used app never hits its token's flat TTL.
  // Persist it whenever present, even on a non-2xx response, since the token itself was
  // still valid to make the renewal decision.
  const refreshedToken = response.headers.get('X-Refreshed-Token');
  if (refreshedToken && window.electronAPI?.auth?.setToken) {
    await window.electronAPI.auth.setToken(refreshedToken);
  }

  if (!response.ok) {
    let error: any;
    try {
      error = await response.json();
    } catch {
      error = { error: `HTTP ${response.status}: ${response.statusText || 'Request failed'}` };
    }
    throw { message: error.error || error.message || `HTTP ${response.status}`, status: response.status } as ApiError;
  }
  return response.json();
}

// Get auth token from Electron app or return null
async function getAuthToken(): Promise<string | null> {
  if (window.electronAPI?.auth?.getToken) {
    try {
      return await window.electronAPI.auth.getToken();
    } catch {
      return null;
    }
  }
  return null;
}

// Build headers with optional auth token
async function getHeaders(baseHeaders: Record<string, string> = {}): Promise<Record<string, string>> {
  const token = await getAuthToken();
  const headers = { ...baseHeaders };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  return headers;
}

export async function login(email: string, password: string): Promise<void> {
  const response = await fetch(`${API_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ identifier: email, password }),
  });
  const data = await handleResponse<{ token?: string }>(response);

  // Store token in Electron app if available
  if (data.token && window.electronAPI?.auth?.setToken) {
    await window.electronAPI.auth.setToken(data.token);
  }
}

export async function anonymousLogin(accountNumber: string): Promise<void> {
  // Strip spaces from account number
  const cleanNumber = accountNumber.replace(/\s/g, '');
  const response = await fetch(`${API_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ identifier: cleanNumber }),
  });
  const data = await handleResponse<{ token?: string }>(response);

  // Store token in Electron app if available
  if (data.token && window.electronAPI?.auth?.setToken) {
    await window.electronAPI.auth.setToken(data.token);
  }
}

export async function logout(): Promise<void> {
  const headers = await getHeaders();
  await fetch(`${API_URL}/auth/logout`, {
    method: 'POST',
    headers,
    credentials: 'include',
  });

  // Clear token from Electron app
  if (window.electronAPI?.auth?.clearToken) {
    await window.electronAPI.auth.clearToken();
  }
}

export async function registerStandard(email: string, password: string, referralCode?: string): Promise<void> {
  const body: Record<string, string> = { email, password, platform: 'Linux' };
  if (referralCode) body.referralCode = referralCode;
  const response = await fetch(`${API_URL}/auth/register/standard`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(body),
  });
  await handleResponse<unknown>(response);
}

export async function registerAnonymous(): Promise<string> {
  const response = await fetch(`${API_URL}/auth/register/anonymous`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ platform: 'Linux' }),
  });
  const data = await handleResponse<{ accountNumber: string }>(response);
  return data.accountNumber;
}

export async function getCurrentUser(): Promise<MeResponse | null> {
  try {
    const headers = await getHeaders();
    const response = await fetch(`${API_URL}/auth/me`, {
      method: 'GET',
      headers,
      credentials: 'include',
    });
    if (!response.ok) return null;
    return await handleResponse<MeResponse>(response);
  } catch {
    return null;
  }
}

// VPN Server response from backend
export interface ServerResponse {
  id: string;
  state: string;
  stateCode: string;
  city: string;
  latitude: number | null;
  longitude: number | null;
  isRecommended: boolean;
  latency: number;
  load: number;
  host: string;
}

export async function getServers(): Promise<ServerResponse[]> {
  const headers = await getHeaders();
  const response = await fetch(`${API_URL}/vpn/servers`, {
    method: 'GET',
    headers,
    credentials: 'include',
  });
  return handleResponse<ServerResponse[]>(response);
}

export interface ReportIssuePayload {
  email: string;
  username?: string;
  os: string;
  osVersion: string;
  vpnVersion: string;
  subject: string;
  message: string;
}

export async function reportIssue(payload: ReportIssuePayload): Promise<{ message: string; issueId: number }> {
  const response = await fetch(`${API_URL}/feedback/report-issue`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return handleResponse<{ message: string; issueId: number }>(response);
}

export async function getAnnouncements(): Promise<Announcement[]> {
  const response = await fetch(`${API_URL}/app/announcements`, {
    method: 'GET',
    headers: { 'Content-Type': 'application/json' },
  });
  return handleResponse<Announcement[]>(response);
}

export type { MeResponse, ApiError };
