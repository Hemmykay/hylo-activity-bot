import { randomUUID } from 'crypto';

interface Entry {
  text: string;
  timer: ReturnType<typeof setTimeout>;
}

const buffer = new Map<string, Entry>();

const TTL_MS = 2 * 60 * 60 * 1000; // 2 hours

export function storeCopyText(text: string): string {
  const id = randomUUID();
  const timer = setTimeout(() => buffer.delete(id), TTL_MS);
  // Allow Node to exit even if the timer is pending
  timer.unref?.();
  buffer.set(id, { text, timer });
  return id;
}

export function getCopyText(id: string): string | undefined {
  return buffer.get(id)?.text;
}
