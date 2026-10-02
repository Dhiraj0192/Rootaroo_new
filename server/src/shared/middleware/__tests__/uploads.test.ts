import express from 'express';
import path from 'path';
import { shouldServeUploads, assertNoUploadsInProduction } from '../uploads';

describe('uploads static serving', () => {
  it('is only served outside production', () => {
    expect(shouldServeUploads('development')).toBe(true);
    expect(shouldServeUploads('production')).toBe(false);
  });

  it('startup assertion exits when /uploads is mounted in production', () => {
    const exit = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const app = express();
    app.use('/uploads', express.static(path.resolve('./uploads')));
    app.use((_req, res) => { res.status(404).end(); });
    assertNoUploadsInProduction(app, 'production');
    expect(exit).toHaveBeenCalledWith(1);
    exit.mockClear();
    const clean = express();
    clean.use((_req, res) => { res.status(404).end(); });
    assertNoUploadsInProduction(clean, 'production');
    expect(exit).not.toHaveBeenCalled();
    exit.mockRestore();
  });
});
