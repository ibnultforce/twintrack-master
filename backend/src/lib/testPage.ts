import { fileURLToPath } from 'node:url';
import express, { type Application } from 'express';

const TEST_PAGE_PATH = '/try';
// The same depth from src/lib and dist/lib, so this finds backend/test-page in both.
const TEST_PAGE_FOLDER = fileURLToPath(new URL('../../test-page/', import.meta.url));

// Helmet's default also upgrades requests to HTTPS, which would break the page on a plain network address.
const TEST_PAGE_CONTENT_SECURITY_POLICY = "default-src 'self'; base-uri 'self'; form-action 'none'; frame-ancestors 'none'; object-src 'none'";

/** Serves the page people use to try the API from a browser. It's static files, so it isn't an API route. */
export function serveTestPage(app: Application): void {
  app.use(
    TEST_PAGE_PATH,
    express.static(TEST_PAGE_FOLDER, {
      setHeaders: (res) => res.setHeader('Content-Security-Policy', TEST_PAGE_CONTENT_SECURITY_POLICY),
    }),
  );
}
