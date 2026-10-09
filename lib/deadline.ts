import { getDeadline } from "@vercel/functions";
import { config } from "./config";

/**
 * When the request being handled will be terminated, as a timestamp, or undefined on a host with
 * no such limit. Vercel reports its own deadline; REQUEST_TIME_LIMIT_S sets one anywhere else.
 */
export function requestDeadline(startedAt = Date.now()): number | undefined {
  const platform = getDeadline()?.getTime();
  if (platform) return platform;
  const limit = config().REQUEST_TIME_LIMIT_S;
  return limit ? startedAt + limit * 1000 : undefined;
}
