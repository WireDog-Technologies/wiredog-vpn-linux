import type { Announcement } from '@/types/announcements';

// Production URL is the default; development falls back to localhost
const API_URL = import.meta.env.MODE === 'development'
  ? (import.meta.env.VITE_API_URL || 'http://localhost:3001/api')
  : (import.meta.env.VITE_API_URL || 'https://api.wiredogvpn.com/api');

interface ApiError {
  message: string;
  status: number;
  // Machine-readable reason the backend tags on the few errors the app branches on
  // (e.g. 'two_factor_challenge_expired'). Absent on plain errors.
  code?: string;
}

export type OrganizationAccessValue = 'active' | 'inactive' | 'revoked';

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
  // Business / organization state. Optional so an older backend that omits them still maps.
  totpEnabled?: boolean;
  twoFactorRequiredByOrg?: boolean;
  mustChangePassword?: boolean;
  subscriptionManagedByOrganization?: boolean;
  organizationName?: string | null;
  organizationRole?: string | null;
  organizationAccess?: string | null;
}

// Unknown values decode as 'active' so a future backend state never locks someone out.
export function parseOrganizationAccess(raw: string | null | undefined): OrganizationAccessValue | undefined {
  if (!raw) return undefined;
  return raw === 'inactive' || raw === 'revoked' ? raw : 'active';
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
    throw {
      message: error.error || error.message || `HTTP ${response.status}`,
      status: response.status,
      code: typeof error.code === 'string' ? error.code : undefined,
    } as ApiError;
  }
  return response.json();
}

// Where "Manage Account" and the org-required 2FA setup send the user. Falls back to the website's
// dashboard when no explicit account URL is configured.
const DASHBOARD_URL: string = import.meta.env.VITE_ACCOUNT_URL
  || `${import.meta.env.VITE_FRONTEND_URL || 'https://wiredogvpn.com'}/dashboard`;

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

/**
 * What a password/account-number login produced: a session, or a pending 2FA challenge the
 * caller must redeem with verifyTwoFactor.
 */
export type LoginOutcome =
  | { status: 'signedIn' }
  | { status: 'twoFactorRequired'; challengeToken: string };

interface LoginResponseBody {
  token?: string;
  requiresTwoFactor?: boolean;
  challengeToken?: string;
}

// Stores the token from a successful sign-in, or reports the 2FA challenge. /auth/login answers
// with a token, or, for an account with 2FA on, a challenge and no token.
async function finishLogin(data: LoginResponseBody): Promise<LoginOutcome> {
  if (data.requiresTwoFactor && data.challengeToken) {
    return { status: 'twoFactorRequired', challengeToken: data.challengeToken };
  }
  if (data.token && window.electronAPI?.auth?.setToken) {
    await window.electronAPI.auth.setToken(data.token);
  }
  return { status: 'signedIn' };
}

export async function login(email: string, password: string): Promise<LoginOutcome> {
  const response = await fetch(`${API_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ identifier: email, password }),
  });
  return finishLogin(await handleResponse<LoginResponseBody>(response));
}

export async function anonymousLogin(accountNumber: string): Promise<LoginOutcome> {
  // Strip spaces from account number
  const cleanNumber = accountNumber.replace(/\s/g, '');
  const response = await fetch(`${API_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ identifier: cleanNumber }),
  });
  return finishLogin(await handleResponse<LoginResponseBody>(response));
}

/**
 * Second step of a login whose first step returned 'twoFactorRequired'. `code` is a 6-digit
 * authenticator code or a recovery code. The challenge token is single-use on success but
 * survives a wrong code, so the caller can let the user retry.
 */
export async function verifyTwoFactor(challengeToken: string, code: string): Promise<void> {
  const response = await fetch(`${API_URL}/auth/2fa/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ challengeToken, code }),
  });
  await finishLogin(await handleResponse<LoginResponseBody>(response));
}

/**
 * Whether `email`'s domain has verified SSO. Public lookup, same one the website's login uses.
 * A failed lookup counts as "no SSO" so a network blip never blocks a password login.
 */
export async function ssoAvailable(email: string): Promise<boolean> {
  const trimmed = email.trim();
  if (!trimmed.includes('@')) return false;
  try {
    const response = await fetch(`${API_URL}/auth/login/lookup?identifier=${encodeURIComponent(trimmed)}`, {
      method: 'GET',
      credentials: 'include',
    });
    const data = await handleResponse<{ sso: boolean }>(response);
    return data.sso === true;
  } catch {
    return false;
  }
}

/** Redeems the one-time code from the wiredog://sso callback, proving possession of the PKCE verifier. */
export async function exchangeSsoCode(code: string, codeVerifier: string): Promise<void> {
  const response = await fetch(`${API_URL}/auth/sso/exchange`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ code, codeVerifier }),
  });
  await finishLogin(await handleResponse<LoginResponseBody>(response));
}

/** Replaces a temporary (admin-provisioned) password. The backend clears mustChangePassword. */
export async function changePassword(currentPassword: string, newPassword: string): Promise<void> {
  const headers = await getHeaders({ 'Content-Type': 'application/json' });
  const response = await fetch(`${API_URL}/auth/password`, {
    method: 'PATCH',
    headers,
    credentials: 'include',
    body: JSON.stringify({ currentPassword, newPassword }),
  });
  await handleResponse<unknown>(response);
}

// MARK: Password reset

export async function forgotPassword(email: string): Promise<void> {
  const response = await fetch(`${API_URL}/auth/forgot-password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  await handleResponse<unknown>(response);
}

/** Returns true when the account has 2FA on, so the reset must also carry a current 2FA code. */
export async function verifyResetCode(email: string, code: string): Promise<boolean> {
  const response = await fetch(`${API_URL}/auth/verify-reset-code`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, code }),
  });
  const data = await handleResponse<{ twoFactorRequired?: boolean }>(response);
  return data.twoFactorRequired ?? false;
}

export async function resetPassword(email: string, code: string, newPassword: string, twoFactorCode?: string): Promise<void> {
  const body: Record<string, string> = { email, code, newPassword };
  if (twoFactorCode) body.twoFactorCode = twoFactorCode;
  const response = await fetch(`${API_URL}/auth/reset-password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  await handleResponse<unknown>(response);
}

// MARK: Dashboard handoff

/**
 * Builds a URL that opens the website already signed in: mints a one-time handoff code and puts
 * it in the URL fragment (never sent to a server in a request line or logged by one). Falls back
 * to the plain URL, which asks the user to sign in, if the code can't be issued.
 */
export async function dashboardHandoffUrl(): Promise<string> {
  const destination = DASHBOARD_URL;
  try {
    const headers = await getHeaders();
    const response = await fetch(`${API_URL}/auth/handoff-token`, {
      method: 'POST',
      headers,
      credentials: 'include',
    });
    const data = await handleResponse<{ token: string }>(response);
    const url = new URL(destination);
    url.hash = `handoff=${data.token}`;
    return url.toString();
  } catch {
    return destination;
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

/**
 * Like getCurrentUser, but a failure is thrown instead of flattened to null, so callers can tell
 * "the backend rejected this token" (status 401) from "couldn't reach it right now" and keep the
 * session through the latter.
 */
export async function fetchCurrentUser(): Promise<MeResponse> {
  const headers = await getHeaders();
  const response = await fetch(`${API_URL}/auth/me`, {
    method: 'GET',
    headers,
    credentials: 'include',
  });
  return handleResponse<MeResponse>(response);
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
  // Set only on an organization member's "gateway" entry: their own named Dedicated IP on this
  // node. `id` is still the node's real server id; gatewayId is passed back when connecting.
  gatewayId?: number | null;
  gatewayName?: string | null;
}

export async function getServers(): Promise<ServerResponse[]> {
  const headers = await getHeaders();
  // gateways=1 opts in to organization "gateway" entries (named Dedicated IPs). Without it the
  // backend keeps returning the plain list.
  const response = await fetch(`${API_URL}/vpn/servers?gateways=1`, {
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

/**
 * Notices staff sent to this account only (GET /auth/messages). Authenticated, unlike the public
 * announcements. Shaped like an announcement; ids start with "m" so they can never collide with an
 * announcement id in the local read-state set.
 */
export async function getAccountMessages(): Promise<Announcement[]> {
  const headers = await getHeaders({ 'Content-Type': 'application/json' });
  const response = await fetch(`${API_URL}/auth/messages`, {
    method: 'GET',
    headers,
    credentials: 'include',
  });
  return handleResponse<Announcement[]>(response);
}

export async function getAnnouncements(): Promise<Announcement[]> {
  const response = await fetch(`${API_URL}/app/announcements`, {
    method: 'GET',
    headers: { 'Content-Type': 'application/json' },
  });
  return handleResponse<Announcement[]>(response);
}

export type { MeResponse, ApiError };
