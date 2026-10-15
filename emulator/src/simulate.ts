/**
 * Offline check of the model, no ThingsBoard needed: `npm run simulate`.
 * Runs one simulated day, then exercises the alarm / stop / setpoint commands.
 */
import { AHU, Rng, defaultConfig } from "./ahuModel.ts";

const DT = 0.5;
const ahu = new AHU({ ...defaultConfig, faultRatePerHour: 0, alarmAutoReset: 60 }, new Rng(1));

function row(label: string): void {
  const d = ahu.telemetry();
  console.log(
    `${label.padEnd(22)} t=${String(Math.round(ahu.t)).padStart(5)} ${d.simTime} ${d.state.padEnd(8)} ` +
      `out=${d.outdoorTemp} sup=${d.supplyTemp} sp=${d.setpoint} heat=${d.heatValve}% cool=${d.coolValve}% ` +
      `damper=${d.damperPos}% rpm=${d.supplyFanRpm}/${d.exhaustFanRpm} flow=${d.airflow} dp=${d.filterDp} ` +
      `clogged=${d.filterClogged} rh=${d.outdoorHumidity}/${d.supplyHumidity} ${d.alarmText}`,
  );
}

function run(seconds: number, every: number, label = ""): void {
  for (let i = 1; i <= seconds / DT; i++) {
    ahu.step(DT);
    if ((i * DT) % every === 0) row(label);
  }
}

run(120, 10, "startup");
run(3480, 120, "day cycle");
console.log(ahu.handleRpc("injectFault", "exhaustFan"));
run(90, 15, "exhaust fan fault");
run(120, 30, "auto reset + restart");
console.log(ahu.handleRpc("setRun", false));
run(60, 15, "stop command");
console.log(ahu.handleRpc("setRun", true), ahu.handleRpc("setSetpoint", 23));
run(180, 30, "start + setpoint 23");
console.log(ahu.handleRpc("setSetpoint", "abc"), ahu.handleRpc("foo", null));
