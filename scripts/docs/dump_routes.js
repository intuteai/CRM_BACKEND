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
  const rel = `${m[2]}/${m[3]}`; // a folder router (routes/testing) resolves to its index.js
  files[m[1]] = fs.existsSync(path.join(root, `${rel}.js`)) ? `${rel}.js` : `${rel}/index.js`;
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

  // requireRoles(...) guards (middleware/roles.js): inline, router-wide, or
  // held in a const (const canUse = requireRoles(...)), with ...ARRAY spreads.
  const arrays = {};
  for (const c of src.matchAll(/const\s+(\w+)\s*=\s*\[([^\]]*)\]/g)) arrays[c[1]] = c[2];
  const roleList = (txt) => 'roles: ' + txt
    .replace(/\.\.\.(\w+)/g, (_, n) => arrays[n] || n)
    .split(',')
    .map((s) => s.trim().replace(/^ROLES\./, '').toLowerCase())
    .filter(Boolean)
    .join(', ');
  const guardConsts = {};
  for (const c of src.matchAll(/const\s+(\w+)\s*=\s*requireRoles\(([^)]*)\)/g)) guardConsts[c[1]] = roleList(c[2]);
  for (const u of src.matchAll(/router\.use\(authenticateToken,\s*requireRoles\(([^)]*)\)/g)) guards.push(roleList(u[1]));

  // Paths may be template literals inside a loop (routes/testing): `${kind}` is shown as {kind}.
  for (const r of src.matchAll(/router\.(get|post|put|patch|delete)\(\s*['`]([^'`]*)['`]([\s\S]*?)\)\s*;?[ \t]*(?:\/\/[^\n]*)?\n/g)) {
    const rest = r[3];
    const perms = [...rest.matchAll(/checkPermission\('([^']+)',\s*'([^']+)'\)/g)]
      .map((x) => `${x[1]}:${x[2].replace('can_', '')}`);
    for (const x of rest.matchAll(/requireRoles\(([^)]*)\)/g)) perms.push(roleList(x[1]));
    // requireTestingRole(...) (middleware/testingRoles.js): testing roles from mt_user_role.
    for (const x of rest.matchAll(/requireTestingRole\(([^)]*)\)/g)) {
      perms.push('testing roles: ' + x[1].replace(/\.\.\.(\w+)/g, (_, n) => arrays[n] || n).replace(/'/g, '')
        .split(',').map((s) => s.trim()).filter(Boolean).join(', '));
    }
    for (const [name, roles] of Object.entries(guardConsts)) {
      if (new RegExp(`\\b${name}\\b`).test(rest)) perms.push(roles);
    }
    const extra = [];
    if (/requirePdiAccess/.test(rest)) extra.push('PDI roles');
    if (/upload\.single/.test(rest)) extra.push('multipart upload');
    const auth = routerAuth || /authenticateToken/.test(rest);
    const handler = (rest.match(/controller\.(\w+)/) || (file.startsWith('routes/testing/') && rest.match(/\b[ac]\.(\w+)/)) || [])[1] || 'inline handler';
    const p = (m[1] + (r[2] === '/' ? '' : r[2].replace(/\$\{(\w+)\}/g, '{$1}'))).replace(/\/$/, '') || '/';
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
