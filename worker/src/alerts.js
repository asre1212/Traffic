// Turns route check results into the one short notification that lands on the
// lock screen. iOS shows roughly the first line of the title and two lines of
// body, so the accident flag has to be in the title.

function routeLine(r) {
  if (!r.ok) return `${r.name}: unavailable`;
  const usual = r.baselineMinutes ? ` (usual ${r.baselineMinutes})` : '';
  const flag = r.hasAccident ? ' ⚠️' : '';
  return `${r.name}: ${r.minutes} min${usual}${flag}`;
}

function incidentLine(r) {
  const worst = r.accidents?.[0] || r.incidents?.find((i) => i.category === 8);
  if (!worst) return null;
  const where = worst.road || worst.where;
  const delay = worst.delayMinutes ? ` +${worst.delayMinutes} min` : '';
  return `${worst.type}${where ? ` on ${where}` : ''}${delay}`;
}

export function severityOf(r, threshold = 5) {
  if (!r.ok) return 'unknown';
  if (r.hasAccident || r.hasClosure) return 'bad';
  if (r.delayMinutes >= threshold * 2) return 'bad';
  if (r.delayMinutes >= threshold) return 'slow';
  return 'ok';
}

/**
 * @param {Array} results  checkRoute() output, in route order
 * @param {object} device  row from `devices`
 * @returns {{payload: object}|{skip: string}}
 */
export function buildAlert(results, device, { windowEndsAt = null } = {}) {
  const usable = results.filter((r) => r.ok);
  if (!usable.length) {
    const why = results[0]?.error || 'no routes configured';
    return { skip: `no usable route data: ${why}` };
  }

  const threshold = Number(device.delay_threshold) || 5;
  const lead = usable.find((r) => r.hasAccident) || usable[0];
  const severity = usable.reduce((worst, r) => {
    const s = severityOf(r, threshold);
    return s === 'bad' || worst === 'bad' ? 'bad' : s === 'slow' || worst === 'slow' ? 'slow' : 'ok';
  }, 'ok');

  // "Only when it matters" mode: stay silent on a clean run.
  if (!Number(device.quiet_ok) && severity === 'ok') {
    return { skip: 'clear roads and quiet mode is on' };
  }

  const icon = severity === 'bad' ? '⚠️' : severity === 'slow' ? '🐢' : '🚗';
  const title = `${icon} ${lead.minutes} min · ${lead.name}`;

  const lines = [];
  const flagged = incidentLine(lead);
  if (flagged) lines.push(flagged);
  else if (lead.delayMinutes >= threshold) lines.push(`${lead.delayMinutes} min slower than usual`);
  else lines.push('No accidents reported. Roads look normal.');

  for (const r of usable) {
    if (r === lead && usable.length > 1) continue;
    if (r !== lead) lines.push(routeLine(r));
  }
  if (usable.length === 1 && lead.baselineMinutes) {
    lines.push(`Usually ${lead.baselineMinutes} min · ${lead.distance.value} ${lead.distance.unit}`);
  }

  return {
    payload: {
      kind: 'alert',
      tag: 'commute',
      title,
      body: lines.slice(0, 3).join('\n'),
      severity,
      expiresAt: windowEndsAt,
      renotify: severity === 'bad',
      routes: usable.map((r) => ({
        id: r.routeId,
        name: r.name,
        minutes: r.minutes,
        baselineMinutes: r.baselineMinutes,
        delayMinutes: r.delayMinutes,
        hasAccident: r.hasAccident,
        severity: severityOf(r, threshold),
        incidents: r.incidents.slice(0, 4),
        distance: r.distance,
        arrival: r.arrival,
      })),
      checkedAt: new Date().toISOString(),
    },
  };
}

/** Sent once at window end so the notification does not sit on the lock screen all day. */
export function buildSweep() {
  return { kind: 'sweep', tag: 'commute', title: 'Commute window closed', body: '' };
}
