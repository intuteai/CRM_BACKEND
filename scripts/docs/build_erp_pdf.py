"""Build docs/ERP_Technical_Documentation.pdf.

Inputs (all under docs/technical/):
  meta.json            version + revision history shown on the Document Control page
  chapters/*.md        hand-maintained chapter text (edit these when the code changes)
  generated/*.json     routes.json + schema.json from scripts/docs/dump_*.js (regenerated each run)

Usage: python scripts/docs/build_erp_pdf.py   (normally via `npm run docs:pdf`)
Requires: Python 3 + reportlab (pip install reportlab)
"""
import json, re, sys, os, datetime, subprocess
from collections import defaultdict, OrderedDict
from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm
from reportlab.lib import colors
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.enums import TA_LEFT, TA_CENTER
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (BaseDocTemplate, PageTemplate, Frame, Paragraph, Spacer, PageBreak,
                                Table, TableStyle, Preformatted, KeepTogether, NextPageTemplate, CondPageBreak)
from reportlab.platypus.tableofcontents import TableOfContents

BACKEND = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..'))
TECH = os.path.join(BACKEND, 'docs', 'technical')
CHAPTERS = os.path.join(TECH, 'chapters')
GEN = os.path.join(TECH, 'generated')
OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(BACKEND, 'docs', 'ERP_Technical_Documentation.pdf')

META = json.load(open(os.path.join(TECH, 'meta.json'), encoding='utf-8'))
TODAY = datetime.date.today()
try:
    COMMIT = subprocess.run(['git', 'rev-parse', '--short', 'HEAD'], cwd=BACKEND, capture_output=True, text=True).stdout.strip() or 'unknown'
except OSError:
    COMMIT = 'unknown'

def first_font(*paths):
    for p in paths:
        if os.path.exists(p): return p
    return None

FONTS = os.path.join(BACKEND, 'assets', 'fonts')
pdfmetrics.registerFont(TTFont('Roboto', os.path.join(FONTS, 'Roboto-Regular.ttf')))
pdfmetrics.registerFont(TTFont('Roboto-Bold', os.path.join(FONTS, 'Roboto-Bold.ttf')))
pdfmetrics.registerFont(TTFont('Roboto-Medium', os.path.join(FONTS, 'Roboto-Medium.ttf')))
_mono = first_font(r'C:\Windows\Fonts\consola.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf',
                   '/Library/Fonts/Menlo.ttc', '/System/Library/Fonts/Menlo.ttc')
pdfmetrics.registerFont(TTFont('Mono', _mono) if _mono else TTFont('Mono', os.path.join(FONTS, 'Roboto-Regular.ttf')))
_ital = first_font(r'C:\Windows\Fonts\segoeuii.ttf')
pdfmetrics.registerFont(TTFont('Roboto-Italic', _ital or os.path.join(FONTS, 'Roboto-Regular.ttf')))
from reportlab.pdfbase.pdfmetrics import registerFontFamily
registerFontFamily('Roboto', normal='Roboto', bold='Roboto-Bold', italic='Roboto-Italic', boldItalic='Roboto-Bold')

NAVY = colors.HexColor('#0f2a4a'); GOLD = colors.HexColor('#c9a227'); INK = colors.HexColor('#1f2937')
MUTED = colors.HexColor('#6b7280'); LINE = colors.HexColor('#d1d5db'); ZEBRA = colors.HexColor('#f4f6f9')
CODEBG = colors.HexColor('#f3f4f6')

st = {
    'body': ParagraphStyle('body', fontName='Roboto', fontSize=9.6, leading=13.6, textColor=INK, spaceAfter=5),
    'h1': ParagraphStyle('h1', fontName='Roboto-Bold', fontSize=20, leading=25, textColor=NAVY, spaceAfter=10, spaceBefore=0),
    'h2': ParagraphStyle('h2', fontName='Roboto-Bold', fontSize=13.5, leading=18, textColor=NAVY, spaceBefore=12, spaceAfter=6),
    'h3': ParagraphStyle('h3', fontName='Roboto-Bold', fontSize=11.2, leading=15, textColor=INK, spaceBefore=9, spaceAfter=4),
    'h4': ParagraphStyle('h4', fontName='Roboto-Medium', fontSize=10, leading=14, textColor=NAVY, spaceBefore=6, spaceAfter=3),
    'bullet': ParagraphStyle('bullet', fontName='Roboto', fontSize=9.6, leading=13.4, textColor=INK, spaceAfter=2.5),
    'cell': ParagraphStyle('cell', fontName='Roboto', fontSize=8.2, leading=10.6, textColor=INK),
    'cellh': ParagraphStyle('cellh', fontName='Roboto-Bold', fontSize=8.2, leading=10.6, textColor=colors.white),
    'code': ParagraphStyle('code', fontName='Mono', fontSize=7.8, leading=10, textColor=INK),
    'toc1': ParagraphStyle('toc1', fontName='Roboto-Bold', fontSize=10.5, leading=16, leftIndent=0, textColor=NAVY),
    'toc2': ParagraphStyle('toc2', fontName='Roboto', fontSize=9.2, leading=12.5, leftIndent=16, textColor=INK),
}

def esc(t):
    return t.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')

def inline(t):
    """Markdown inline -> reportlab mini-HTML."""
    t = t.replace('∈', ' in ')
    parts = re.split(r'(`[^`]+`)', t)
    out = []
    for p in parts:
        if p.startswith('`') and p.endswith('`') and len(p) > 1:
            out.append('<font name="Mono" size="8.4" color="#9b2c2c">' + esc(p[1:-1]) + '</font>')
        else:
            p = esc(p)
            p = re.sub(r'\[([^\]]+)\]\(([^)]+)\)', r'\1', p)
            p = re.sub(r'\*\*(.+?)\*\*', r'<b>\1</b>', p)
            p = re.sub(r'(?<![\w*])\*(?!\s)(.+?)(?<!\s)\*(?![\w*])', r'<i>\1</i>', p)
            p = p.replace('→', '<font name="Mono">→</font>')
            out.append(p)
    return ''.join(out)

class Doc(BaseDocTemplate):
    def __init__(self, fn, **kw):
        super().__init__(fn, pagesize=A4, leftMargin=18*mm, rightMargin=18*mm, topMargin=20*mm, bottomMargin=18*mm,
                         title='Intute ERP - Technical Documentation', author='Intute AI / Compage',
                         subject='Complete technical documentation of the ERP system', **kw)
        fr = Frame(self.leftMargin, self.bottomMargin, self.width, self.height, id='f')
        self.addPageTemplates([PageTemplate('cover', [fr], onPage=self.cover_bg),
                               PageTemplate('body', [fr], onPage=self.decor)])
        self.chapter = ''
    def beforeDocument(self):
        self.chapter = 'Contents'
    def afterFlowable(self, f):
        if isinstance(f, Paragraph) and hasattr(f, '_toc'):
            lvl, text, key = f._toc
            if lvl == 0: self.chapter = text
            self.canv.bookmarkPage(key)
            self.canv.addOutlineEntry(text, key, level=lvl, closed=lvl > 0)
            self.notify('TOCEntry', (lvl, text, self.page, key))
    def cover_bg(self, c, d):
        w, h = A4
        c.saveState(); c.setFillColor(NAVY); c.rect(0, 0, w, h, stroke=0, fill=1)
        c.setFillColor(GOLD); c.rect(0, h*0.36, w, 4, stroke=0, fill=1); c.restoreState()
    def decor(self, c, d):
        w, h = A4
        c.saveState()
        c.setStrokeColor(GOLD); c.setLineWidth(1.2); c.line(18*mm, h-13*mm, w-18*mm, h-13*mm)
        c.setFont('Roboto-Medium', 7.8); c.setFillColor(MUTED)
        c.drawString(18*mm, h-11*mm, 'INTUTE ERP  |  TECHNICAL DOCUMENTATION')
        c.drawRightString(w-18*mm, h-11*mm, self.chapter[:70])
        c.setStrokeColor(LINE); c.setLineWidth(0.5); c.line(18*mm, 12*mm, w-18*mm, 12*mm)
        c.drawString(18*mm, 8*mm, 'Confidential - internal use only')
        c.drawRightString(w-18*mm, 8*mm, 'Page %d' % d.page)
        c.restoreState()

_key = [0]
def heading(text, lvl):
    _key[0] += 1
    p = Paragraph(inline(text), st['h%d' % (lvl+1)])
    if lvl <= 1:
        p._toc = (lvl, re.sub(r'[`*]', '', text), 'h%d' % _key[0])
    return p

def make_table(rows, header=True, widths=None, fs=None):
    cs = st['cell'] if fs is None else ParagraphStyle('c', parent=st['cell'], fontSize=fs, leading=fs*1.3)
    hs = st['cellh'] if fs is None else ParagraphStyle('ch', parent=st['cellh'], fontSize=fs, leading=fs*1.3)
    ncol = max(len(r) for r in rows)
    rows = [r + [''] * (ncol - len(r)) for r in rows]
    data = [[Paragraph(inline(c) if not isinstance(c, Paragraph) else c, hs if (header and i == 0) else cs) for c in r] for i, r in enumerate(rows)]
    total = A4[0] - 36*mm
    if widths is None:
        lens = [max(min(len(re.sub(r'[`*]', '', r[j])), 60) for r in rows) + 4 for j in range(ncol)]
        widths = [total * l / sum(lens) for l in lens]
        mn = 16*mm
        widths = [max(w, mn) for w in widths]
        sc = total / sum(widths); widths = [w*sc for w in widths]
    else:
        widths = [total * w for w in widths]
    t = Table(data, colWidths=widths, repeatRows=1 if header else 0)
    sty = [('GRID', (0, 0), (-1, -1), 0.4, LINE), ('VALIGN', (0, 0), (-1, -1), 'TOP'),
           ('LEFTPADDING', (0, 0), (-1, -1), 4), ('RIGHTPADDING', (0, 0), (-1, -1), 4),
           ('TOPPADDING', (0, 0), (-1, -1), 2.5), ('BOTTOMPADDING', (0, 0), (-1, -1), 2.5)]
    if header: sty.append(('BACKGROUND', (0, 0), (-1, 0), NAVY))
    for i in range(1 if header else 0, len(data)):
        if i % 2 == 0: sty.append(('BACKGROUND', (0, i), (-1, i), ZEBRA))
    t.setStyle(TableStyle(sty))
    return t

def code_block(lines):
    txt = '\n'.join(lines).replace('∈', 'in')
    # wrap long lines
    wrapped = []
    for ln in txt.split('\n'):
        while len(ln) > 105: wrapped.append(ln[:105]); ln = '    ' + ln[105:]
        wrapped.append(ln)
    # One table row per 12-line chunk so long blocks can break across pages.
    chunks = [wrapped[i:i + 12] for i in range(0, len(wrapped), 12)] or [['']]
    t = Table([[Preformatted('\n'.join(c), st['code'])] for c in chunks], colWidths=[A4[0]-36*mm])
    t.setStyle(TableStyle([('BACKGROUND', (0, 0), (-1, -1), CODEBG), ('BOX', (0, 0), (-1, -1), 0.4, LINE),
                           ('LEFTPADDING', (0, 0), (-1, -1), 6), ('TOPPADDING', (0, 0), (-1, -1), 0), ('BOTTOMPADDING', (0, 0), (-1, -1), 0),
                           ('TOPPADDING', (0, 0), (-1, 0), 5), ('BOTTOMPADDING', (0, -1), (-1, -1), 5)]))
    return t

def md_to_flow(md, shift=0, first_h1_break=True):
    """shift: added to heading levels (0 => '#' is chapter)."""
    flow = []
    lines = md.replace('\r', '').split('\n')
    i = 0; para = []
    def flush():
        if para:
            flow.append(Paragraph(inline(' '.join(s.strip() for s in para)), st['body'])); para.clear()
    while i < len(lines):
        ln = lines[i]
        if ln.strip().startswith('```'):
            flush(); j = i + 1; buf = []
            while j < len(lines) and not lines[j].strip().startswith('```'): buf.append(lines[j]); j += 1
            flow.append(code_block(buf)); flow.append(Spacer(1, 5)); i = j + 1; continue
        m = re.match(r'^(#{1,6})\s+(.*)$', ln)
        if m:
            flush(); lvl = min(len(m.group(1)) - 1 + shift, 3)
            if lvl == 0:
                flow.append(NextPageTemplate('body')); flow.append(PageBreak())
            elif lvl == 1:
                flow.append(CondPageBreak(60*mm))
            flow.append(heading(m.group(2).strip(), lvl)); i += 1; continue
        if ln.strip().startswith('|') and i + 1 < len(lines) and re.match(r'^\s*\|?\s*:?-{2,}', lines[i+1]):
            flush(); rows = []
            while i < len(lines) and lines[i].strip().startswith('|'):
                if not re.match(r'^\s*\|?\s*:?-{2,}', lines[i]):
                    cells = [c.strip() for c in re.split(r'(?<!\\)\|', lines[i].strip().strip('|'))]
                    rows.append([c.replace('\\|', '|') for c in cells])
                i += 1
            flow.append(make_table(rows)); flow.append(Spacer(1, 6)); continue
        mb = re.match(r'^(\s*)([-*+]|\d+[.)])\s+(.*)$', ln)
        if mb:
            flush(); ind = len(mb.group(1).expandtabs(2)) // 2
            text = mb.group(3)
            j = i + 1
            while j < len(lines) and lines[j].strip() and not re.match(r'^(\s*)([-*+]|\d+[.)])\s+', lines[j]) \
                    and not lines[j].strip().startswith(('|', '#', '```')) and lines[j].startswith(' '):
                text += ' ' + lines[j].strip(); j += 1
            bullet = '\u2022' if mb.group(2) in '-*+' else mb.group(2)
            ps = ParagraphStyle('b', parent=st['bullet'], leftIndent=12 + ind*12, bulletIndent=2 + ind*12)
            flow.append(Paragraph(inline(text), ps, bulletText=bullet)); i = j; continue
        if re.match(r'^\s*(---|\*\*\*)\s*$', ln):
            flush(); i += 1; continue
        if not ln.strip():
            flush(); i += 1; continue
        para.append(ln); i += 1
    flush()
    return flow

def shift_md(md, target=1):
    lvls = [len(m.group(1)) for m in re.finditer(r'^(#{1,6})\s', md, re.M)]
    # ignore headings inside code fences roughly
    if not lvls: return md, 0
    return md, target - (min(lvls) - 1)

# ---------------------------------------------------------------- content
def read(name):
    p = os.path.join(CHAPTERS, name)
    if not os.path.exists(p):
        sys.exit('Missing chapter file: %s (listed in docs/technical/meta.json)' % p)
    return open(p, encoding='utf-8').read()

def load_gen(name):
    p = os.path.join(GEN, name)
    if not os.path.exists(p):
        sys.exit('Missing %s - run `npm run docs:pdf` (it regenerates it) or scripts/docs/dump_*.js first' % p)
    return json.load(open(p, encoding='utf-8'))

story = []
# Cover
cov_t = ParagraphStyle('ct', fontName='Roboto-Bold', fontSize=34, leading=40, textColor=colors.white)
cov_s = ParagraphStyle('cs', fontName='Roboto', fontSize=14, leading=20, textColor=colors.HexColor('#dbe4f0'))
cov_g = ParagraphStyle('cg', fontName='Roboto-Medium', fontSize=11, leading=16, textColor=GOLD)
story += [Spacer(1, 55*mm), Paragraph('INTUTE ERP', cov_g), Spacer(1, 4),
          Paragraph('Complete Technical<br/>Documentation', cov_t), Spacer(1, 10),
          Paragraph('Backend API &middot; Data Model &middot; Web CRM &middot; PDI Mobile App &middot; Integrations &middot; Deployment', cov_s),
          Spacer(1, 70*mm),
          Paragraph('Version %s &nbsp;|&nbsp; %s' % (esc(META['version']), TODAY.strftime('%d %B %Y')), cov_s),
          Paragraph('Prepared for: Compage / Intute AI engineering team', cov_s),
          Paragraph('Classification: Confidential - internal use only', cov_s)]

# Document control + TOC
story += [NextPageTemplate('body'), PageBreak()]
story.append(Paragraph('Document Control', st['h1']))
story.append(make_table([['Item', 'Detail'],
    ['Document', 'Intute ERP - Complete Technical Documentation'],
    ['Version / date', '%s - %s' % (META['version'], TODAY.strftime('%d %B %Y'))],
    ['Systems covered', 'CRM_BACKEND (Node/Express API), CRM (React web app), pdi-erp-app (React Native mobile app)'],
    ['Source of truth', 'Backend source at commit %s and the live PostgreSQL schema (information_schema) read on the date above' % COMMIT],
    ['Audience', 'Software engineers, DevOps, QA and technical stakeholders maintaining or extending the ERP'],
    ['Generation', 'Chapters come from docs/technical/chapters/*.md. Appendices A-C are regenerated from the route files and the database catalogue on every build (npm run docs:pdf).']],
    widths=[0.25, 0.75]))
story.append(Spacer(1, 8))
story.append(Paragraph('Revision history', st['h3']))
story.append(make_table([['Version', 'Date', 'Author', 'Changes']] +
    [[h['version'], h['date'], h.get('author', ''), h['changes']] for h in META['history']],
    widths=[0.1, 0.15, 0.2, 0.55]))
story.append(PageBreak())
story.append(Paragraph('Contents', st['h2']))
toc = TableOfContents(); toc.levelStyles = [st['toc1'], st['toc2']]; toc.dotsMinLevel = 0
story.append(toc)

_core_cache = {}
def core_chapters(fname):
    if fname not in _core_cache:
        out = OrderedDict()
        for c in re.split(r'(?m)^(?=# )', read(fname)):
            if c.strip(): out[c.split('\n', 1)[0][2:].strip()] = c
        _core_cache[fname] = out
    return _core_cache[fname]

def add_section(file, section):
    """A '# Heading' chapter taken from a multi-chapter file."""
    chs = core_chapters(file)
    if section not in chs:
        sys.exit('Chapter "%s" not found in %s' % (section, file))
    story.extend(md_to_flow(chs[section]))

def add_file(fname, chapter, intro=None):
    """A whole file rendered as one chapter; its own headings are nested under `chapter`."""
    md = read(fname)
    md = re.sub(r'\A\s*# [^\n]*\n', '', md)  # drop the file's own title line
    lvls = [len(m.group(1)) for m in re.finditer(r'^(#{1,6})\s', md, re.M)]
    sh = 1 - (min(lvls) - 1) if lvls else 1
    story.append(NextPageTemplate('body')); story.append(PageBreak())
    story.append(heading(chapter, 0))
    if intro: story.append(Paragraph(inline(intro), st['body']))
    story.extend(md_to_flow(md, shift=sh))

for ch in META['chapters']:
    if 'section' in ch: add_section(ch['file'], ch['section'])
    else: add_file(ch['file'], ch['title'], ch.get('intro'))

# ---------------- Appendix A: API catalogue
routes = load_gen('routes.json')
story += [NextPageTemplate('body'), PageBreak(), heading('Appendix A - REST API Endpoint Catalogue', 0)]
story.append(Paragraph('This list is generated automatically from <font name="Mono">server.js</font> mount points and the router files. '
    '<b>Access</b> shows the guard on each route. <i>Module:action</i> is a check against the permissions table (create maps to write). '
    '"PDI roles" means only admin and production. "Any authenticated" means a valid JWT is enough. The only public route is login. '
    'Total endpoints: <b>%d</b>.' % len(routes), st['body']))
groups = OrderedDict()
for r in routes:
    seg = r['path'].split('/')[2] if len(r['path'].split('/')) > 2 else r['path']
    key = r['file'].split('/')[1] if r['file'].startswith('routes/') and '/' in r['file'][7:] else ('chatbot' if 'chatbot' in r['file'] else 'auth')
    groups.setdefault(key, []).append(r)
names = {'auth': 'Authentication', 'core': 'Core', 'sales': 'Sales', 'manufacturing': 'Manufacturing', 'invoicing': 'Invoicing',
         'dispatch': 'Dispatch', 'hr': 'HR', 'operations': 'Operations (incl. PDI)', 'service': 'Service & Repair', 'chatbot': 'Chatbot'}
for k, rs in groups.items():
    story.append(heading('A.%d %s (%d)' % (list(groups).index(k)+1, names.get(k, k), len(rs)), 1))
    rows = [['Method', 'Path', 'Access', 'Handler']] + [[r['method'], '`%s`' % r['path'], r['perm'], r['handler']] for r in rs]
    story.append(make_table(rows, widths=[0.09, 0.43, 0.28, 0.20], fs=7.6)); story.append(Spacer(1, 6))

# ---------------- Appendix B: permission matrix
sch = load_gen('schema.json')
roles = {r['role_id']: r['role_name'] for r in sch['roles']}
story += [NextPageTemplate('body'), PageBreak(), heading('Appendix B - Role Permission Matrix (live data)', 0)]
story.append(Paragraph('This matrix comes from the <font name="Mono">permissions</font> table in the production database. Codes: R = can_read, W = can_write (also used for create), D = can_delete. '
    'A blank cell means the role has no row for that module, so <font name="Mono">checkPermission</font> denies it (fail closed). PDI report routes do not use this table. They use the admin + production allow-list in <font name="Mono">middleware/pdiAccess.js</font>.', st['body']))
mods = sorted({p['module'] for p in sch['perms']}, key=str.lower)
rids = sorted(roles)
cell = defaultdict(str)
for p in sch['perms']:
    cell[(p['module'], p['role_id'])] = ''.join(c for c, f in (('R', p['can_read']), ('W', p['can_write']), ('D', p['can_delete'])) if f) or '-'
abbr = {1: 'Adm', 2: 'Cust', 3: 'Sal', 4: 'Des', 5: 'Prod', 6: 'Store', 7: 'Disp', 8: 'Acc', 9: 'Emp', 10: 'HR', 11: 'IA-E', 12: 'IA-HR', 13: 'S&R', 15: 'Rep'}
rows = [['Module'] + [abbr.get(r, str(r)) for r in rids]] + [[m] + [cell[(m, r)] for r in rids] for m in mods]
story.append(make_table(rows, widths=[0.23] + [0.77/len(rids)]*len(rids), fs=7))
story.append(Spacer(1, 6))
story.append(make_table([['Abbrev.', 'Role (role_id)']] + [[abbr.get(r, str(r)), '%s (%d)' % (roles[r], r)] for r in rids], widths=[0.2, 0.8]))

# ---------------- Appendix C: database schema
cols = defaultdict(list)
for c in sch['cols']: cols[c['table_name']].append(c)
pk = defaultdict(set); fk = {}; uq = defaultdict(set)
for c in sch['cons']:
    if c['constraint_type'] == 'PRIMARY KEY': pk[c['table_name']].add(c['column_name'])
    elif c['constraint_type'] == 'FOREIGN KEY' and c['ref_table']: fk[(c['table_name'], c['column_name'])] = '%s.%s' % (c['ref_table'], c['ref_col'])
    elif c['constraint_type'] == 'UNIQUE': uq[c['table_name']].add(c['column_name'])
cnt = {c['table_name']: c['approx_rows'] for c in sch['counts']}
idx = defaultdict(list)
for x in sch['idx']: idx[x['tablename']].append(x['indexname'])
story += [NextPageTemplate('body'), PageBreak(), heading('Appendix C - Database Schema Reference (live)', 0)]
story.append(Paragraph('This reference was generated from PostgreSQL <font name="Mono">information_schema</font> on the production database. It lists %d tables and %d columns. '
    'Key: PK = primary key, FK = foreign key (with the column it references), UQ = unique. Row counts are approximate (pg_stat live tuples). Defaults are shortened.' % (len(cols), len(sch['cols'])), st['body']))
summary = [['Table', 'Cols', '~Rows', 'Primary key']] + [[ '`%s`' % t, str(len(cols[t])), str(cnt.get(t, '')), ', '.join(sorted(pk[t])) ] for t in sorted(cols)]
story.append(heading('C.1 Table summary', 1))
story.append(make_table(summary, widths=[0.42, 0.1, 0.12, 0.36], fs=7.6))
story.append(heading('C.2 Table definitions', 1))
def short(t):
    return {'character varying': 'varchar', 'timestamp without time zone': 'timestamp', 'timestamp with time zone': 'timestamptz',
            'double precision': 'float8', 'USER-DEFINED': 'enum/user type'}.get(t, t)
for t in sorted(cols):
    rows = [['Column', 'Type', 'Null', 'Key', 'Default']]
    for c in cols[t]:
        keys = []
        if c['column_name'] in pk[t]: keys.append('PK')
        if (t, c['column_name']) in fk: keys.append('FK > ' + fk[(t, c['column_name'])])
        if c['column_name'] in uq[t]: keys.append('UQ')
        d = (c['column_default'] or '')
        d = re.sub(r"::[a-z ]+", '', d)[:38]
        rows.append([c['column_name'], short(c['data_type']), 'Y' if c['is_nullable'] == 'YES' else 'N', ', '.join(keys), d])
    hdr = Paragraph('<b>%s</b> <font color="#6b7280" size="8">- %d columns%s%s</font>' % (t, len(cols[t]),
          (', ~%s rows' % cnt[t]) if t in cnt else '', (', indexes: ' + ', '.join(idx[t])[:160]) if idx[t] else ''), st['h4'])
    story.append(KeepTogether([hdr, make_table(rows[:14], widths=[0.27, 0.16, 0.06, 0.25, 0.26], fs=7.2)]) if len(rows) <= 14
                 else KeepTogether([hdr, make_table(rows[:8], widths=[0.27, 0.16, 0.06, 0.25, 0.26], fs=7.2)]))
    if len(rows) > 8 and len(rows) > 14:
        story.append(make_table([rows[0]] + rows[8:], widths=[0.27, 0.16, 0.06, 0.25, 0.26], fs=7.2))
    story.append(Spacer(1, 5))

# ---------------- Appendix D: glossary
story += [NextPageTemplate('body'), PageBreak(), heading('Appendix D - Glossary', 0)]
story.append(make_table([['Term', 'Meaning'],
    ['PDI', 'Pre-Dispatch Inspection: the quality inspection report filled in before a product ships'],
    ['Lot / batch', 'A group of PDI reports for several units that share header fields and are finalized together into one combined PDF'],
    ['AutoNXT', 'A customer product family with dedicated PDI templates (motor and controller), tolerance rules and batch forms'],
    ['IPT kit', 'An assembled kit tracked by serial number through the ipt_kits module and its serial sequence'],
    ['BOM', 'Bill of Materials: the raw materials and quantities needed to build a product'],
    ['Work order', 'A production instruction raised against a sales order; it tracks components, processes, stages and testing'],
    ['Proforma', 'A proforma invoice: a pre-sale commercial document generated as a PDF'],
    ['Delivery challan', 'The document that goes with goods being dispatched'],
    ['IA', 'Intute AI: the second company sharing the platform, with its own roles and modules'],
    ['Compage', 'The manufacturing company: the 9 ERP roles plus hr and employee'],
    ['RBAC', 'Role-Based Access Control, enforced by the permissions table and role allow-lists'],
    ['Hold', 'A reservation of inventory quantity against a purpose, which reduces available stock until it is released']], widths=[0.2, 0.8]))

doc = Doc(OUT)
doc.multiBuild(story)
print('OK', OUT)
