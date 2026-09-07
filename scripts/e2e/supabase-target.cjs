'use strict';
const PROJECT_REF = 'fuojmuyggmnlsxfyvby';
const TARGET_DIAGNOSTIC_KEYS = [
  'HOST',
  'USER',
  'PORT',
  'DATABASE',
];

function inspectTarget(value) {
  const checks = {
    HOST: false,
    USER: false,
    PORT: false,
    DATABASE: false,
    SSL_OPTIONS: false,
  };
  let url;
  try { url = new URL(value); } catch { return checks; }
  let user;
  try { user = decodeURIComponent(url.username); } catch { return checks; }

  const directHost = url.hostname === `db.${PROJECT_REF}.supabase.co`;
  const sessionHost = /^aws-\d+-us-east-1\.pooler\.supabase\.com$/.test(url.hostname);
  const directUser = user === 'postgres';
  const sessionUser = user === `postgres.${PROJECT_REF}`;

  checks.HOST = directHost || sessionHost;
  checks.USER = directUser || sessionUser;
  checks.PORT = url.port === '5432';
  checks.DATABASE = url.pathname === '/postgres';
  checks.SSL_OPTIONS = !url.hash && [...url.searchParams].every(([key, val]) =>
    (key === 'schema' && val === 'public') || (key === 'sslmode' && val === 'verify-full')
  );

  return checks;
}

function targetDiagnostics(entries) {
  const diagnostics = {};
  for (const { key, value } of entries) {
    const checks = inspectTarget(value);
    for (const checkKey of TARGET_DIAGNOSTIC_KEYS) {
      diagnostics[`TARGET_${key}_${checkKey}`] = checks[checkKey];
    }
  }
  const sslChecks = entries.map(({ value }) => inspectTarget(value).SSL_OPTIONS);
  diagnostics.TARGET_SSL_OPTIONS = sslChecks.length > 0 && sslChecks.every(Boolean);
  return diagnostics;
}

function validateTarget(value) {
  const fail = () => { throw new Error('E2E_TARGET_REJECTED'); };
  let url;
  try { url = new URL(value); } catch { return fail(); }
  let user;
  try { user = decodeURIComponent(url.username); } catch { return fail(); }
  const direct = url.hostname === `db.${PROJECT_REF}.supabase.co` && user === 'postgres';
  const session = /^aws-\d+-us-east-1\.pooler\.supabase\.com$/.test(url.hostname)
    && user === `postgres.${PROJECT_REF}`;
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !(direct || session)
    || url.port !== '5432' || url.pathname !== '/postgres' || !url.password || url.hash) fail();
  for (const [key, val] of url.searchParams) {
    if (!(key === 'schema' && val === 'public') && !(key === 'sslmode' && val === 'verify-full')) fail();
  }
  // SSL is configured explicitly below; query parameters cannot override it.
  url.search = '';
  return { connectionString: url.toString(), mode: direct ? 'direct' : 'session', projectRef: PROJECT_REF };
}
module.exports = { validateTarget, inspectTarget, targetDiagnostics, PROJECT_REF };
