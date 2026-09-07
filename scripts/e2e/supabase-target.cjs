'use strict';
const PROJECT_REF = 'fuojmuyggmnlsxfyvby';
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
module.exports = { validateTarget, PROJECT_REF };
