'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const { parse } = require('yaml');

const action = parse(fs.readFileSync(path.join(__dirname, '../action.yml'), 'utf8'));
const policy = action.runs.steps.find(step => step.id === 'qemu-policy');

for (const scenario of [
  { name: 'relative prefix', prefix: 'local-qemu' },
  { name: 'relative prefix with spaces', prefix: 'local qemu' },
  { name: 'relative prefix with dot segments', prefix: './build/../local-qemu/' },
  { name: 'absolute prefix', prefix: '/opt/qemu/' },
]) {
  test(`${scenario.name} is normalized once against the workspace`, () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'qemu-prefix-test-'));
    try {
      const workspace = path.join(temporary, 'workspace');
      const source = path.join(workspace, 'qemu-11.1.3');
      fs.mkdirSync(source, { recursive: true });
      const compute = action.runs.steps.find(step => step.id === 'vars');
      const output = path.join(temporary, 'output');
      const run = prefix => {
        fs.writeFileSync(output, '');
        const result = spawnSync('bash', ['-c', compute.run.replace('${{ runner.os }}', 'Linux')], {
          cwd: source,
          encoding: 'utf8',
          env: {
            ...process.env,
            GITHUB_WORKSPACE: workspace,
            GITHUB_OUTPUT: output,
            INSTALL_PREFIX_BASE: prefix,
            QEMU_VERSION: '11.1.3',
            QEMU_TARGETS: 'x86_64-softmmu',
            CONFIGURE_ARGS: '',
            EXTRA_BUILD_DEPS: '',
          },
        });
        assert.equal(result.status, 0, result.stderr);
        return Object.fromEntries(fs.readFileSync(output, 'utf8').trimEnd().split('\n').map(line => {
          const separator = line.indexOf('=');
          return [line.slice(0, separator), line.slice(separator + 1)];
        }));
      };
      const expectedBase = path.resolve(workspace, scenario.prefix);
      const outputs = run(scenario.prefix);
      assert.equal(outputs['install-base'], expectedBase);
      assert.equal(outputs['install-prefix'], path.join(expectedBase, '11.1.3'));
      assert.equal(outputs['bin-path'], path.join(expectedBase, '11.1.3/bin'));
      assert.equal(outputs['cache-key'], run(expectedBase)['cache-key']);
      const prepare = action.runs.steps.find(step => step.name === 'Prepare QEMU install base');
      assert.equal(prepare.env.INSTALL_PREFIX_BASE, '${{ steps.vars.outputs.install-base }}');
      const build = action.runs.steps.find(step => step.name === 'Build and install QEMU and cleanup QEMU sources.');
      assert.equal(build.env.INSTALL_PREFIX, '${{ steps.vars.outputs.install-prefix }}');
    } finally {
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  });
}

for (const scenario of [
  { name: 'exact versions are kept', versions: ['11.1.3', '11.1.3'], keep: true },
  { name: 'newer versions are kept', versions: ['99.0.0', '99.0.0'], keep: true },
  { name: 'forced downgrade handles unowned binaries', versions: ['99.0.0', '99.0.0'], downgrade: 'true', keep: false },
  { name: 'missing second target selects a build', versions: ['11.1.3', null], keep: false },
  { name: 'older second target selects a build', versions: ['11.1.3', '1.0.0'], keep: false },
  { name: 'unrecognized second target selects a build', versions: ['11.1.3', 'unknown'], keep: false },
  { name: 'no installed targets selects a build', versions: [null, null], keep: false },
  { name: 'cache hit selects the cached build', versions: [null, null], cache: 'true', keep: false },
]) {
  test(scenario.name, () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'qemu-policy-test-'));
    try {
      const bin = path.join(temporary, 'bin');
      fs.mkdirSync(bin);
      const targets = ['review_aarch64', 'review_x86_64'];
      targets.forEach((target, index) => {
        if (scenario.versions[index] === null) return;
        fs.writeFileSync(path.join(bin, `qemu-system-${target}`),
          `#!/bin/sh\necho 'QEMU emulator version ${scenario.versions[index]}'\n`, { mode: 0o755 });
      });
      const output = path.join(temporary, 'output');
      const result = spawnSync('bash', ['-c', `
        dpkg() {
          if [[ "$1" == '-S' || "$1" == '-s' ]]; then return 1; fi
          command dpkg "$@"
        }
        sudo() { echo 'Unexpected privileged command' >&2; return 90; }
        ${policy.run}
      `], {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          CACHE_HIT: scenario.cache || '',
          QEMU_TARGETS: targets.map(target => `${target}-softmmu`).join(','),
          QEMU_VERSION: '11.1.3',
          ALLOW_DOWNGRADE: scenario.downgrade || 'false',
          BUILT_INSTALL_PREFIX: '/opt/qemu/11.1.3',
          BUILT_BIN_PATH: '/opt/qemu/11.1.3/bin',
          GITHUB_OUTPUT: output,
        },
      });
      assert.equal(result.status, 0, result.stderr + result.stdout);
      const outputs = Object.fromEntries(fs.readFileSync(output, 'utf8').trimEnd().split('\n').map(line => {
        const separator = line.indexOf('=');
        return [line.slice(0, separator), line.slice(separator + 1)];
      }));
      assert.equal(outputs['use-system'], String(scenario.keep));
      assert.equal(outputs['install-prefix'], scenario.keep ? '' : '/opt/qemu/11.1.3');
      assert.equal(outputs['bin-path'], scenario.keep ? bin : '/opt/qemu/11.1.3/bin');
    } finally {
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  });
}

test('source build leaves qemu-utils installed when no requested binary owns it', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'qemu-utils-policy-test-'));
  try {
    const output = path.join(temporary, 'output');
    const result = spawnSync('bash', ['-c', `
      dpkg() {
        if [[ "$1" == '-S' ]]; then return 1; fi
        if [[ "$1" == '-s' && "$2" == 'qemu-utils' ]]; then return 0; fi
        command dpkg "$@"
      }
      sudo() { printf 'sudo %s\\n' "$*"; }
      ${policy.run}
    `], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${temporary}:${process.env.PATH}`,
        CACHE_HIT: '',
        QEMU_TARGETS: 'review_missing-softmmu',
        QEMU_VERSION: '11.1.3',
        ALLOW_DOWNGRADE: 'false',
        BUILT_INSTALL_PREFIX: '/opt/qemu/11.1.3',
        BUILT_BIN_PATH: '/opt/qemu/11.1.3/bin',
        GITHUB_OUTPUT: output,
      },
    });
    assert.equal(result.status, 0, result.stderr + result.stdout);
    assert.doesNotMatch(result.stdout, /sudo apt-get remove/);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test('KVM helper resolves from the action outside the caller workspace', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'qemu-consumer-test-'));
  try {
    const workspace = path.join(temporary, 'consumer');
    fs.mkdirSync(workspace);
    const locate = action.runs.steps.find(step => step.name === 'Locate KVM access helper');
    const enable = action.runs.steps.find(step => step.name === 'Enable KVM access');
    assert.equal(locate.env.KVM_ACTION_PATH, '${{ github.action_path }}/kvm-access');
    const helperSource = path.resolve(__dirname, '../kvm-access');
    const run = () => spawnSync('bash', ['-c', locate.run], {
      cwd: workspace,
      env: { ...process.env, GITHUB_WORKSPACE: workspace, KVM_ACTION_PATH: helperSource },
      encoding: 'utf8',
    });
    assert.equal(run().status, 0);
    assert.equal(run().status, 0);
    const helperPath = path.resolve(workspace, enable.uses);
    assert.equal(fs.realpathSync(helperPath), helperSource);
    const helper = parse(fs.readFileSync(path.join(helperPath, 'action.yml'), 'utf8'));
    assert(fs.existsSync(path.join(helperPath, helper.runs.main)));
    assert(fs.existsSync(path.join(helperPath, helper.runs.post)));
    fs.unlinkSync(helperPath);
    fs.mkdirSync(helperPath);
    const conflict = run();
    assert.notEqual(conflict.status, 0);
    assert.match(conflict.stderr, /not owned by this action/);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test('workflow isolates caches across jobs and attempts but reuses the cache within a job', () => {
  const workflow = parse(fs.readFileSync(path.join(__dirname, '../../.github/workflows/test-setup-qemu-latest.yml'), 'utf8'));
  const cacheSteps = workflow.jobs['cache-miss-then-hit'].steps;
  const first = cacheSteps.find(step => step.id === 'setup-qemu-1');
  const second = cacheSteps.find(step => step.id === 'setup-qemu-2');
  assert.equal(first.with['configure-args'], second.with['configure-args']);
  const removal = cacheSteps.findIndex(step => step.name === 'Remove installation before cache restore');
  assert(removal > cacheSteps.indexOf(first));
  assert(removal < cacheSteps.indexOf(second));
  const render = (configuration, attempt) => configuration
    .replace('${{ github.run_id }}', '123')
    .replace('${{ github.run_attempt }}', String(attempt));
  const configuration = first.with['configure-args'];
  assert(configuration.includes('${{ github.run_id }}'));
  assert(configuration.includes('${{ github.run_attempt }}'));
  assert(configuration.includes('_CACHE'));
  assert.notEqual(render(configuration, 1), render(configuration, 2));
  const downgrade = workflow.jobs['allow-downgrade-rebuilds'].steps.find(step => step.id === 'setup-qemu');
  assert.notEqual(render(configuration, 1), render(downgrade.with['configure-args'], 1));
  const configurations = [];
  for (const [job, definition] of Object.entries(workflow.jobs)) {
    const setup = definition.steps.find(step => step.id === 'setup-qemu' || step.id === 'setup-qemu-1');
    if (!setup?.with['configure-args']) continue;
    const rendered = render(setup.with['configure-args'], 1).trim();
    assert.match(rendered, /^--extra-cflags=-D[A-Za-z_][A-Za-z0-9_]*$/);
    configurations.push([job, rendered]);
  }
  assert.equal(new Set(configurations.map(([, value]) => value)).size, configurations.length);
  const buildSteps = workflow.jobs['build-from-source'].steps;
  assert.equal(buildSteps[0].with.path, 'action-source');
  assert.equal(buildSteps[1].uses, './action-source/setup-qemu-latest');
  assert.equal(buildSteps[1].with['enable-kvm-access'], 'true');
});
