import { exec as execCallback } from 'child_process';
import { promisify } from 'util';
import { ProviderConfig, HealthCheckConfig } from '../config/EnvConfig.js';
import { detectPublicIpViaStun } from './StunClient.js';

const exec = promisify(execCallback);

export interface RegistrationResult {
  success: boolean;
  message: string;
  hostIp?: string;
  targetPort?: number;
  domain?: string;
  error?: string;
}

export interface Route {
  ip: string;
  port: number;
  priority: number;
  healthCheck?: HealthCheckConfig;
}

export interface RouteRegistrationResult {
  success: boolean;
  message: string;
  routes?: Route[];
  domain?: string;
  error?: string;
}

/**
 * Detects the public IP address using STUN protocol (primary)
 * Falls back to HTTP services if STUN fails
 */
export async function detectPublicIp(): Promise<string> {
  // Try STUN first (faster and more reliable)
  try {
    return await detectPublicIpViaStun();
  } catch (stunError) {
    console.log('STUN detection failed, falling back to HTTP services...');
  }

  // Fallback to HTTP services
  const httpServices = [
    'https://api.ipify.org',
    'https://ifconfig.me/ip',
    'https://icanhazip.com',
  ];

  for (const service of httpServices) {
    try {
      const { stdout } = await exec(`curl -s --max-time 10 ${service}`);
      const ip = stdout.trim();
      if (isValidIp(ip)) {
        console.log(`Detected public IP: ${ip} (via HTTP ${service})`);
        return ip;
      }
    } catch {
      // Try next service
    }
  }

  throw new Error('Failed to detect public IP from all STUN and HTTP services');
}

/**
 * Validates an IPv4 or IPv6 address
 */
function isValidIp(ip: string): boolean {
  // IPv4 regex
  const ipv4Regex = /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;

  // Simple IPv6 check (contains colons and valid hex chars)
  const ipv6Regex = /^[0-9a-fA-F:]+$/;

  return ipv4Regex.test(ip) || (ip.includes(':') && ipv6Regex.test(ip));
}

/**
 * Registers the IP and target port with mesh-router-backend
 * POST /router/api/ip/:userid/:sig { hostIp: string, targetPort: number }
 * @deprecated Use registerRoutes instead for v2 API
 */
export async function registerIp(
  provider: ProviderConfig,
  publicIp: string,
  targetPort: number = 443
): Promise<RegistrationResult> {
  const { backendUrl, userId, signature } = provider;
  const url = `${backendUrl}/router/api/ip/${encodeURIComponent(userId)}/${encodeURIComponent(signature)}`;

  try {
    const jsonData = JSON.stringify({ hostIp: publicIp, targetPort }).replace(/"/g, '\\"');
    const curlCommand = `curl -s -X POST -H "Content-Type: application/json" -d "${jsonData}" "${url}"`;

    const { stdout } = await exec(curlCommand);
    const response = JSON.parse(stdout);

    if (response.error) {
      return {
        success: false,
        message: 'Registration failed',
        error: response.error,
      };
    }

    return {
      success: true,
      message: response.message || 'IP registered successfully',
      hostIp: response.hostIp,
      targetPort: response.targetPort,
      domain: response.domain,
    };
  } catch (error) {
    return {
      success: false,
      message: 'Registration request failed',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Registers routes with mesh-router-backend (v2 API)
 * POST /router/api/routes/:userid/:sig { routes: Route[] }
 *
 * This replaces the old registerIp function and supports:
 * - Multiple routes with priority
 * - Optional health check configuration
 * - TTL-based expiry (routes must be refreshed every 5 minutes)
 */
export async function registerRoutes(
  provider: ProviderConfig,
  routes: Route[]
): Promise<RouteRegistrationResult> {
  const { backendUrl, userId, signature } = provider;
  const url = `${backendUrl}/router/api/routes/${encodeURIComponent(userId)}/${encodeURIComponent(signature)}`;

  try {
    const jsonData = JSON.stringify({ routes }).replace(/"/g, '\\"');
    const curlCommand = `curl -s -X POST -H "Content-Type: application/json" -d "${jsonData}" "${url}"`;

    const { stdout } = await exec(curlCommand);
    const response = JSON.parse(stdout);

    if (response.error) {
      return {
        success: false,
        message: 'Route registration failed',
        error: response.error,
      };
    }

    return {
      success: true,
      message: response.message || 'Routes registered successfully',
      routes: response.routes,
      domain: response.domain,
    };
  } catch (error) {
    return {
      success: false,
      message: 'Route registration request failed',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Build a route object from configuration
 */
export function buildRoute(
  ip: string,
  port: number,
  priority: number,
  healthCheck?: HealthCheckConfig
): Route {
  const route: Route = { ip, port, priority };
  if (healthCheck) {
    route.healthCheck = healthCheck;
  }
  return route;
}

/**
 * Checks if the backend is reachable
 */
export async function checkBackendHealth(backendUrl: string): Promise<boolean> {
  try {
    const { stdout } = await exec(`curl -s --max-time 10 "${backendUrl}/router/api/available/healthcheck"`);
    // Any valid JSON response means backend is up
    JSON.parse(stdout);
    return true;
  } catch {
    return false;
  }
}

export interface HeartbeatResult {
  success: boolean;
  message: string;
  lastSeenOnline?: string;
  error?: string;
}

/**
 * Sends a heartbeat to mesh-router-backend
 * POST /router/api/heartbeat/:userid/:sig
 */
export async function sendHeartbeat(
  provider: ProviderConfig
): Promise<HeartbeatResult> {
  const { backendUrl, userId, signature } = provider;
  const url = `${backendUrl}/router/api/heartbeat/${encodeURIComponent(userId)}/${encodeURIComponent(signature)}`;

  try {
    const curlCommand = `curl -s -X POST "${url}"`;
    const { stdout } = await exec(curlCommand);
    const response = JSON.parse(stdout);

    if (response.error) {
      return {
        success: false,
        message: 'Heartbeat failed',
        error: response.error,
      };
    }

    return {
      success: true,
      message: response.message || 'Heartbeat sent',
      lastSeenOnline: response.lastSeenOnline,
    };
  } catch (error) {
    return {
      success: false,
      message: 'Heartbeat request failed',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
