// *******************************************************************************
// Copyright (c) 2026 Contributors to the Eclipse Foundation
//
// See the NOTICE file(s) distributed with this work for additional
// information regarding copyright ownership.
//
// This program and the accompanying materials are made available under the
// terms of the Apache License Version 2.0 which is available at
// https://www.apache.org/licenses/LICENSE-2.0
//
// SPDX-License-Identifier: Apache-2.0
// *******************************************************************************

'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const { KVM_DEVICE, hasCommand } = require('./common');

function main() {
  if (!fs.existsSync(KVM_DEVICE)) {
    console.log(`${KVM_DEVICE} not present; skipping KVM ACL setup.`);
    return;
  }

  if (!hasCommand('setfacl')) {
    console.log('setfacl not found; installing the "acl" package.');
    execFileSync('sudo', ['apt-get', 'update'], { stdio: 'inherit' });
    execFileSync('sudo', ['apt-get', 'install', '-y', 'acl'], { stdio: 'inherit' });
  }

  const user = os.userInfo().username;
  // Scope access to the current job's user instead of world-writable (0666).
  execFileSync('sudo', ['setfacl', '-m', `u:${user}:rw`, KVM_DEVICE], { stdio: 'inherit' });
  console.log(`Granted ${user} rw ACL access to ${KVM_DEVICE}.`);
}

main();
