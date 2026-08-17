const PRIORITY_LEVELS = Object.freeze({
  critical: 1,
  expired: 3,
  expiring: 6,
  announcement: 10
});

const PRIORITY_NAMES = Object.freeze(Object.keys(PRIORITY_LEVELS));

function priorityNameFromNumber(value) {
  const level = Number(value);
  if (level <= 2) return "critical";
  if (level <= 4) return "expired";
  if (level <= 8) return "expiring";
  return "announcement";
}

function normalizeSendPriority(value) {
  let name;
  if (typeof value === "number" && Number.isFinite(value)) {
    name = priorityNameFromNumber(value);
  } else {
    const requested = String(value || "").trim().toLowerCase();
    if (requested === "high") name = "critical";
    else if (requested === "normal" || requested === "") name = "expiring";
    else name = PRIORITY_NAMES.includes(requested) ? requested : "expiring";
  }
  return {
    name,
    level: PRIORITY_LEVELS[name],
    bypassQuietHours: name === "critical"
  };
}

function priorityForJob(job) {
  return normalizeSendPriority(
    job?.data?.priority || job?.data?.priorityLevel || job?.opts?.priority || (job?.opts?.lifo ? "high" : undefined)
  );
}

module.exports = {
  PRIORITY_LEVELS,
  PRIORITY_NAMES,
  normalizeSendPriority,
  priorityForJob
};
