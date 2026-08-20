import { config } from './config';

export type BinType = 'general' | 'recycling';

/** The date of the next Friday collection (at noon), from a given reference day. */
function nextFriday(from: Date = new Date()): Date {
  const dayOfWeek = from.getDay(); // 0=Sun … 4=Thu … 5=Fri
  const daysUntilFriday = (5 - dayOfWeek + 7) % 7 || 7;
  const d = new Date(from);
  d.setHours(12, 0, 0, 0);
  d.setDate(from.getDate() + daysUntilFriday);
  return d;
}

/** Which bin type is due on the next Friday collection. */
export function getFridayBinType(from: Date = new Date()): BinType {
  const target = nextFriday(from);
  const refDate = new Date(config.bin.referenceDate + 'T12:00:00');
  const diffDays = Math.round((target.getTime() - refDate.getTime()) / (1000 * 60 * 60 * 24));
  const diffWeeks = Math.round(diffDays / 7);
  const sameAsRef = diffWeeks % 2 === 0;
  if (sameAsRef) return config.bin.referenceType;
  return config.bin.referenceType === 'general' ? 'recycling' : 'general';
}

/** Friendly colour/label for a bin type (Cheltenham: green = general, blue = recycling). */
export function binLabel(type: BinType): { colour: string; label: string } {
  return type === 'general'
    ? { colour: 'green', label: 'green bin (general waste)' }
    : { colour: 'blue', label: 'blue bin (recycling)' };
}

/** The date of the next collection as a display string. */
export function nextFridayDate(from: Date = new Date()): Date {
  return nextFriday(from);
}
