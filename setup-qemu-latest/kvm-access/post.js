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
  if (!fs.existsSync(KVM_DEVICE) || !hasCommand('setfacl')) {
    return;
  }

  const user = os.userInfo().username;
  try {
    execFileSync('sudo', ['setfacl', '-x', `u:${user}`, KVM_DEVICE], { stdio: 'inherit' });
    console.log(`Revoked ${user}'s ACL access to ${KVM_DEVICE}.`);
  } catch (error) {
    console.log(`::warning::Failed to revoke KVM ACL access for ${user}: ${error.message}`);
  }
}

main();
