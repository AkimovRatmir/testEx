/**
 * AHU emulator: runs the ahuModel simulation and streams it to ThingsBoard over MQTT.
 *
 * Telemetry goes to v1/devices/me/telemetry; server-side RPC commands
 * (setRun, setSetpoint, resetAlarm, replaceFilter, injectFault, ...) arrive on
 * v1/devices/me/rpc/request/+ and are answered on v1/devices/me/rpc/response/<id>.
 */
import mqtt from "mqtt";
import { AHU, DP_WARNING, NOMINAL_AIRFLOW, defaultConfig, type Config } from "./ahuModel.ts";

const SIM_STEP = 0.5; // s

const log = (level: string, message: string) => console.log(`${new Date().toISOString()} ${level} ${message}`);

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${name} must be a number, got "${raw}"`);
  return value;
}

function loadConfig(): Config {
  const d = defaultConfig;
  return {
    ...d,
    dayPeriod: envNumber("DAY_PERIOD_MIN", d.dayPeriod / 60) * 60,
    filterLife: envNumber("FILTER_LIFE_MIN", d.filterLife / 60) * 60,
    filterInitialLoad: envNumber("FILTER_INITIAL_LOAD", d.filterInitialLoad),
    filterServiceDelay: envNumber("FILTER_SERVICE_DELAY_S", d.filterServiceDelay),
    outdoorMean: envNumber("OUTDOOR_MEAN", d.outdoorMean),
    outdoorAmplitude: envNumber("OUTDOOR_AMPLITUDE", d.outdoorAmplitude),
    setpoint: envNumber("SETPOINT", d.setpoint),
    nightSetback: envNumber("NIGHT_SETBACK", d.nightSetback),
    faultRatePerHour: envNumber("FAULT_RATE_PER_HOUR", d.faultRatePerHour),
    alarmAutoReset: envNumber("ALARM_AUTO_RESET_S", d.alarmAutoReset),
  };
}

function parseParams(params: unknown): unknown {
  if (typeof params !== "string") return params;
  try {
    return JSON.parse(params);
  } catch {
    return params;
  }
}

function main(): void {
  const token = process.env.TB_TOKEN;
  if (!token) {
    console.error("TB_TOKEN is not set: put the device access token into the environment");
    process.exit(1);
  }
  const host = process.env.TB_HOST ?? "localhost";
  const port = envNumber("TB_PORT", 1883);
  const interval = envNumber("PUBLISH_INTERVAL", 2);

  const ahu = new AHU(loadConfig());

  const client = mqtt.connect({ host, port, username: token, keepalive: 30, reconnectPeriod: 2000 });

  client.on("connect", () => {
    log("INFO", `connected to ${host}:${port}`);
    client.subscribe("v1/devices/me/rpc/request/+", { qos: 1 });
    client.publish(
      "v1/devices/me/attributes",
      JSON.stringify({ model: "AHU emulator", firmware: "1.0.0", nominalAirflow: NOMINAL_AIRFLOW, filterDpWarning: DP_WARNING }),
      { qos: 1 },
    );
  });
  client.on("close", () => log("WARN", "disconnected, reconnecting"));
  client.on("error", (err) => log("ERROR", `MQTT error: ${err.message} (check TB_TOKEN)`));

  client.on("message", (topic, payload) => {
    const requestId = topic.split("/").pop();
    let result: unknown;
    try {
      const request = JSON.parse(payload.toString()) as { method?: string; params?: unknown };
      result = ahu.handleRpc(String(request.method), parseParams(request.params));
    } catch (err) {
      // A bad command must not kill the emulator.
      result = { error: err instanceof Error ? err.message : String(err) };
    }
    log("INFO", `RPC ${payload.toString()} -> ${JSON.stringify(result)}`);
    client.publish(`v1/devices/me/rpc/response/${requestId}`, JSON.stringify(result), { qos: 1 });
  });

  // Fixed-step simulation; telemetry is sampled every PUBLISH_INTERVAL seconds.
  let nextPublish = Date.now();
  const timer = setInterval(() => {
    ahu.step(SIM_STEP);
    if (Date.now() < nextPublish) return;
    nextPublish += interval * 1000;
    if (client.connected) {
      client.publish("v1/devices/me/telemetry", JSON.stringify({ ts: Date.now(), values: ahu.telemetry() }), { qos: 1 });
    }
  }, SIM_STEP * 1000);

  const shutdown = () => {
    clearInterval(timer);
    client.end(false, () => process.exit(0));
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main();
