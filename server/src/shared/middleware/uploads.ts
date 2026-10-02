import type { Express } from 'express';

export function shouldServeUploads(nodeEnv: string): boolean {
  return nodeEnv !== 'production';
}

type Layer = { name?: string; regexp?: RegExp };

/** §7.2: production serves media from S3 only; the local /uploads folder must never be exposed. */
export function assertNoUploadsInProduction(app: Express, nodeEnv: string): void {
  if (nodeEnv !== 'production') return;
  const stack: Layer[] = (app as unknown as { _router?: { stack: Layer[] } })._router?.stack ?? [];
  if (stack.some((l) => l.name === 'serveStatic' && l.regexp?.test('/uploads/probe.jpg'))) {
    // eslint-disable-next-line no-console
    console.error('FATAL: /uploads static serving must be disabled in production');
    process.exit(1);
  }
}
