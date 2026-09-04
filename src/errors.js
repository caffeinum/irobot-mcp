/**
 * cleanMissionStatus.error codes. Table cross-checked against dorita980 and the
 * openHAB irobot binding. Unknown codes are reported as unknown, never guessed.
 */
export const ERROR_CODES = {
  0: "None",
  1: "Left wheel off floor",
  2: "Main brush stuck",
  3: "Right wheel off floor",
  4: "Left wheel stuck",
  5: "Right wheel stuck",
  6: "Stuck near a cliff",
  7: "Left wheel error",
  8: "Brush error",
  9: "Stuck on a cliff",
  10: "Left wheel stuck",
  11: "Right wheel stuck",
  12: "Stuck near a cliff",
  13: "Both wheels off floor",
  14: "Bin missing",
  15: "Reboot required",
  16: "Bumped unexpectedly",
  17: "Path blocked",
  18: "Docking issue",
  19: "Undocking issue",
  20: "Docking issue",
  21: "Navigation problem",
  22: "Navigation problem",
  23: "Battery issue",
  24: "Navigation problem",
  25: "Reboot required",
  26: "Vacuum problem",
  27: "Vacuum problem",
  28: "iTouch PCB error",
  29: "Software update needed",
  30: "Vacuum problem",
  31: "Reboot required",
  32: "Smart map problem",
  33: "Path blocked",
  34: "Reboot required",
  35: "Unrecognized cleaning pad",
  36: "Bin full",
  37: "Tank needs refilling",
  38: "Vacuum problem",
  39: "Reboot required",
  40: "Navigation problem",
  41: "Mission timed out",
  42: "Localization problem",
  43: "Navigation problem",
  44: "Pump issue",
  45: "Lid open",
  46: "Low battery",
  47: "Reboot required",
  48: "Path blocked",
  52: "Cleaning pad needs attention",
  53: "Software update required",
  65: "Hardware problem detected",
  66: "Low memory",
  68: "Hardware problem detected",
  73: "Pad type changed",
  74: "Max area reached",
  75: "Navigation problem",
  76: "Hardware problem detected",
  88: "Back-up refused",
  89: "Mission runtime too long",
  101: "Bin full",
  102: "Bin full",
  103: "Bin full",
  104: "No path to base",
  105: "Path blocked",
  106: "Bin full",
  107: "Bin full",
  109: "Bin full",
};

/** cleanMissionStatus.notReady — why a start request would be rejected. */
export const NOT_READY_CODES = {
  0: "Ready",
  2: "Uneven ground",
  3: "Low battery",
  4: "Bin full",
  5: "Tank needs refilling",
  6: "Cleaning pad missing",
  7: "Path blocked",
  8: "Saving map",
  9: "Cancelling job",
  15: "Battery too low to start",
  16: "Robot is busy",
  31: "Fill tank",
  39: "Updating software",
  68: "Robot is updating",
};

export const CYCLES = {
  none: "idle",
  clean: "cleaning",
  spot: "spot cleaning",
  quick: "quick clean",
  evac: "emptying bin",
  dock: "returning to dock",
  train: "training run (mapping)",
  hwPwrOff: "powered off",
};

export const PHASES = {
  charge: "charging on dock",
  run: "running",
  evac: "emptying into the base",
  stop: "stopped",
  stuck: "stuck — needs help",
  hmUsrDock: "returning to dock (you asked)",
  hmMidMsn: "returning to dock mid-mission (to recharge)",
  hmPostMsn: "returning to dock (mission finished)",
  pause: "paused",
  dockingMidMsn: "docking mid-mission",
  new: "starting a new mission",
};

export function describeError(code) {
  if (code === null || code === undefined) return null;
  const known = ERROR_CODES[code];
  return { code, message: known ?? `Unknown error code ${code}`, known: Boolean(known) };
}

export function describeNotReady(code) {
  if (code === null || code === undefined) return null;
  const known = NOT_READY_CODES[code];
  return { code, message: known ?? `Unknown notReady code ${code}`, known: Boolean(known) };
}

/**
 * Turn a raw robot state into a plain-language answer to "what is it doing,
 * and why did it stop?". Returns nulls for anything the robot did not report.
 */
export function explain(state) {
  const cms = state?.cleanMissionStatus ?? {};
  const error = describeError(cms.error);
  const notReady = describeNotReady(cms.notReady);
  const cycle = cms.cycle ?? null;
  const phase = cms.phase ?? null;

  let summary;
  if (error && error.code !== 0) {
    summary = `Stopped with an error: ${error.message}.`;
  } else if (phase === "stuck") {
    summary = "Stuck, but reporting no error code — it likely needs to be physically freed.";
  } else if (phase === "charge") {
    summary = `On the dock, charging${state?.batPct != null ? ` (${state.batPct}%)` : ""}.`;
  } else if (cycle === "none" && phase === "stop") {
    summary = "Idle and off-dock — stopped where it is.";
  } else if (cycle && phase) {
    summary = `${CYCLES[cycle] ?? cycle}, currently ${PHASES[phase] ?? phase}.`;
  } else {
    summary = "The robot did not report a mission cycle or phase.";
  }

  if (notReady && notReady.code !== 0) {
    summary += ` It will refuse to start a new job: ${notReady.message}.`;
  }
  if (state?.bin?.full) summary += " Bin is full.";
  if (state?.bin?.present === false) summary += " Bin is missing.";

  return {
    summary,
    cycle,
    cycleLabel: cycle ? (CYCLES[cycle] ?? cycle) : null,
    phase,
    phaseLabel: phase ? (PHASES[phase] ?? phase) : null,
    error,
    notReady,
    minutesRunning: cms.mssnM ?? null,
    sqft: cms.sqft ?? null,
    missionNumber: cms.nMssn ?? null,
    minutesToRecharge: cms.rechrgM ?? null,
    initiator: cms.initiator ?? null,
  };
}
