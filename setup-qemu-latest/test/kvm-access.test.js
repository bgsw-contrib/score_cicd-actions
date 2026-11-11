'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

function runHelper(file, options = {}) {
  const commands = [];
  const states = [];
  const logs = [];
  let failure;
  const context = {
    Buffer,
    process: { env: options.env || { GITHUB_STATE: '/state' } },
    console: { log: message => logs.push(message) },
    require(name) {
      if (name === 'child_process') return {
        execFileSync(command, args, settings) {
          commands.push({ command, args: Array.from(args), settings });
          if (command === 'getfacl') return options.acl;
          if (options.failGrant && args.includes('-m')) throw new Error('grant failed');
          if (options.failRestore && args.includes('--restore=-')) throw new Error('restore failed');
        },
      };
      if (name === 'fs') return {
        existsSync: () => options.deviceExists !== false,
        appendFileSync: (destination, content) => states.push({ destination, content }),
      };
      if (name === 'os') return { userInfo: () => ({ username: 'runner' }) };
      if (name === './common') return { KVM_DEVICE: '/dev/kvm', hasCommand: () => options.hasAcl !== false };
      throw new Error(`Unexpected dependency: ${name}`);
    },
  };
  try {
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../kvm-access', file), 'utf8'), context);
  } catch (error) {
    failure = error;
  }
  return { commands, states, logs, failure };
}

for (const existingUser of ['', 'user:runner:r--\n', 'user:runner:rw-\n']) {
  test(`KVM cleanup restores the original ACL, including mask and user ${JSON.stringify(existingUser)}`, () => {
    const acl = `# file: /dev/kvm\n# owner: root\n# group: kvm\nuser::rw-\n${existingUser}group::rw-\nmask::r--\nother::---\n`;
    const main = runHelper('main.js', { acl });
    assert.equal(main.failure, undefined);
    assert.equal(main.states.length, 1);
    assert.equal(main.states[0].destination, '/state');
    const encoded = main.states[0].content.trim().slice('original-acl='.length);
    assert.equal(Buffer.from(encoded, 'base64').toString(), acl);
    assert.deepEqual(main.commands.at(-1).args, ['setfacl', '-m', 'u:runner:rw', '/dev/kvm']);
    const post = runHelper('post.js', { env: { 'STATE_original-acl': encoded } });
    assert.equal(post.failure, undefined);
    assert.deepEqual(post.commands[0].args, ['setfacl', '--restore=-']);
    assert.equal(post.commands[0].settings.input, acl);
  });
}

test('KVM setup with no device records no state and cleanup does nothing', () => {
  const main = runHelper('main.js', { deviceExists: false });
  assert.equal(main.commands.length, 0);
  assert.equal(main.states.length, 0);
  assert.equal(runHelper('post.js', { env: {} }).commands.length, 0);
});

test('KVM saves the original ACL before a grant failure', () => {
  const main = runHelper('main.js', { acl: 'original ACL', failGrant: true });
  assert.match(main.failure.message, /grant failed/);
  assert.equal(main.states.length, 1);
});

test('KVM installs ACL tools before reading the original ACL', () => {
  const main = runHelper('main.js', { acl: 'original ACL', hasAcl: false });
  assert.equal(main.failure, undefined);
  assert.deepEqual(main.commands[0].args, ['apt-get', 'update']);
  assert.deepEqual(main.commands[1].args, ['apt-get', 'install', '-y', 'acl']);
  assert.equal(main.commands[2].command, 'getfacl');
});

test('KVM cleanup reports a restore failure', () => {
  const post = runHelper('post.js', {
    env: { 'STATE_original-acl': Buffer.from('original ACL').toString('base64') },
    failRestore: true,
  });
  assert.equal(post.failure, undefined);
  assert.match(post.logs[0], /::warning::Failed to restore/);
});
