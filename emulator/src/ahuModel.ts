/**
 * Physical model of an air handling unit (приточно-вытяжная установка).
 *
 * The model runs in real time: call step(dt) with dt in seconds. Fast processes
 * (damper stroke, fan ramps, coil and sensor lags, PI control) use realistic time
 * constants. Slow processes (the day/night weather cycle and filter loading) are
 * compressed through Config so they are visible within a short demo.
 */

export type State = "STOPPED" | "STARTING" | "RUNNING" | "STOPPING" | "ALARM";
type Fan = "supply" | "exhaust" | null;

export const SUPPLY_FAN_FAILURE = "Supply fan failure";
export const EXHAUST_FAN_FAILURE = "Exhaust fan failure";
export const FROST_PROTECTION = "Frost protection";

export const NOMINAL_AIRFLOW = 4000; // m3/h
const DUCT_PRESSURE = 350; // Pa, network pressure at nominal airflow, filter excluded
const SUPPLY_RPM_NOMINAL = 1750; // rpm for nominal airflow with a clean filter
const SUPPLY_RPM_MAX = 2200;
const EXHAUST_RPM_NOMINAL = 1600;
const FAN_RAMP_UP = 60; // rpm/s, soft start
const FAN_RAMP_DOWN = 120; // rpm/s, coast down
const FAILED_FAN_RAMP_DOWN = 400;
const DAMPER_TRAVEL = 30; // s, full stroke
const VALVE_RATE = 2; // %/s
const HEATER_MAX_DT = 40; // K air temperature rise at 100 % valve and nominal airflow
const COOLER_MAX_DT = 12; // K
const CHILLED_WATER_LIMIT = 9; // °C, the cooler cannot bring air below this
const COIL_TAU = 30; // s
const SENSOR_TAU = 8; // s
const FAN_HEAT = 0.6; // K, motor heat picked up by the air
const PLANT_ROOM_TEMP = 16; // °C, where duct air drifts while the unit stands still
const DP_CLEAN = 70; // Pa, clean filter at nominal airflow
export const DP_WARNING = 250; // Pa, filter clogged
const KP = 4; // %/K
const TI = 60; // s
const FROST_LIMIT = 6; // °C
const FROST_DELAY = 30; // s
const START_HOUR = 8; // simulated clock at startup

export interface Config {
  dayPeriod: number; // s, length of a simulated day
  filterLife: number; // s, clean -> clogged at nominal airflow
  filterInitialLoad: number; // 0..1, fraction of filter life already used at startup
  filterServiceDelay: number; // s, clogged -> replaced by "maintenance"
  outdoorMean: number; // °C
  outdoorAmplitude: number; // K, day/night swing
  setpoint: number; // °C, supply air
  nightSetback: number; // K, setpoint reduction 22:00-07:00
  faultRatePerHour: number; // random fan failures while running
  alarmAutoReset: number; // s, 0 = manual reset only
  startDelay: number; // s before the first start
}

export const defaultConfig: Config = {
  dayPeriod: 3600,
  filterLife: 2700,
  filterInitialLoad: 0.5,
  filterServiceDelay: 300,
  outdoorMean: 2,
  outdoorAmplitude: 5,
  setpoint: 20,
  nightSetback: 3,
  faultRatePerHour: 0.5,
  alarmAutoReset: 120,
  startDelay: 5,
};

export interface Telemetry {
  outdoorTemp: number;
  supplyTemp: number;
  setpoint: number;
  outdoorHumidity: number;
  supplyHumidity: number;
  supplyFanRpm: number;
  exhaustFanRpm: number;
  airflow: number;
  filterDp: number;
  damperPos: number;
  heatValve: number;
  coolValve: number;
  state: State;
  running: boolean;
  alarm: boolean;
  alarmText: string;
  filterClogged: boolean;
  simTime: string;
}

/** Seedable PRNG (mulberry32) with a Gaussian helper, so test runs are reproducible. */
export class Rng {
  private s: number;

  constructor(seed = Date.now()) {
    this.s = seed >>> 0;
  }

  random(): number {
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  gauss(mean = 0, sigma = 1): number {
    const u = 1 - this.random();
    const v = this.random();
    return mean + sigma * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  uniform(low: number, high: number): number {
    return low + (high - low) * this.random();
  }
}

const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));
const approach = (value: number, target: number, maxStep: number) =>
  value + clamp(target - value, -maxStep, maxStep);
const round = (value: number, digits = 0) => Number(value.toFixed(digits));
const saturationPressure = (temp: number) => 6.112 * Math.exp((17.62 * temp) / (243.12 + temp));
const relativeHumidity = (temp: number, dewPoint: number) =>
  clamp((100 * saturationPressure(Math.min(dewPoint, temp))) / saturationPressure(temp), 0, 100);

export class AHU {
  t = 0;
  state: State = "STOPPED";
  runCmd = true;
  baseSetpoint: number;
  alarmText = "";
  private alarmSince = 0;
  private failedFan: Fan = null;
  private frostTimer = 0;

  private outdoorDev = 0;
  private dewDev = 0;
  outdoorTemp: number;
  private outdoorDew: number;
  supplyTemp: number;

  private integral = 0;
  heatValve = 0;
  coolValve = 0;
  private heatCoil = 0;
  private coolCoil = 0;
  private cooling = 0;
  damper = 0;
  supplyRpm = 0;
  exhaustRpm = 0;
  private flowFrac = 0;
  filterDp = 0;
  filterClogged = false;
  private cloggedSince = 0;
  private filterR: number;
  readonly cfg: Config;
  private readonly rng: Rng;

  constructor(cfg: Config = defaultConfig, rng: Rng = new Rng()) {
    this.cfg = cfg;
    this.rng = rng;
    this.baseSetpoint = cfg.setpoint;
    this.outdoorTemp = cfg.outdoorMean;
    this.outdoorDew = cfg.outdoorMean - 3;
    this.weather(0);
    this.supplyTemp = this.outdoorTemp + 0.5 * (PLANT_ROOM_TEMP - this.outdoorTemp);
    this.filterR = Math.exp(this.filterK * cfg.filterLife * cfg.filterInitialLoad);
  }

  // --- derived values -----------------------------------------------------

  private get filterK(): number {
    return Math.log(DP_WARNING / DP_CLEAN) / this.cfg.filterLife;
  }

  get simHour(): number {
    return (START_HOUR + (this.t / this.cfg.dayPeriod) * 24) % 24;
  }

  get isNight(): boolean {
    return this.simHour < 7 || this.simHour >= 22;
  }

  get setpoint(): number {
    return this.baseSetpoint - (this.isNight ? this.cfg.nightSetback : 0);
  }

  /** Constant airflow control: the fan speeds up as the filter adds resistance. */
  private get rpmRequired(): number {
    return SUPPLY_RPM_NOMINAL * Math.sqrt((DUCT_PRESSURE + DP_CLEAN * this.filterR) / (DUCT_PRESSURE + DP_CLEAN));
  }

  // --- commands -----------------------------------------------------------

  trip(text: string, fan: Fan = null): void {
    if (this.state !== "ALARM") {
      this.state = "ALARM";
      this.alarmText = text;
      this.alarmSince = this.t;
      this.failedFan = fan;
    }
  }

  resetAlarm(): void {
    if (this.state === "ALARM") {
      this.state = "STOPPED";
      this.alarmText = "";
      this.failedFan = null;
      this.frostTimer = 0;
    }
  }

  replaceFilter(): void {
    this.filterR = 1 + this.rng.uniform(0, 0.08);
    this.filterClogged = false;
  }

  handleRpc(method: string, params: unknown): unknown {
    switch (method) {
      case "getRun":
        return this.runCmd;
      case "setRun":
        this.runCmd = Boolean(params);
        return this.runCmd;
      case "getSetpoint":
        return this.baseSetpoint;
      case "setSetpoint": {
        const value = Number(params);
        if (!Number.isFinite(value)) return { error: `invalid setpoint ${JSON.stringify(params)}` };
        this.baseSetpoint = round(clamp(value, 12, 30), 1);
        return this.baseSetpoint;
      }
      case "resetAlarm":
        this.resetAlarm();
        return true;
      case "replaceFilter":
        this.replaceFilter();
        return true;
      case "injectFault":
        if (params === "exhaustFan") this.trip(EXHAUST_FAN_FAILURE, "exhaust");
        else if (params === "frost") this.trip(FROST_PROTECTION);
        else this.trip(SUPPLY_FAN_FAILURE, "supply");
        return true;
      default:
        return { error: `unknown method ${method}` };
    }
  }

  // --- simulation ---------------------------------------------------------

  step(dt: number): void {
    this.t += dt;
    this.weather(dt);
    this.faults(dt);
    this.sequence();
    this.control(dt);
    this.actuators(dt);
    this.air(dt);
  }

  private weather(dt: number): void {
    // Ornstein-Uhlenbeck noise on top of the diurnal sine: smooth, not jumpy.
    this.outdoorDev += (-this.outdoorDev / 600) * dt + 0.06 * Math.sqrt(dt) * this.rng.gauss();
    this.dewDev += (-this.dewDev / 900) * dt + 0.04 * Math.sqrt(dt) * this.rng.gauss();
    const diurnal = this.cfg.outdoorAmplitude * Math.sin((2 * Math.PI * (this.simHour - 9)) / 24);
    this.outdoorTemp = this.cfg.outdoorMean + diurnal + this.outdoorDev;
    const dew = this.cfg.outdoorMean - 0.6 * this.cfg.outdoorAmplitude + this.dewDev;
    this.outdoorDew = Math.min(dew, this.outdoorTemp - 0.3);
  }

  private faults(dt: number): void {
    if (this.state === "RUNNING" && this.rng.random() < (this.cfg.faultRatePerHour / 3600) * dt) {
      if (this.rng.random() < 0.5) this.trip(SUPPLY_FAN_FAILURE, "supply");
      else this.trip(EXHAUST_FAN_FAILURE, "exhaust");
    }
  }

  private sequence(): void {
    switch (this.state) {
      case "ALARM":
        if (this.cfg.alarmAutoReset && this.t - this.alarmSince >= this.cfg.alarmAutoReset) this.resetAlarm();
        break;
      case "STOPPED":
        if (this.runCmd && this.t >= this.cfg.startDelay) this.state = "STARTING";
        break;
      case "STARTING":
      case "RUNNING":
        if (!this.runCmd) {
          this.state = "STOPPING";
        } else if (
          this.state === "STARTING" &&
          this.damper >= 99 &&
          Math.abs(this.supplyRpm - Math.min(this.rpmRequired, SUPPLY_RPM_MAX)) < 20
        ) {
          this.state = "RUNNING";
          // Bumpless transfer from the preheat valve position to PI control.
          this.integral = this.heatValve - KP * (this.setpoint - this.supplyTemp);
        }
        break;
      case "STOPPING":
        if (this.runCmd) this.state = "STARTING";
        else if (this.damper <= 0 && this.supplyRpm <= 0 && this.exhaustRpm <= 0) this.state = "STOPPED";
        break;
    }
  }

  private control(dt: number): void {
    let heatTarget = 0;
    let coolTarget = 0;
    if (this.state === "RUNNING") {
      const error = this.setpoint - this.supplyTemp;
      this.integral = clamp(this.integral + (KP / TI) * error * dt, -100, 100);
      const u = clamp(KP * error + this.integral, -100, 100);
      heatTarget = Math.max(u, 0);
      coolTarget = Math.max(-u, 0);
      this.frostTimer = this.supplyTemp < FROST_LIMIT ? this.frostTimer + dt : 0;
      if (this.frostTimer >= FROST_DELAY) this.trip(FROST_PROTECTION);
    } else if (this.state === "STARTING") {
      // Preheat the coil before air flows: feed-forward estimate of the valve needed at full airflow.
      heatTarget = clamp(((this.setpoint - this.outdoorTemp) / HEATER_MAX_DT) * 100, 0, 100);
    } else if (this.state === "ALARM" && this.alarmText === FROST_PROTECTION) {
      heatTarget = 100;
    } else if (this.outdoorTemp < 5) {
      heatTarget = 15; // standby heating keeps the water coil from freezing
    }
    this.heatValve = approach(this.heatValve, heatTarget, VALVE_RATE * dt);
    this.coolValve = approach(this.coolValve, coolTarget, VALVE_RATE * dt);
  }

  private actuators(dt: number): void {
    const fansSpinning = this.supplyRpm > 0 || this.exhaustRpm > 0;
    const openDamper =
      this.state === "STARTING" || this.state === "RUNNING" || (this.state === "STOPPING" && fansSpinning);
    this.damper = approach(this.damper, openDamper ? 100 : 0, (100 / DAMPER_TRAVEL) * dt);

    const fansOn = (this.state === "STARTING" || this.state === "RUNNING") && this.damper >= 90;
    const supplyTarget = fansOn ? Math.min(this.rpmRequired, SUPPLY_RPM_MAX) : 0;
    const exhaustTarget = fansOn ? EXHAUST_RPM_NOMINAL : 0;
    this.supplyRpm = AHU.ramp(this.supplyRpm, supplyTarget, this.failedFan === "supply", dt);
    this.exhaustRpm = AHU.ramp(this.exhaustRpm, exhaustTarget, this.failedFan === "exhaust", dt);
  }

  private static ramp(rpm: number, target: number, failed: boolean, dt: number): number {
    if (failed) return approach(rpm, 0, FAILED_FAN_RAMP_DOWN * dt);
    return approach(rpm, target, (target > rpm ? FAN_RAMP_UP : FAN_RAMP_DOWN) * dt);
  }

  private air(dt: number): void {
    // Fan affinity laws + quadratic network: airflow scales with rpm / required rpm.
    this.flowFrac = (this.supplyRpm / this.rpmRequired) * Math.min(1, this.damper / 80);
    this.filterDp = DP_CLEAN * this.filterR * this.flowFrac ** 2;
    this.filterR *= Math.exp(this.filterK * this.flowFrac * dt); // dust load grows with airflow
    if (this.filterDp >= DP_WARNING && !this.filterClogged) {
      this.filterClogged = true;
      this.cloggedSince = this.t;
    }
    if (this.filterClogged && this.t - this.cloggedSince >= this.cfg.filterServiceDelay) this.replaceFilter();

    // Water coils: less air through the coil means a larger temperature rise.
    const ff = Math.max(this.flowFrac, 0.8);
    this.heatCoil += (((HEATER_MAX_DT * this.heatValve) / 100 / ff - this.heatCoil) * dt) / COIL_TAU;
    this.coolCoil += (((COOLER_MAX_DT * this.coolValve) / 100 / ff - this.coolCoil) * dt) / COIL_TAU;
    const afterHeater = this.outdoorTemp + this.heatCoil;
    this.cooling = Math.min(this.coolCoil, Math.max(0, afterHeater - CHILLED_WATER_LIMIT));
    const movingAir = afterHeater - this.cooling + FAN_HEAT * this.flowFrac;
    const stillAir = this.outdoorTemp + 0.5 * (PLANT_ROOM_TEMP - this.outdoorTemp) + 0.3 * this.heatCoil;
    const w = Math.min(1, this.flowFrac / 0.3);
    const target = w * movingAir + (1 - w) * stillAir;
    const tau = SENSOR_TAU + (1 - w) * 120;
    this.supplyTemp += ((target - this.supplyTemp) * dt) / tau;
  }

  // --- output -------------------------------------------------------------

  telemetry(): Telemetry {
    const g = (sigma: number) => this.rng.gauss(0, sigma);
    const supplyDew =
      this.cooling > 0.5 ? Math.min(this.outdoorDew, this.supplyTemp - 1) : this.outdoorDew;
    const hour = Math.floor(this.simHour);
    const minute = Math.floor((this.simHour % 1) * 60);
    return {
      outdoorTemp: round(this.outdoorTemp + g(0.05), 1),
      supplyTemp: round(this.supplyTemp + g(0.05), 1),
      setpoint: round(this.setpoint, 1),
      outdoorHumidity: round(relativeHumidity(this.outdoorTemp, this.outdoorDew) + g(0.3), 1),
      supplyHumidity: round(relativeHumidity(this.supplyTemp, supplyDew) + g(0.3), 1),
      supplyFanRpm: round(Math.max(0, this.supplyRpm + (this.supplyRpm ? g(4) : 0))),
      exhaustFanRpm: round(Math.max(0, this.exhaustRpm + (this.exhaustRpm ? g(4) : 0))),
      airflow: round(NOMINAL_AIRFLOW * this.flowFrac),
      filterDp: round(Math.max(0, this.filterDp + (this.filterDp ? g(1.5) : 0)), 1),
      damperPos: round(this.damper),
      heatValve: round(this.heatValve),
      coolValve: round(this.coolValve),
      state: this.state,
      running: this.state === "RUNNING",
      alarm: this.state === "ALARM",
      alarmText: this.alarmText,
      filterClogged: this.filterClogged,
      simTime: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`,
    };
  }
}
