/** Format agent-visible wall-clock times without changing UTC protocol data. */
export function resolveAgentTimeZone(configured = process.env.AGENT_TIMEZONE): string {
  const zone = configured?.trim() || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone }).format(new Date(0));
  } catch {
    throw new Error(`Invalid AGENT_TIMEZONE: ${JSON.stringify(zone)}`);
  }
  return zone;
}

export function formatAgentDateTime(value: Date | number, timeZone = resolveAgentTimeZone()): string {
  const date = value instanceof Date ? value : new Date(value);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23', timeZoneName: 'longOffset',
  }).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? '';
  const rawOffset = get('timeZoneName');
  const offset = rawOffset === 'GMT' ? '+00:00' : rawOffset.replace('GMT', '');
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}${offset} [${timeZone}]`;
}
