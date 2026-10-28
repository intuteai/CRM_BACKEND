// Builds the REST endpoint catalogue (Appendix A of the technical documentation)
// by reading server.js mount points and each router file. Static text parsing
// only: nothing is required or executed.
// Usage: node scripts/docs/dump_routes.js [outFile]
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..');
const out = process.argv[2] || path.join(root, 'docs', 'technical', 'generated', 'routes.json');

const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const files = {};
for (const m of server.matchAll(/const\s+(\w+)\s*=\s*require\('\.\/(routes|chatbot\/routes)\/([^']+)'\)/g)) {
  files[m[1]] = `${m[2]}/${m[3]}.js`;
}

const endpoints = [];
for (const m of server.matchAll(/app\.use\('([^']+)',\s*(\w+)\)/g)) {
  const file = files[m[2]];
  if (!file) continue;
  const src = fs.readFileSync(path.join(root, file), 'utf8');

  // Router-wide guards declared with router.use(...)
  const guards = [];
  if (/router\.use\(authenticateToken, requirePdiAccess\)/.test(src)) guards.push('PDI roles (admin, production)');
  if (/role_id !== 1/.test(src)) guards.push('Admin only');
  const allowed = src.match(/ALLOWED_ROLES = \[([^\]]+)\]/);
  if (allowed) guards.push(`role_id in [${allowed[1]}]`);
  const routerAuth = /router\.use\(authenticateToken/.test(src);

  for (const r of src.matchAll(/router\.(get|post|put|patch|delete)\(\s*'([^']*)'([\s\S]*?)\)\s*;?\s*\n/g)) {
    const rest = r[3];
    const perms = [...rest.matchAll(/checkPermission\('([^']+)',\s*'([^']+)'\)/g)]
      .map((x) => `${x[1]}:${x[2].replace('can_', '')}`);
    const extra = [];
    if (/requirePdiAccess/.test(rest)) extra.push('PDI roles');
    if (/upload\.single/.test(rest)) extra.push('multipart upload');
    const auth = routerAuth || /authenticateToken/.test(rest);
    const handler = (rest.match(/controller\.(\w+)/) || [])[1] || 'inline handler';
    const p = (m[1] + (r[2] === '/' ? '' : r[2])).replace(/\/$/, '') || '/';
    endpoints.push({
      method: r[1].toUpperCase(),
      path: p,
      file,
      handler,
      auth: auth ? 'JWT' : 'Public',
      perm: [...perms, ...extra, ...guards].join(', ') || (auth ? 'Any authenticated' : '—'),
    });
  }
}

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(endpoints, null, 1));
console.log(`routes: ${endpoints.length} endpoints -> ${out}`);
