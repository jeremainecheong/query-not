/**
 * Diagrams for the operation reference.
 *
 * One consistent visual language across every operation, so the diagrams can be
 * compared rather than each read from scratch:
 *
 *   pale bar        a row that exists but was not needed
 *   accent bar      a row that was read or produced
 *   red bar         work done and then thrown away
 *   ordered ticks   an index — sorted, narrow, separate from the table
 *   arrow           rows moving
 *
 * The point of showing Seq Scan beside Index Scan is that the *difference* is
 * visible: one lights up every bar in the table, the other lights up two. That
 * only works if both use the same grammar.
 */

const W = 232;
const H = 116;

const ROW_H = 8;
const ROW_GAP = 4;

type Fill = 'idle' | 'read' | 'waste' | 'out';

const FILLS: Record<Fill, string> = {
  idle: 'var(--hairline-strong)',
  read: 'var(--accent)',
  waste: 'var(--status-critical)',
  out: 'var(--status-good)',
};

/** A stack of rows, optionally labelled — stands for a table or a stream. */
function Stack({
  x,
  y,
  rows,
  width = 54,
  label,
}: {
  x: number;
  y: number;
  rows: Fill[];
  width?: number;
  label?: string;
}) {
  return (
    <g>
      {label && (
        <text x={x} y={y - 6} className="diag__label">
          {label}
        </text>
      )}
      {rows.map((fill, i) => (
        <rect
          key={i}
          x={x}
          y={y + i * (ROW_H + ROW_GAP)}
          width={width}
          height={ROW_H}
          rx={2}
          fill={FILLS[fill]}
          opacity={fill === 'idle' ? 0.55 : 1}
        />
      ))}
    </g>
  );
}

/** Narrow ordered ticks — an index. */
function Index({ x, y, marks, count = 7, label }: { x: number; y: number; marks: number[]; count?: number; label?: string }) {
  return (
    <g>
      {label && (
        <text x={x} y={y - 6} className="diag__label">
          {label}
        </text>
      )}
      <rect x={x - 3} y={y - 3} width={20} height={count * (ROW_H + ROW_GAP) - ROW_GAP + 6} rx={4}
            fill="none" stroke="var(--hairline-strong)" strokeWidth="1" />
      {Array.from({ length: count }, (_, i) => (
        <rect
          key={i}
          x={x}
          y={y + i * (ROW_H + ROW_GAP)}
          width={14}
          height={ROW_H}
          rx={2}
          fill={marks.includes(i) ? 'var(--accent)' : 'var(--hairline-strong)'}
          opacity={marks.includes(i) ? 1 : 0.55}
        />
      ))}
    </g>
  );
}

function Arrow({ x1, y1, x2, y2, dashed = false }: { x1: number; y1: number; x2: number; y2: number; dashed?: boolean }) {
  return (
    <g>
      <line
        x1={x1} y1={y1} x2={x2 - 5} y2={y2}
        stroke="var(--ink-muted)" strokeWidth="1.5"
        strokeDasharray={dashed ? '3 3' : undefined}
      />
      <path d={`M ${x2} ${y2} L ${x2 - 6} ${y2 - 3.5} L ${x2 - 6} ${y2 + 3.5} Z`} fill="var(--ink-muted)" />
    </g>
  );
}

function Caption({ children }: { children: string }) {
  return (
    <text x={W / 2} y={H - 5} textAnchor="middle" className="diag__caption">
      {children}
    </text>
  );
}

function Frame({ children, label }: { children: React.ReactNode; label: string }) {
  return (
    <svg className="diag" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label}>
      {children}
    </svg>
  );
}

const R = (n: number, f: Fill): Fill[] => Array.from({ length: n }, () => f);

/** Diagram per node type. Anything without one falls back to a generic flow. */
const DIAGRAMS: Record<string, () => React.ReactElement> = {
  'Seq Scan': () => (
    <Frame label="Every row in the table is read; most are discarded by the filter, one is kept.">
      <Stack x={20} y={22} rows={['waste', 'waste', 'read', 'waste', 'waste', 'waste']} label="table" />
      <Arrow x1={82} y1={46} x2={128} y2={46} />
      <Stack x={140} y={40} rows={['read']} width={40} label="kept" />
      <Caption>Reads all rows. Filter discards the rest.</Caption>
    </Frame>
  ),

  'Index Scan': () => (
    <Frame label="The index locates two matching rows; only those two are fetched from the table.">
      <Index x={22} y={22} marks={[1, 4]} label="index" />
      <Arrow x1={44} y1={36} x2={86} y2={36} />
      <Arrow x1={44} y1={72} x2={86} y2={72} />
      <Stack x={94} y={22} rows={['idle', 'read', 'idle', 'idle', 'read', 'idle']} label="table" />
      <Arrow x1={152} y1={46} x2={186} y2={46} />
      <Stack x={196} y={40} rows={['read']} width={22} />
      <Caption>Only matching rows are fetched.</Caption>
    </Frame>
  ),

  'Index Only Scan': () => (
    <Frame label="The index alone answers the query; the table is never touched.">
      <Index x={22} y={22} marks={[1, 4]} label="index" />
      <Arrow x1={44} y1={46} x2={104} y2={46} />
      <Stack x={112} y={40} rows={['read']} width={40} label="answer" />
      <g opacity={0.35}>
        <Stack x={168} y={22} rows={R(6, 'idle')} width={44} label="table" />
        <line x1={168} y1={22} x2={212} y2={88} stroke="var(--ink-muted)" strokeWidth="1.5" strokeDasharray="3 3" />
      </g>
      <Caption>The table is never read.</Caption>
    </Frame>
  ),

  'Bitmap Heap Scan': () => (
    <Frame label="The index builds a bitmap of matching pages, then the table is read in physical order.">
      <Index x={18} y={26} marks={[0, 3, 5]} count={6} label="index" />
      <Arrow x1={40} y1={50} x2={68} y2={50} />
      <g>
        <text x={78} y={20} className="diag__label">bitmap</text>
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <rect key={i} x={78 + (i % 3) * 16} y={26 + Math.floor(i / 3) * 16} width={12} height={12} rx={2}
                fill={[0, 3, 5].includes(i) ? 'var(--accent)' : 'var(--hairline-strong)'}
                opacity={[0, 3, 5].includes(i) ? 1 : 0.55} />
        ))}
      </g>
      <Arrow x1={128} y1={44} x2={152} y2={44} />
      <Stack x={162} y={26} rows={['read', 'idle', 'idle', 'read', 'idle', 'read']} width={44} label="table" />
      <Caption>Reads pages in order, not row by row.</Caption>
    </Frame>
  ),

  'Nested Loop': () => (
    <Frame label="For each of three outer rows, the inner side is scanned again.">
      <Stack x={18} y={26} rows={R(3, 'read')} width={40} label="outer" />
      {[0, 1, 2].map((i) => (
        <Arrow key={i} x1={62} y1={30 + i * 12} x2={104} y2={30 + i * 12} />
      ))}
      {[0, 1, 2].map((i) => (
        <g key={i} transform={`translate(${108 + i * 6}, ${22 + i * 6})`} opacity={1 - i * 0.22}>
          <rect width={46} height={44} rx={4} fill="var(--surface)" stroke="var(--hairline-strong)" />
          <text x={6} y={16} className="diag__label">inner</text>
          <rect x={6} y={22} width={34} height={6} rx={2} fill="var(--accent)" />
          <rect x={6} y={32} width={34} height={6} rx={2} fill="var(--hairline-strong)" opacity={0.55} />
        </g>
      ))}
      <Caption>Inner side re-scanned once per outer row.</Caption>
    </Frame>
  ),

  'Hash Join': () => (
    <Frame label="One side is built into a hash table, then the other side probes it.">
      <Stack x={16} y={24} rows={R(4, 'read')} width={36} label="build" />
      <Arrow x1={56} y1={42} x2={82} y2={42} />
      <g>
        <text x={90} y={18} className="diag__label">hash table</text>
        {[0, 1, 2, 3].map((i) => (
          <rect key={i} x={90} y={24 + i * 14} width={44} height={10} rx={2}
                fill="var(--accent)" opacity={0.35 + i * 0.16} />
        ))}
      </g>
      <Arrow x1={186} y1={50} x2={140} y2={50} />
      <Stack x={190} y={30} rows={R(3, 'out')} width={30} label="probe" />
      <Caption>Build once, then probe in constant time.</Caption>
    </Frame>
  ),

  'Merge Join': () => (
    <Frame label="Two already-sorted inputs are walked in step and matched as they go.">
      <Stack x={26} y={24} rows={['read', 'read', 'read', 'read']} width={40} label="sorted A" />
      <Stack x={166} y={24} rows={['read', 'read', 'read', 'read']} width={40} label="sorted B" />
      {[0, 1, 2, 3].map((i) => (
        <line key={i} x1={68} y1={28 + i * 12} x2={164} y2={28 + i * 12}
              stroke="var(--ink-muted)" strokeWidth="1.2" strokeDasharray="2 3" />
      ))}
      <Caption>Zips two ordered streams together.</Caption>
    </Frame>
  ),

  Sort: () => (
    <Frame label="Unordered rows in, ordered rows out.">
      <g>
        <text x={20} y={20} className="diag__label">in</text>
        {[34, 18, 46, 26, 40].map((w, i) => (
          <rect key={i} x={20} y={26 + i * 12} width={w} height={8} rx={2} fill="var(--hairline-strong)" />
        ))}
      </g>
      <Arrow x1={80} y1={54} x2={128} y2={54} />
      <g>
        <text x={140} y={20} className="diag__label">out</text>
        {[18, 26, 34, 40, 46].map((w, i) => (
          <rect key={i} x={140} y={26 + i * 12} width={w} height={8} rx={2} fill="var(--accent)" />
        ))}
      </g>
      <Caption>Spills to disk if it exceeds work_mem.</Caption>
    </Frame>
  ),

  HashAggregate: () => (
    <Frame label="Many rows are grouped into a hash table keyed on the grouping columns, producing few rows.">
      <Stack x={16} y={22} rows={R(6, 'read')} width={34} label="rows" />
      <Arrow x1={54} y1={46} x2={84} y2={46} />
      <g>
        <text x={92} y={18} className="diag__label">groups</text>
        {[0, 1, 2].map((i) => (
          <rect key={i} x={92} y={26 + i * 18} width={46} height={13} rx={3}
                fill="var(--accent)" opacity={0.4 + i * 0.2} />
        ))}
      </g>
      <Arrow x1={144} y1={46} x2={172} y2={46} />
      <Stack x={182} y={34} rows={R(3, 'out')} width={30} />
      <Caption>Groups without needing sorted input.</Caption>
    </Frame>
  ),

  GroupAggregate: () => (
    <Frame label="Sorted rows arrive in runs; each group is emitted as it ends.">
      <g>
        <text x={20} y={20} className="diag__label">sorted in</text>
        {[0, 0, 1, 1, 1, 2].map((g, i) => (
          <rect key={i} x={20} y={26 + i * 11} width={44} height={7} rx={2}
                fill="var(--accent)" opacity={0.35 + g * 0.3} />
        ))}
      </g>
      <Arrow x1={72} y1={54} x2={124} y2={54} />
      <g>
        {[0, 1, 2].map((g) => (
          <rect key={g} x={136} y={30 + g * 18} width={44} height={12} rx={3}
                fill="var(--status-good)" opacity={0.4 + g * 0.25} />
        ))}
      </g>
      <Caption>Nearly free when input is already sorted.</Caption>
    </Frame>
  ),

  Limit: () => (
    <Frame label="Rows stream through until the limit is reached, then production stops.">
      <Stack x={20} y={22} rows={['read', 'read', 'idle', 'idle', 'idle', 'idle']} width={60} label="stream" />
      <line x1={14} y1={49} x2={92} y2={49} stroke="var(--status-critical)" strokeWidth="1.5" strokeDasharray="4 3" />
      <text x={96} y={52} className="diag__label">stop</text>
      <Arrow x1={128} y1={40} x2={162} y2={40} />
      <Stack x={172} y={28} rows={R(2, 'out')} width={34} label="out" />
      <Caption>Can stop the nodes beneath it early.</Caption>
    </Frame>
  ),

  Gather: () => (
    <Frame label="Work splits across parallel workers, then merges back into one stream.">
      <Stack x={16} y={40} rows={R(2, 'read')} width={30} label="scan" />
      {[0, 1, 2].map((i) => (
        <g key={i}>
          <Arrow x1={50} y1={48} x2={92} y2={26 + i * 24} />
          <rect x={96} y={20 + i * 24} width={44} height={13} rx={3} fill="var(--accent)" opacity={0.8} />
          <text x={100} y={30 + i * 24} className="diag__label">worker</text>
          <Arrow x1={144} y1={26 + i * 24} x2={182} y2={48} />
        </g>
      ))}
      <Stack x={190} y={42} rows={R(2, 'out')} width={26} />
      <Caption>Total work exceeds elapsed time.</Caption>
    </Frame>
  ),

  Memoize: () => (
    <Frame label="Repeated lookups with the same key are answered from a cache instead of re-running.">
      <Stack x={16} y={26} rows={['read', 'read', 'read']} width={34} label="lookups" />
      {[0, 1, 2].map((i) => (
        <Arrow key={i} x1={54} y1={30 + i * 12} x2={92} y2={30 + i * 12} dashed={i > 0} />
      ))}
      <g>
        <rect x={96} y={22} width={52} height={44} rx={5} fill="var(--surface)" stroke="var(--accent)" strokeWidth="1.5" />
        <text x={104} y={40} className="diag__label">cache</text>
        <text x={104} y={56} className="diag__label">hit ×2</text>
      </g>
      <Arrow x1={152} y1={44} x2={182} y2={44} />
      <Stack x={192} y={38} rows={['out']} width={24} />
      <Caption>Only pays off when keys repeat.</Caption>
    </Frame>
  ),

  Aggregate: () => (
    <Frame label="Many rows are reduced to a single summary row.">
      <Stack x={30} y={24} rows={R(6, 'read')} width={44} label="rows" />
      <Arrow x1={80} y1={52} x2={136} y2={52} />
      <Stack x={148} y={46} rows={['out']} width={44} label="summary" />
      <Caption>Reduces everything to one row.</Caption>
    </Frame>
  ),

  'CTE Scan': () => (
    <Frame label="A WITH clause is computed once into a stored result, which is then read.">
      <Stack x={16} y={26} rows={R(4, 'read')} width={34} label="WITH body" />
      <Arrow x1={54} y1={48} x2={80} y2={48} />
      <g>
        <rect x={86} y={26} width={58} height={46} rx={5} fill="var(--surface)"
              stroke="var(--accent)" strokeWidth="1.5" strokeDasharray="4 3" />
        <text x={94} y={44} className="diag__label">materialised</text>
        <text x={94} y={60} className="diag__label">once</text>
      </g>
      <Arrow x1={148} y1={48} x2={178} y2={48} />
      <Stack x={188} y={36} rows={R(2, 'out')} width={28} />
      <Caption>An optimisation fence: predicates cannot cross it.</Caption>
    </Frame>
  ),

  Append: () => (
    <Frame label="Several inputs are concatenated into a single stream.">
      <Stack x={18} y={20} rows={R(2, 'read')} width={38} label="A" />
      <Stack x={18} y={62} rows={R(2, 'read')} width={38} label="B" />
      <Arrow x1={60} y1={28} x2={112} y2={44} />
      <Arrow x1={60} y1={70} x2={112} y2={52} />
      <Stack x={124} y={30} rows={R(4, 'out')} width={44} label="combined" />
      <Caption>UNION ALL, and partition scans.</Caption>
    </Frame>
  ),
};

/** Aliases — these share a mechanism with an operation already drawn. */
const ALIASES: Record<string, string> = {
  'Bitmap Index Scan': 'Bitmap Heap Scan',
  Hash: 'Hash Join',
  Unique: 'GroupAggregate',
  'Gather Merge': 'Gather',
  Materialize: 'Memoize',
  'Subquery Scan': 'CTE Scan',
};

export function ScanDiagram({ nodeType }: { nodeType: string }) {
  const key = DIAGRAMS[nodeType] ? nodeType : ALIASES[nodeType];
  const draw = key ? DIAGRAMS[key] : undefined;

  if (!draw) {
    return (
      <Frame label={`${nodeType} passes rows from its input to its output.`}>
        <Stack x={30} y={34} rows={R(3, 'read')} width={48} label="in" />
        <Arrow x1={84} y1={50} x2={140} y2={50} />
        <Stack x={150} y={34} rows={R(3, 'out')} width={48} label="out" />
        <Caption>Moves rows through the plan.</Caption>
      </Frame>
    );
  }

  return draw();
}

/** True when the diagram shown is borrowed from a related operation. */
export function isAliasedDiagram(nodeType: string): string | null {
  return DIAGRAMS[nodeType] ? null : (ALIASES[nodeType] ?? null);
}
