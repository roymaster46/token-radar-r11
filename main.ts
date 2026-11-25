// Token Radar, radar-11 — the entrypoint. Reads the sealed snapshot, scores every
// pre-token protocol with the model in lib/model.ts, writes the ranked board to
// board.json as a bare array, writes data.js for the dashboard, copies the
// dashboard and the screenshots into the output, and writes dossier.json last.
//
//   MAKEFUN_OUTPUT_DIR=out node main.ts --input <snapshot.json|directory>
//
// The board is ranked by implied value, strongest first; nothing here re-sorts
// it. The output is deterministic: run it twice and the dossier bytes match.

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MODEL, boardIssue, buildRadar, dataScript, fitPowerLaw, fittedValue, isPreToken, isProduct, isRankable, parseSnapshot, tradedComps } from './lib/model.ts';
import { buildDossier } from './vendor/makefun-board.ts';

const here = fileURLToPath(new URL('.', import.meta.url));

/** The scorer's own caps (reference/gate.json): the text cap shapes the bytes, the rest refuse. */
const TEXT_MAX_BYTES = 65_536;
const SCREENSHOT_CAPS = { max: 4, max_bytes: 524_288 };
const IMAGE_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

/** --name <value> out of the arguments, or the fallback. */
function arg(name: string, fallback: string): string {
  const at = process.argv.indexOf(`--${name}`);
  if (at >= 0 && at + 1 < process.argv.length) return process.argv[at + 1]!;
  const withEquals = process.argv.find((a) => a.startsWith(`--${name}=`));
  return withEquals === undefined ? fallback : withEquals.slice(name.length + 3);
}

const inputArg = arg('input', '/input');
const inputFile = inputArg.endsWith('.json') ? inputArg : join(inputArg, 'snapshot.json');
if (!existsSync(inputFile)) {
  process.stderr.write(`token radar: no snapshot at ${inputFile}: pass --input <snapshot.json|directory> or mount the sealed /input\n`);
  process.exit(2);
}
const out = arg('output', process.env.MAKEFUN_OUTPUT_DIR ?? '/output');

const snapshot = parseSnapshot(readFileSync(inputFile, 'utf8'));
const { board, radar } = buildRadar(snapshot);
const issue = boardIssue(board, snapshot);
if (issue !== null) {
  process.stderr.write(`token radar: the model wrote a board the gate refuses: ${issue}\n`);
  process.exit(1);
}

/** DefiLlama's version-marker rule, replicated here (model.ts keeps it private):
 *  a name ending in a release is a pool of another protocol. */
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/** The coverage ledger: every protocol in the snapshot in exactly one of ten
 *  groups, summing to the snapshot's protocol count. The ranked board splits
 *  three ways (watchlist / off-list above the floor / early below the floor) and
 *  the other seven groups match the model's coverage buckets one to one, so the
 *  ledger cross-checks the board against the snapshot. */
function buildLedger(): Array<{ label: string; count: number }> {
  const watchlist = new Set(snapshot.watchlist);
  const rankedWatchlist = board.filter((r) => watchlist.has(r.slug)).length;
  const rankedAbove = board.filter((r) => !watchlist.has(r.slug) && r.tvl_usd >= snapshot.floor_usd).length;
  const rankedBelow = board.filter((r) => !watchlist.has(r.slug) && r.tvl_usd < snapshot.floor_usd).length;
  const trades = snapshot.protocols.filter((p) => !isPreToken(p) && p.mcap_usd !== null && p.mcap_usd > 0).length;
  const onRecord = snapshot.protocols.filter((p) => !isPreToken(p) && !(p.mcap_usd !== null && p.mcap_usd > 0)).length;
  const bridge = snapshot.protocols.filter((p) => isPreToken(p) && (p.category === 'Bridge' || p.category === 'Canonical Bridge')).length;
  const liquid = snapshot.protocols.filter(
    (p) => isPreToken(p) && (p.category === 'Liquid Staking' || p.category === 'Liquid Restaking' || p.category === 'Restaked BTC'),
  ).length;
  const exchange = snapshot.protocols.filter((p) => isPreToken(p) && p.category === 'CEX').length;
  const versioned = snapshot.protocols.filter((p) => isPreToken(p) && VERSIONED.test(p.name) && !isProduct(p)).length;
  const wrapped = snapshot.protocols.filter(
    (p) =>
      isPreToken(p) &&
      isProduct(p) &&
      p.category !== 'Bridge' &&
      p.category !== 'Canonical Bridge' &&
      p.category !== 'Liquid Staking' &&
      p.category !== 'Liquid Restaking' &&
      p.category !== 'Restaked BTC' &&
      p.category !== 'CEX',
  ).length;
  return [
    { label: 'Ranked watchlist', count: rankedWatchlist },
    { label: 'Ranked off-list above floor', count: rankedAbove },
    { label: 'Ranked early below floor', count: rankedBelow },
    { label: 'Token trades', count: trades },
    { label: 'Token recorded, no usable cap', count: onRecord },
    { label: 'Out: bridge', count: bridge },
    { label: 'Out: liquid staking', count: liquid },
    { label: 'Out: exchange', count: exchange },
    { label: 'Out: versioned', count: versioned },
    { label: 'Out: wrapped', count: wrapped },
  ];
}

/** The walk-forward hold of the P25–P75 band: the same older-half / newer-half
 *  split as walkForwardScore, the final predictor fitted on the older half
 *  pricing the newer half, and the share of the newer half's log residuals that
 *  land inside the leave-one-out band quartiles. The band is a leave-one-out
 *  statement, so this number is the honest walk-forward check on it. */
function walkForwardBandHold(): number {
  const comps = tradedComps(snapshot);
  const dated = comps.filter((p) => p.listed_at !== null).sort((a, b) => (a.listed_at! < b.listed_at! ? -1 : 1));
  const cut = dated[Math.floor(dated.length / 2)]!.listed_at!;
  const older = dated.filter((p) => p.listed_at! < cut);
  const newer = dated.filter((p) => p.listed_at! >= cut);
  const fit = fitPowerLaw(older);
  const q25 = radar.validation.band_q25;
  const q75 = radar.validation.band_q75;
  let inside = 0;
  let n = 0;
  for (const test of newer) {
    const pred = fittedValue(test, snapshot.as_of, fit, MODEL, older);
    if (pred > 0 && Number.isFinite(pred)) {
      n++;
      const residual = Math.log10(test.mcap_usd! / pred);
      if (residual >= q25 && residual <= q75) inside++;
    }
  }
  return n === 0 ? 0 : inside / n;
}

const ledger = buildLedger();
const ledgerTotal = ledger.reduce((s, g) => s + g.count, 0);
if (ledgerTotal !== snapshot.protocols.length) {
  process.stderr.write(`token radar: ledger sums to ${ledgerTotal}, not the snapshot's ${snapshot.protocols.length} protocols\n`);
  process.exit(1);
}
const wfBandHold = walkForwardBandHold();
(radar as any).ledger = ledger;
(radar.validation as any).wf_band_p2575 = wfBandHold;

mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'board.json'), `${JSON.stringify(board, null, 2)}\n`);
writeFileSync(join(out, 'data.js'), dataScript(radar));

/** Copy one directory's regular files into `to`, skipping names that start with a dot. */
function copyFiles(from: string, to: string): string[] {
  if (!existsSync(from)) return [];
  mkdirSync(to, { recursive: true });
  const copied: string[] = [];
  for (const name of readdirSync(from)) {
    if (name.startsWith('.')) continue;
    const path = join(from, name);
    if (!statSync(path).isFile()) continue;
    copyFileSync(path, join(to, name));
    copied.push(name);
  }
  return copied;
}

copyFiles(join(here, 'dashboard'), join(out, 'dashboard'));
const shots = copyFiles(join(here, 'screenshots'), join(out, 'screenshots'));
if (shots.length < 3) {
  process.stderr.write(`token radar: screenshots/ holds ${shots.length} image${shots.length === 1 ? '' : 's'}: hand in 3, the board, a detail view and a filtered view\n`);
  process.exit(1);
}
for (const name of shots) {
  if (!IMAGE_NAME.test(name)) {
    process.stderr.write(`token radar: screenshots/${name}: a name is letters, digits and . _ -, 1 to 128 characters\n`);
    process.exit(1);
  }
}

// The dossier is written last: the scorer rebuilds it from this /output and compares bytes.
writeFileSync(join(out, 'dossier.json'), buildDossier(out, { text_max_bytes: TEXT_MAX_BYTES, screenshots: SCREENSHOT_CAPS, dashboard: { max_files: 400, max_bytes: 4_194_304 } }));

process.stdout.write(
  `token radar: ${snapshot.protocols.length} protocols, ${snapshot.watchlist.length} on the watchlist, ${board.length} rows scored (${radar.early_size} early, ${radar.live_size} live set aside)\n` +
    `token radar: wrote ${join(out, 'board.json')}, ${join(out, 'data.js')}, ${join(out, 'dashboard')} (3 files), ${join(out, 'screenshots')} (${shots.length} images) and ${join(out, 'dossier.json')}\n`,
);
