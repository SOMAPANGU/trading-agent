import { LIVE_ENABLE_PHRASE } from "./constants.js";

/**
 * Live trading stays off in this build.
 * `--live` refuses the run. Arming every switch still does not send an order,
 * because no live broker is linked.
 */
export function assessLiveRequest({ cliLive = false, envValue = "", fileValue = "" } = {}) {
  const envOn = envValue === LIVE_ENABLE_PHRASE;
  const fileOn = fileValue === LIVE_ENABLE_PHRASE;
  const fullyArmed = Boolean(cliLive) && envOn && fileOn;
  return {
    fullyArmed,
    blocked: Boolean(cliLive) || fullyArmed,
    sendLiveOrder: false,
  };
}
