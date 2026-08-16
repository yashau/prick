import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import {
  MAX_LINES,
  collectSourceFiles,
  countLines,
  findViolations,
  formatReport,
  isGenerated,
  isSource,
  main,
} from './check-loc.mjs';

let root;

/** @param {string} rel @param {string} contents */
function write(rel, contents) {
  const full = join(root, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, contents, 'utf8');
}

/** @param {number} n */
const lines = (n) => `${Array.from({ length: n }, (_, i) => `line ${String(i)}`).join('\n')}\n`;

before(() => {
  root = mkdtempSync(join(tmpdir(), 'prick-loc-'));
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('counting', () => {
  it('does not count a trailing newline as an extra line', () => {
    assert.equal(countLines('a\nb\n'), 2);
    assert.equal(countLines('a\nb'), 2);
  });

  it('treats an empty file as zero, not one', () => {
    assert.equal(countLines(''), 0);
  });

  it('counts a single unterminated line', () => {
    assert.equal(countLines('a'), 1);
  });

  it('does not miscount CRLF as two lines', () => {
    // .gitattributes forces LF, but a file arriving with CRLF must not read as
    // double length -- that would fire the gate for the wrong reason.
    assert.equal(countLines('a\r\nb\r\n'), 2);
  });
});

describe('what counts as source', () => {
  it('includes every language in the repo', () => {
    for (const p of ['a.rs', 'a.ts', 'a.tsx', 'a.svelte', 'a.mjs', 'a.cjs', 'a.js']) {
      assert.equal(isSource(p), true, p);
    }
  });

  it('excludes prose, config and data', () => {
    for (const p of ['a.md', 'a.toml', 'a.json', 'a.yaml', 'a.sql', 'a.lock']) {
      assert.equal(isSource(p), false, p);
    }
  });
});

describe('generated files', () => {
  it('exempts the wrangler type file exactly, not by prefix', () => {
    assert.equal(isGenerated('packages/app/worker-configuration.d.ts'), true);
    assert.equal(isGenerated('packages/app/worker-configuration.d.ts.bak'), false);
  });

  it('exempts the registry component directory by prefix', () => {
    assert.equal(isGenerated('packages/app/src/lib/components/ui/button/button.svelte'), true);
  });

  it('does NOT exempt hand-written components next to it', () => {
    // The exemption is for tool output. A hand-written component that happens to
    // live nearby is still ours to keep short.
    assert.equal(isGenerated('packages/app/src/lib/components/secrets/table.svelte'), false);
  });
});

describe('walking', () => {
  it('skips build output and dependencies', () => {
    write('src/a.ts', lines(3));
    write('node_modules/pkg/index.js', lines(5000));
    write('target/debug/build.rs', lines(5000));
    write('.svelte-kit/output/x.js', lines(5000));
    write('dist/bundle.js', lines(5000));

    assert.deepEqual(collectSourceFiles(root), ['src/a.ts']);
  });
});

describe('nested checkouts', () => {
  /**
   * A scratch repository root, with `build` applied to it.
   *
   * @param {(dir: string) => void} build
   * @returns {string[]}
   */
  function collectIn(build) {
    const dir = mkdtempSync(join(tmpdir(), 'prick-loc-nested-'));
    try {
      build(dir);
      return collectSourceFiles(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('does not walk into a git worktree, whose .git is a FILE', () => {
    // The case that turned the gate red in practice: AGENTS.md recommends
    // `git worktree` for concurrent agents, and a worktree carries its own copy
    // of every generated file at a path GENERATED cannot match.
    const found = collectIn((dir) => {
      mkdirSync(join(dir, 'src'), { recursive: true });
      writeFileSync(join(dir, 'src', 'a.ts'), lines(3), 'utf8');

      const worktree = join(dir, '.claude', 'worktrees', 'other');
      mkdirSync(join(worktree, 'packages', 'app'), { recursive: true });
      writeFileSync(join(worktree, '.git'), 'gitdir: /elsewhere/.git/worktrees/other\n', 'utf8');
      writeFileSync(
        join(worktree, 'packages', 'app', 'worker-configuration.d.ts'),
        lines(16077),
        'utf8',
      );
    });

    assert.deepEqual(found, ['src/a.ts']);
  });

  it('does not walk into a nested clone, whose .git is a DIRECTORY', () => {
    const found = collectIn((dir) => {
      mkdirSync(join(dir, 'src'), { recursive: true });
      writeFileSync(join(dir, 'src', 'a.ts'), lines(3), 'utf8');

      const clone = join(dir, 'vendor', 'thing');
      mkdirSync(join(clone, '.git'), { recursive: true });
      writeFileSync(join(clone, 'huge.ts'), lines(5000), 'utf8');
    });

    assert.deepEqual(found, ['src/a.ts']);
  });

  it('still checks the root when the root itself is a worktree', () => {
    // Running the gate from inside a worktree must check that worktree, or the
    // fix would exempt exactly the tree the operator is working in.
    const found = collectIn((dir) => {
      writeFileSync(join(dir, '.git'), 'gitdir: /elsewhere/.git/worktrees/mine\n', 'utf8');
      mkdirSync(join(dir, 'src'), { recursive: true });
      writeFileSync(join(dir, 'src', 'a.ts'), lines(3), 'utf8');
    });

    assert.deepEqual(found, ['src/a.ts']);
  });
});

describe('violations', () => {
  it('reports nothing when everything is within the limit', () => {
    const dir = mkdtempSync(join(tmpdir(), 'prick-loc-ok-'));
    writeFileSync(join(dir, 'a.ts'), lines(MAX_LINES), 'utf8');
    try {
      assert.deepEqual(findViolations(dir), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is exclusive: exactly the limit passes, one more fails', () => {
    const dir = mkdtempSync(join(tmpdir(), 'prick-loc-edge-'));
    writeFileSync(join(dir, 'ok.ts'), lines(10), 'utf8');
    writeFileSync(join(dir, 'over.ts'), lines(11), 'utf8');
    try {
      const found = findViolations(dir, 10);
      assert.deepEqual(
        found.map((f) => f.path),
        ['over.ts'],
      );
      assert.equal(found[0].lines, 11);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('sorts worst first, so the report leads with the file to split', () => {
    const dir = mkdtempSync(join(tmpdir(), 'prick-loc-sort-'));
    writeFileSync(join(dir, 'small.ts'), lines(12), 'utf8');
    writeFileSync(join(dir, 'huge.ts'), lines(40), 'utf8');
    writeFileSync(join(dir, 'mid.ts'), lines(20), 'utf8');
    try {
      assert.deepEqual(
        findViolations(dir, 10).map((f) => f.path),
        ['huge.ts', 'mid.ts', 'small.ts'],
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('report', () => {
  it('names each file and how far over it is', () => {
    const text = formatReport([{ path: 'a/b.ts', lines: 1275 }], 1000).join('\n');
    assert.match(text, /a\/b\.ts/);
    assert.match(text, /1275/);
    assert.match(text, /\+275/);
  });

  it('says so plainly when clean', () => {
    assert.match(formatReport([], 1000).join('\n'), /within 1000 lines/);
  });
});

describe('cli', () => {
  it('exits 0 and reports to stdout when clean', () => {
    const dir = mkdtempSync(join(tmpdir(), 'prick-loc-cli-ok-'));
    writeFileSync(join(dir, 'a.ts'), lines(3), 'utf8');
    const out = [];
    const err = [];
    try {
      const code = main([], { root: dir, log: (l) => out.push(l), logErr: (l) => err.push(l) });
      assert.equal(code, 0);
      assert.equal(err.length, 0, 'a passing check must not write to stderr');
      assert.match(out.join('\n'), /within/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('exits 1 and reports to STDERR when over', () => {
    const dir = mkdtempSync(join(tmpdir(), 'prick-loc-cli-bad-'));
    writeFileSync(join(dir, 'big.ts'), lines(50), 'utf8');
    const out = [];
    const err = [];
    try {
      const code = main(['--max=10'], {
        root: dir,
        log: (l) => out.push(l),
        logErr: (l) => err.push(l),
      });
      assert.equal(code, 1);
      assert.equal(out.length, 0, 'the failure belongs on stderr, not stdout');
      assert.match(err.join('\n'), /big\.ts/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects a nonsense --max rather than silently passing everything', () => {
    const err = [];
    assert.equal(main(['--max=0'], { root, logErr: (l) => err.push(l) }), 2);
    assert.equal(main(['--max=abc'], { root, logErr: (l) => err.push(l) }), 2);
  });
});
