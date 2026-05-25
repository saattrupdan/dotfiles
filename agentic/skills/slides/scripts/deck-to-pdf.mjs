// Converts an HTML slide deck into a stepped PDF, one page per reveal state.
//
// Targets decks built with the noskillish/slides framework convention:
//   - <section class="slide">          one per slide
//   - .slide.active                    the currently-shown slide
//   - [data-reveal]                    elements that start hidden
//   - [data-reveal].revealed           elements that have been advanced past
//
// A slide with N reveal elements becomes N+1 PDF pages, matching the live
// keypress sequence.
//
// Usage:
//   node ~/.claude/skills/slides/scripts/deck-to-pdf.mjs <input.html> [output.pdf]
//
// Output defaults to a file alongside the input:
//   - <input-dir>/<parent-dir>.pdf if input is .../<dir>/index.html (or deck.html)
//   - <input-dir>/<basename>.pdf otherwise
//
// Dependencies:
//   - playwright + chromium  (auto-installed into this script's folder if missing)
//   - qpdf, mutool           (auto-installed via brew/apt with confirmation; on
//                             other platforms the script prints instructions)
import { pathToFileURL, fileURLToPath } from 'node:url';
import { resolve, join, basename, extname, dirname } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';

const [, , inputArg, outputArg] = process.argv;
if (!inputArg) {
  console.error('Usage: node deck-to-pdf.mjs <input.html> [output.pdf]');
  process.exit(1);
}

const scriptDir = dirname(fileURLToPath(import.meta.url));

function hasCmd(bin) {
  const probe = process.platform === 'win32' ? ['where', [bin]] : ['command', ['-v', bin], { shell: true }];
  return spawnSync(...probe).status === 0;
}

async function prompt(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question(question)).trim().toLowerCase();
  rl.close();
  return answer === '' || answer === 'y' || answer === 'yes';
}

// Per-platform installer recipes for qpdf and mutool.
const installers = {
  darwin: {
    available: () => hasCmd('brew'),
    label: 'Homebrew',
    cmd: (pkg) => ({ bin: 'brew', args: ['install', pkg] }),
    pkgs: { qpdf: 'qpdf', mutool: 'mupdf-tools' },
    hint: 'Install Homebrew from https://brew.sh first.',
  },
  linux: {
    // Targets Debian/Ubuntu. Other distros (Arch, Fedora) need manual install.
    available: () => hasCmd('apt-get'),
    label: 'apt',
    cmd: (pkg) => ({ bin: 'sudo', args: ['apt-get', 'install', '-y', pkg] }),
    pkgs: { qpdf: 'qpdf', mutool: 'mupdf-tools' },
    hint: 'On non-Debian distros, install qpdf and mupdf-tools via your package manager.',
  },
};

async function ensureTool(bin) {
  if (hasCmd(bin)) return;

  const installer = installers[process.platform];
  if (!installer || !installer.available()) {
    console.error(`Missing required tool: ${bin}.`);
    if (process.platform === 'win32') {
      console.error('Install qpdf (https://qpdf.sourceforge.io/) and mupdf-tools (https://mupdf.com/releases) and ensure they are on PATH.');
    } else if (installer) {
      console.error(installer.hint);
    } else {
      console.error('Install qpdf and mupdf-tools via your system package manager and retry.');
    }
    process.exit(1);
  }

  const pkg = installer.pkgs[bin];
  const { bin: cmdBin, args } = installer.cmd(pkg);
  const display = [cmdBin, ...args].join(' ');

  const ok = await prompt(`Missing '${bin}'. Install via ${installer.label}: '${display}'? [Y/n] `);
  if (!ok) {
    console.error(`Aborted. Install ${pkg} manually and retry.`);
    process.exit(1);
  }

  const r = spawnSync(cmdBin, args, { stdio: 'inherit' });
  if (r.status !== 0) {
    console.error(`${display} failed.`);
    process.exit(1);
  }
}

// Resolve playwright from the script's own node_modules; install on demand
// so this script is self-contained regardless of the cwd it's invoked from.
async function ensurePlaywright() {
  try {
    return await import('playwright');
  } catch {
    if (!hasCmd('npm')) {
      console.error('Playwright not installed and npm is not on PATH. Install Node.js (https://nodejs.org) and retry.');
      process.exit(1);
    }
    const ok = await prompt(`Playwright is not installed in ${scriptDir}. Install it now (~300 MB incl. Chromium)? [Y/n] `);
    if (!ok) {
      console.error('Aborted. Install playwright into the script folder and retry.');
      process.exit(1);
    }
    if (!existsSync(join(scriptDir, 'package.json'))) {
      execFileSync('npm', ['init', '-y'], { cwd: scriptDir, stdio: 'inherit' });
    }
    execFileSync('npm', ['install', 'playwright'], { cwd: scriptDir, stdio: 'inherit' });
    execFileSync('npx', ['playwright', 'install', 'chromium'], { cwd: scriptDir, stdio: 'inherit' });
    return await import('playwright');
  }
}

await ensureTool('qpdf');
await ensureTool('mutool');
const { chromium } = await ensurePlaywright();

const input = resolve(inputArg);
const stem = basename(input, extname(input));
// For .../<dir>/index.html or .../<dir>/deck.html, name the PDF after the
// parent directory; otherwise use the input's basename.
const useParent = stem === 'index' || stem === 'deck';
const defaultName = (useParent ? basename(dirname(input)) : stem) + '.pdf';
const output = outputArg ? resolve(outputArg) : join(dirname(input), defaultName);

const PAGE_W = '13.333in';
const PAGE_H = '7.5in';

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(pathToFileURL(input).href, { waitUntil: 'networkidle' });
await page.emulateMedia({ media: 'print' });

await page.addStyleTag({ content: `
  @media print {
    .nav, #progress, .deck-toast { display: none !important; }
    /* Shadows render as muddy grey blocks in PDF — strip them. */
    *, *::before, *::after {
      box-shadow: none !important;
      text-shadow: none !important;
      filter: none !important;
    }
  }
`});

const slideCount = await page.evaluate(() => document.querySelectorAll('.slide').length);
if (slideCount === 0) {
  console.error(`No .slide elements found in ${input}`);
  await browser.close();
  process.exit(1);
}

const tmp = await mkdtemp(join(tmpdir(), 'deck-'));
const pageFiles = [];

for (let i = 0; i < slideCount; i++) {
  // Activate slide i, force-hide siblings with inline !important style so we
  // bypass any existing @media print rules that show every .slide.
  await page.evaluate((idx) => {
    const slides = document.querySelectorAll('.slide');
    slides.forEach((s, j) => {
      if (j === idx) {
        s.classList.add('active');
        s.style.setProperty('display', 'flex', 'important');
      } else {
        s.classList.remove('active');
        s.style.setProperty('display', 'none', 'important');
      }
    });
    slides[idx].querySelectorAll('[data-reveal]').forEach(el => el.classList.remove('revealed'));
  }, i);

  const reveals = await page.evaluate((idx) =>
    document.querySelectorAll('.slide')[idx].querySelectorAll('[data-reveal]').length, i);

  for (let step = 0; step <= reveals; step++) {
    if (step > 0) {
      await page.evaluate((idx) => {
        const next = document.querySelectorAll('.slide')[idx]
          .querySelector('[data-reveal]:not(.revealed)');
        if (next) next.classList.add('revealed');
      }, i);
    }
    await page.waitForTimeout(80);
    const out = join(tmp, `slide-${String(i).padStart(3, '0')}-${String(step).padStart(2, '0')}.pdf`);
    await page.pdf({ path: out, width: PAGE_W, height: PAGE_H, printBackground: true, pageRanges: '1' });
    pageFiles.push(out);
    process.stdout.write(`\rslide ${i + 1}/${slideCount} step ${step}/${reveals}   `);
  }
}

await browser.close();
process.stdout.write('\n');

const merged = join(tmp, 'merged.pdf');
const cleaned = join(tmp, 'cleaned.pdf');
execFileSync('qpdf', ['--empty', '--pages', ...pageFiles, '--', merged]);
// Lossless: mutool dedupes objects + recompresses streams; qpdf linearizes
// so viewers can show page 1 before the whole file loads.
execFileSync('mutool', ['clean', '-gggg', '-z', '-d', merged, cleaned]);
execFileSync('qpdf', ['--linearize', cleaned, output]);
await rm(tmp, { recursive: true, force: true });

console.log(`Wrote ${output} (${pageFiles.length} pages)`);
